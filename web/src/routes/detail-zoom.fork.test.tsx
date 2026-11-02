import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PANE_ROUTE_ID, ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath, zoomPath } from "@/lib/nav";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { DetailRoute } from "./detail";

// FORK — THE ZOOM DOOR IS IN THE ⋮ (the 1.25 merge, 2026-11-02). Upstream 1.25.0 opens the zoomed
// output from an icon pill in the belt's pinned block; this install draws no pinned block
// (FORK_BELT_PINS_ON, lib/belt-pins.ts), so the door is a "Zoom output" row in the pane menu's View
// group. Upstream's own route cases stay in detail-zoom.test.tsx, with the pill.

vi.mock("@/lib/belt-pins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/belt-pins")>()),
  FORK_BELT_PINS_ON: false,
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const agent = fixtureAgents[0]!;

const home = (): HomeData => ({
  bridge: "connected",
  agents: fixtureAgents,
  shellPanes: [],
  workspaces: [],
  tabs: [],
  device: undefined,
  sessions: [],
  servers: [],
  ts: 0,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
});

function makeRouter() {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: home,
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div>HOME</div> },
          {
            id: PANE_ROUTE_ID,
            path: "pane/:paneId",
            loader: ({ params }): PaneData => ({
              paneId: params.paneId ?? "",
              scope: {},
              text: paneTextWithDraft("recent pane output"),
              truncated: false,
              requestedLines: 600,
              revision: 0,
              error: false,
              authError: false,
            }),
            element: <DetailRoute />,
            children: [{ path: "zoom", element: null }],
          },
        ],
      },
    ],
    { initialEntries: ["/", panePath(agent.paneId)], initialIndex: 1 },
  );
}

describe("the pane's output, zoomed, from the fork's pane menu", () => {
  it("draws no Zoom pill on the belt, and the ⋮'s Zoom output row opens /pane/:id/zoom", async () => {
    const user = userEvent.setup();
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    const menu = await screen.findByRole("button", { name: "Pane actions" });
    expect(screen.queryByRole("button", { name: "Zoom output" })).toBeNull();

    await user.click(menu);
    const view = await screen.findByRole("group", { name: "View" });
    await user.click(within(view).getByRole("button", { name: "Zoom output" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(zoomPath(agent.paneId)));
    const dialog = await screen.findByRole("dialog", { name: "Zoomed output" });
    expect(dialog).toHaveTextContent("recent pane output");

    // The ✕ steps back onto the pane, as from upstream's pill.
    await user.click(within(dialog).getByRole("button", { name: "Back to the pane" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath(agent.paneId)));
    expect(screen.queryByRole("dialog", { name: "Zoomed output" })).toBeNull();
  });
});
