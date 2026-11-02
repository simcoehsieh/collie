import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetDashPrefs, dashPrefs } from "@/hooks/use-dash-prefs";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { fixtureAgents, fixtureSessions, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { HomeRoute } from "./home";

// FORK — THE CHIP STRIP ON UPSTREAM'S FILTER STORE (the 1.25 merge, 2026-11-02). Upstream 1.24 turned
// the dashboard's one isolated workspace (`isolatedSpace`) into a chosen set (`isolatedSpaces`, issue
// #527) behind its multi-workspace filter sheet. This install keeps the 1.17.2 chip strip
// (FORK_DASH_SELECT_ON, lib/dash-tabs.ts), which now writes that set: a chip tap chooses its workspace
// alone, All empties the set, and a device that stored the old single key keeps its choice.

vi.mock("@/lib/dash-tabs", () => ({
  FORK_DASH_TABS_ON: false,
  FORK_HEADING_NEW_TAB_ON: false,
  FORK_DASH_SHELLS_ON: false,
  FORK_DASH_SUMMARY_CONTROLS_ON: false,
  FORK_DASH_NEW_FAB_ON: false,
  FORK_DASH_SELECT_ON: false,
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

const data: HomeData = {
  bridge: "connected",
  device: undefined,
  agents: fixtureAgents,
  shellPanes: [],
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
          <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
            <HomeRoute />
          </CrewProvider>,
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

const strip = () => screen.findByRole("navigation", { name: /spaces/i });
const headings = () => screen.queryAllByRole("heading").map((h) => h.textContent ?? "");

describe("FORK: the workspace chips write upstream's chosen set", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    __resetDashPrefs();
  });

  it("a chip tap shows that workspace alone, and All shows every workspace again", async () => {
    renderHome();
    const nav = await strip();
    fireEvent.click(within(nav).getByRole("button", { name: /webapp$/ }));
    expect(dashPrefs().isolatedSpaces).toHaveLength(1);
    expect(headings().some((h) => h.includes("webapp"))).toBe(true);
    expect(headings().some((h) => h.includes("collie"))).toBe(false);
    fireEvent.click(within(nav).getByRole("button", { name: /^All/ }));
    expect(dashPrefs().isolatedSpaces).toEqual([]);
    expect(headings().some((h) => h.includes("collie"))).toBe(true);
  });

  it("a second chip replaces the first: the strip chooses one workspace, never a set", async () => {
    renderHome();
    const nav = await strip();
    fireEvent.click(within(nav).getByRole("button", { name: /webapp$/ }));
    const first = dashPrefs().isolatedSpaces;
    fireEvent.click(within(nav).getByRole("button", { name: /collie$/ }));
    expect(dashPrefs().isolatedSpaces).toHaveLength(1);
    expect(dashPrefs().isolatedSpaces).not.toEqual(first);
  });
});
