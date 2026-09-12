import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { ArtifactsRoute, __resetArtifactViews } from "./artifacts";

// The library route (routes/artifacts.tsx): newest version of each artifact, pinned first, a search
// that reads title / slug / tags / pane, and the two empty states.

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

function renderRoute() {
  const data = homeData();
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
            <ArtifactsRoute />
          </CrewProvider>,
        ),
        children: [
          { path: "artifacts", element: null },
          { path: "artifacts/:id", element: <div>VIEWER</div> },
        ],
      },
    ],
    { initialEntries: ["/artifacts"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => { __resetArtifacts(); __resetArtifactViews(); });
afterEach(() => __resetArtifacts());

describe("ArtifactsRoute", () => {
  it("lists the newest version of each artifact, pinned ones first, and opens one", async () => {
    server.use(
      http.get("/api/artifacts", () =>
        HttpResponse.json({
          ok: true,
          artifacts: [
            fixtureArtifact({ id: "n2-00000002", slug: "notes", title: "Notes v2", version: 2, kind: "markdown" }),
            fixtureArtifact({ id: "q1-00000001", slug: "q3-report", title: "Q3 report", pinned: true }),
            fixtureArtifact({ id: "n1-00000001", slug: "notes", title: "Notes", version: 1, kind: "markdown" }),
          ],
        }),
      ),
    );
    const router = renderRoute();
    const rows = await screen.findAllByRole("button", { name: /^Open / });
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Open Q3 report", "Open Notes v2"]);
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    await userEvent.setup().click(rows[1]!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/artifacts/n2-00000002"));
  });

  it("searches by title, tag and pane, and says when nothing matches", async () => {
    server.use(
      http.get("/api/artifacts", () =>
        HttpResponse.json({
          ok: true,
          artifacts: [
            fixtureArtifact({ id: "q1-00000001", title: "Q3 report", tags: ["finance"] }),
            fixtureArtifact({ id: "s1-00000001", slug: "shot", title: "Screenshot", kind: "image", tags: [], pane: null, origin: "scheduler" }),
          ],
        }),
      ),
    );
    renderRoute();
    await screen.findByRole("button", { name: "Open Screenshot" });
    const user = userEvent.setup();
    const search = screen.getByRole("searchbox", { name: "Search artifacts" });
    await user.type(search, "finance");
    expect(screen.queryByRole("button", { name: "Open Screenshot" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Q3 report" })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "scheduler");
    expect(screen.getByRole("button", { name: "Open Screenshot" })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("an empty library says how to fill it; a failed read says it failed", async () => {
    renderRoute();
    expect(await screen.findByText("Nothing made yet")).toBeInTheDocument();
    expect(screen.getByText(/collie artifact add/)).toBeInTheDocument();
    __resetArtifacts();
    server.use(http.get("/api/artifacts", () => new HttpResponse("nope", { status: 503 })));
    renderRoute();
    expect(await screen.findAllByText("Couldn't read the library.")).not.toHaveLength(0);
  });
});


it("bounds the rendered list, searches all items, and remembers filters after leaving", async () => {
  server.use(http.get("/api/artifacts", () => HttpResponse.json({
    ok: true,
    artifacts: Array.from({ length: 125 }, (_, i) => fixtureArtifact({
      id: `item-${i}`, slug: `item-${i}`, title: `Report ${i}`, kind: i === 124 ? "image" : "html", pinned: i === 124,
    })),
  })));
  renderRoute();
  await waitFor(() => expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(40));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Show more" }));
  expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(80);
  await user.type(screen.getByRole("searchbox"), "Report 123");
  expect(screen.getByRole("button", { name: "Open Report 123" })).toBeInTheDocument();
  await user.clear(screen.getByRole("searchbox"));
  await user.click(screen.getByRole("button", { name: "image" }));
  await user.click(screen.getByRole("button", { name: "Pinned only" }));
  expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Open Report 124" })).toBeInTheDocument();
  cleanup();
  renderRoute();
  await screen.findByRole("button", { name: "Open Report 124" });
  expect(screen.getByRole("button", { name: "Pinned only" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "image" })).toHaveAttribute("aria-current", "true");
});

it("keeps cached cards during a failed refresh, explains staleness, and lets the reader retry", async () => {
  server.use(http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: [fixtureArtifact()] })));
  renderRoute();
  await screen.findByRole("button", { name: "Open Q3 report" });
  const user = userEvent.setup();
  server.use(http.get("/api/artifacts", () => new HttpResponse("nope", { status: 503 })));
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByText("Showing the last saved list. Reload to try again.");
  expect(screen.getByRole("button", { name: "Open Q3 report" })).toBeInTheDocument();
  server.use(http.get("/api/artifacts", () => HttpResponse.json({ ok: true, artifacts: [fixtureArtifact({ title: "Recovered" })] })));
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByRole("button", { name: "Open Recovered" });
});
