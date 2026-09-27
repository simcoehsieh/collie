// FORK: the dashboard has no Panes / Focus / Changes footer (lib/dash-tabs.ts). Upstream's tests in
// home.test.tsx run WITH the bar, because the gate is on under vitest; this file turns it off the
// way the production bundle has it, and pins what the operator sees.

import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetDashPrefs } from "@/hooks/use-dash-prefs";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import {
  fixtureAgents,
  fixtureSessions,
  fixtureShellPanes,
  fixtureTabs,
  fixtureWorkspaces,
} from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { HomeRoute } from "./home";

vi.mock("@/lib/dash-tabs", () => ({ FORK_DASH_TABS_ON: false, FORK_HEADING_NEW_TAB_ON: false }));
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
