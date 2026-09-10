import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetDashPrefs, setPinned } from "@/hooks/use-dash-prefs";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetTails } from "@/lib/overview";
import { fixtureAgents, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { OverviewRoute } from "./overview";

// FORK: every agent on one screen, each with the last lines of its mirror.

const homeData = (agents = fixtureAgents): HomeData => ({
  bridge: "connected",
  device: undefined,
  agents,
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

function renderOverview(data: HomeData) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
            <OverviewRoute />
          </CrewProvider>,
        ),
        children: [
          { path: "overview", element: null },
          { path: "pane/:paneId", element: <div>PANE</div> },
        ],
      },
    ],
    { initialEntries: ["/overview"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  localStorage.clear();
  __resetDashPrefs();
  server.use(
    http.get("/api/pane/:paneId", ({ params }) =>
      HttpResponse.json({
        paneId: params.paneId,
        text: `tail of ${String(params.paneId)}\nlast line`,
        truncated: false,
        revision: 1,
      }),
    ),
  );
});
afterEach(() => __resetTails());

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="overview-card"]')];

describe("OverviewRoute", () => {
  it("draws one card per agent with its tail, in the dashboard's order, pins first", async () => {
    const pinnedId = fixtureAgents[fixtureAgents.length - 1]!.paneId;
    setPinned(pinnedId, true);
    renderOverview(homeData());
    await waitFor(() => expect(cards().length).toBe(fixtureAgents.length));
    await waitFor(() =>
      expect(screen.getByText(new RegExp(`tail of ${pinnedId}`))).toBeInTheDocument(),
    );
    expect(cards()[0]!.getAttribute("data-pane-row")).toBe(pinnedId);
  });

  it("a tap opens the pane", async () => {
    const user = userEvent.setup();
    const router = renderOverview(homeData());
    await waitFor(() => expect(cards().length).toBe(fixtureAgents.length));
    const target = fixtureAgents[0]!.paneId;
    await user.click(cards().find((c) => c.getAttribute("data-pane-row") === target)!);
    expect(router.state.location.pathname).toBe(`/pane/${encodeURIComponent(target)}`);
  });

  it("an empty herd says so rather than drawing an empty grid", async () => {
    renderOverview(homeData([]));
    expect(await screen.findByText("No agents running.")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="overview-grid"]')).toBeNull();
  });
});
