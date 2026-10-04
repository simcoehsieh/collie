// FORK: the dashboard has no Panes / Focus / Changes footer (lib/dash-tabs.ts). Upstream's tests in
// home.test.tsx run WITH the bar, because the gate is on under vitest; this file turns it off the
// way the production bundle has it, and pins what the operator sees.

import { cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetDashPrefs } from "@/hooks/use-dash-prefs";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";
import {
  fixtureAgents,
  fixtureSessions,
  fixtureShellPanes,
  fixtureTabs,
  fixtureWorkspaces,
} from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { HomeRoute } from "./home";

vi.mock("@/lib/dash-tabs", () => ({
  FORK_DASH_TABS_ON: false,
  FORK_HEADING_NEW_TAB_ON: false,
  FORK_DASH_SHELLS_ON: false,
}));
vi.mock("@/hooks/use-loading-stalled", () => ({
  useLoadingStalled: () => false,
}));

const data: HomeData = {
  bridge: "connected",
  device: undefined,
  agents: fixtureAgents,
  shellPanes: fixtureShellPanes,
  workspaces: fixtureWorkspaces,
  tabs: fixtureTabs,
  sessions: fixtureSessions,
  servers: [],
  ts: 0,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
};

function renderHome() {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider
            servers={data.servers}
            sessions={data.sessions}
            ts={data.ts}
            pollMs={1500}
          >
            <HomeRoute />
          </CrewProvider>,
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

const settled = () => screen.findByRole("navigation", { name: /spaces/i });

describe("dashboard without the footer (fork)", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    __resetDashPrefs();
  });

  it("draws no Panes / Focus / Changes bar", async () => {
    renderHome();
    await settled();
    expect(
      screen.queryByRole("navigation", { name: "Dashboard views" }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "webapp" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "collie" })).toBeInTheDocument();
  });

  it("draws no \"+\" on a workspace heading (lib/dash-tabs.ts)", async () => {
    renderHome();
    await settled();
    expect(screen.getByRole("heading", { name: "webapp" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new tab/i })).toBeNull();
  });

  // A bare shell has nothing to watch: no row in the list, and a workspace holding only a shell has
  // no heading either. SPACES still lists it, so the shell is one tap away.
  it("draws no bare-shell row, and no heading for a workspace that only holds a shell (lib/dash-tabs.ts)", async () => {
    const survey: AgentView = {
      ...fixtureShellPanes[0]!,
      paneId: "w9:p1",
      workspaceId: "w9",
      workspaceLabel: "Survey",
      workspaceNumber: 9,
      tabId: "w9:t1",
    };
    data.shellPanes = [...fixtureShellPanes, survey];
    try {
      renderHome();
      await settled();
      const list = screen.getByRole("heading", { name: "webapp" }).closest("main")!;
      expect(within(list).queryByRole("heading", { name: "Survey" })).toBeNull();
      // "collie" keeps its heading for its agent, but not the shell row beside it.
      expect(within(list).getByRole("heading", { name: "collie" })).toBeInTheDocument();
      expect(within(list).queryByText(/^shell$/i)).toBeNull();
    } finally {
      data.shellPanes = fixtureShellPanes;
    }
  });

  // A device that picked Focus or Changes while the bar existed must not be stranded on that list
  // with nothing to tap back to Panes.
  it.each(["focus", "changes"])(
    "shows the whole Panes list even when %s was the stored view",
    async (stored) => {
      localStorage.setItem(
        "collie:dash-prefs:v1",
        JSON.stringify({ dashView: stored }),
      );
      __resetDashPrefs();
      renderHome();
      await settled();
      // Focus would drop "collie" (its only agent is working, not waiting on you).
      expect(
        screen.getByRole("heading", { name: "collie" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("list", { name: "Changes by workspace" }),
      ).toBeNull();
    },
  );
});
