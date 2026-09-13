import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetArtifacts } from "@/lib/artifacts";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { fixtureAgents, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { fixtureArtifact } from "@/test/artifacts";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { ArtifactRoute } from "./artifact";

// One artifact opened to read (routes/artifact.tsx): where it came from, its versions, the pin, the
// two-tap delete, and a deep link to an id the library snapshot never held.

const homeData = (): HomeData => ({
  bridge: "connected",
  device: undefined,
  agents: fixtureAgents,
  shellPanes: [],
  workspaces: fixtureWorkspaces,
  tabs: fixtureTabs,
  sessions: [],
  servers: [],
  ts: 1,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
});

function renderRoute(id: string) {
  const data = homeData();
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
            <ArtifactRoute />
          </CrewProvider>,
        ),
        children: [
          { path: "artifacts", element: null },
          { path: "artifacts/:id", element: null },
          { path: "pane/:paneId", element: <div>PANE</div> },
        ],
      },
    ],
    { initialEntries: [`/artifacts/${id}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const v1 = fixtureArtifact({ id: "q1-00000001", version: 1 });
const v2 = fixtureArtifact({ id: "q2-00000002", version: 2, title: "Q3 report v2", kind: "markdown", ext: "md" });

beforeEach(() => __resetArtifacts());
afterEach(() => __resetArtifacts());

describe("ArtifactRoute", () => {
  it("names the pane it came from, offers the versions, and frames a page sandboxed", async () => {
    server.use(http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: [v2, v1] })));
    const router = renderRoute("q1-00000001");
    expect(await screen.findByRole("heading", { name: "Q3 report" })).toBeInTheDocument();
    expect(screen.getByText("From webapp › claude")).toBeInTheDocument();
    const frame = screen.getByTitle("Q3 report");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("src")).toContain("/api/artifacts/q1-00000001/raw");
    const versions = screen.getByRole("group", { name: "Versions" });
    expect(versions).toHaveTextContent("v2");
    await userEvent.setup().click(screen.getByRole("button", { name: "v2", pressed: false }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/artifacts/q2-00000002"));
    // The pane link is a way back to the conversation.
    await userEvent.setup().click(screen.getByText("From webapp › claude"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w1%3Ap1"));
  });

  it("pins with one tap and deletes with two, refetching the library after each", async () => {
    let pinned = false;
    let deleted = false;
    server.use(
      http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: deleted ? [] : [{ ...v1, pinned }] })),
      http.patch("/api/artifacts/q1-00000001", async ({ request }) => {
        // SAFETY: this handler's own client sends `{ pinned: boolean }` (routes/artifact.tsx); the
        // assertion names the shape the test itself put on the wire.
        const body = (await request.json()) as { pinned?: boolean };
        pinned = body.pinned === true;
        return HttpResponse.json({ ok: true, artifact: { ...v1, pinned } });
      }),
      http.delete("/api/artifacts/q1-00000001", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const router = renderRoute("q1-00000001");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pin" }));
    expect(await screen.findByRole("button", { name: "Unpin" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleted).toBe(false);
    expect(screen.getByText(/Tap again to delete/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tap again to delete/ }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe("/artifacts"));
  });

  it("a deep link fetches the record by id; an unknown id says it is gone", async () => {
    server.use(
      http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: [] })),
      http.get("/api/artifacts/q1-00000001", () => HttpResponse.json({ ok: true, artifact: v1 })),
      http.get("/api/artifacts/zz-00000000", () => new HttpResponse("no such artifact", { status: 404 })),
    );
    renderRoute("q1-00000001");
    expect(await screen.findByRole("heading", { name: "Q3 report" })).toBeInTheDocument();
    __resetArtifacts();
    renderRoute("zz-00000000");
    expect(await screen.findByText("This artifact is gone.")).toBeInTheDocument();
  });
});
