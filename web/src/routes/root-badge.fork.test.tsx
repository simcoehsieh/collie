import { render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { fixtureAgents, fixtureSessions } from "@/test/handlers";
import { RootLayout } from "./root";

// FORK — THE ICON'S COUNT IS CORRECTED FROM EVERY SCREEN (the 1.25 merge, 2026-11-02). Upstream 1.25's
// worker sums each session's slot, and its open dashboard writes the count (routes/home.tsx). Apple's
// endpoints get no retraction here (bridge/push.ts), so a pane read on the pane screen lowers the icon
// only when a page writes it: RootLayout does, on every route, on upstream's terms (the alerts out, and
// only while the page holds the whole herd).

const setAppBadge = vi.fn(async () => undefined);
const clearAppBadge = vi.fn(async () => undefined);
beforeEach(() => {
  setAppBadge.mockClear();
  clearAppBadge.mockClear();
  Object.defineProperty(navigator, "setAppBadge", { value: setAppBadge, configurable: true });
  Object.defineProperty(navigator, "clearAppBadge", { value: clearAppBadge, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "setAppBadge");
  Reflect.deleteProperty(navigator, "clearAppBadge");
});

const home = (over: Partial<HomeData>): HomeData => ({
  bridge: "connected",
  device: undefined,
  agents: fixtureAgents,
  shellPanes: [],
  workspaces: [],
  tabs: [],
  sessions: fixtureSessions.slice(0, 1),
  servers: [],
  ts: 0,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
  ...over,
});

function mountAt(path: string, data: HomeData) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: <RootLayout />,
        children: [
          { index: true, element: <div>HOME</div> },
          { path: "elsewhere", element: <div data-testid="elsewhere">ELSEWHERE</div> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe("FORK: RootLayout writes the icon's count", () => {
  // fixtureAgents holds one blocked pane, and the default prefs notify for blocked ones.
  it("writes it on a route that is not the dashboard, on a single-session machine", async () => {
    const { findByTestId } = mountAt("/elsewhere", home({}));
    await findByTestId("elsewhere");
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1));
  });

  it("clears it when nothing has an alert out", async () => {
    mountAt("/elsewhere", home({ agents: fixtureAgents.filter((a) => a.status !== "blocked" && a.status !== "done") }));
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
  });

  it("writes nothing on one session of several, leaving the worker's sum standing", async () => {
    const { findByTestId } = mountAt("/elsewhere", home({ sessions: fixtureSessions }));
    await findByTestId("elsewhere");
    await new Promise((r) => setTimeout(r, 100));
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });
});
