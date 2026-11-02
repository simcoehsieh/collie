import { render, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { useWidthClass } from "@/hooks/use-width-class";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import type { AgentView } from "@/lib/types";
import { __resetWideLayoutStore, setWideLayoutMode, wideLayoutMode } from "@/lib/wide-layout-store";
import { DetailRoute } from "@/routes/detail";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

// FORK — NO LARGE-SCREEN LAYOUT (the 1.25 merge, 2026-11-02; lib/fork-shape.ts FORK_WIDE_LAYOUT_ON).
// Upstream 1.24.0 turns the pane screen into a sidebar beside a strip of panes on any window at least
// 600 by 480, which is every desktop browser that opens Meow. Off here: the mode reads "off" whatever
// the device stored, so a 1280 by 800 window gets the phone's pane screen. Upstream's own cases stay
// in wide-layout.test.tsx, with the layout.

vi.mock("@/lib/fork-shape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork-shape")>()),
  FORK_WIDE_LAYOUT_ON: false,
}));
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId, inStrip }: { paneId: string; inStrip?: boolean }) => (
    <div data-testid="chat" data-in-strip={String(inStrip === true)}>{`pane:${paneId}`}</div>
  ),
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

const A1: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "alpha",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  paneLabel: "w1:p1",
  status: "idle",
  cwd: "/home/me/proj",
  focused: false,
  kind: "agent",
};

const home = (): HomeData => ({
  bridge: "connected",
  agents: [A1],
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

function makeRouter(paneId: string) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: home,
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div data-testid="home">HOME</div> },
          {
            path: "pane/:paneId",
            loader: ({ params }): PaneData => ({
              paneId: params.paneId ?? "",
              scope: {},
              text: "",
              truncated: false,
              requestedLines: 600,
              revision: 0,
              error: false,
              authError: false,
            }),
            element: <DetailRoute />,
          },
        ],
      },
    ],
    { initialEntries: [panePath(paneId)] },
  );
}

// A 1280 by 800 window: every width-class query matches.
function answer(query: string): boolean {
  if (query.includes("viewport-segments")) return false;
  const minW = /min-width:\s*(\d+)px/.exec(query);
  const minH = /min-height:\s*(\d+)px/.exec(query);
  return minW !== null && 1280 >= Number(minW[1]) && (minH === null || 800 >= Number(minH[1]));
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  __resetWideLayoutStore();
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
      ({
        matches: answer(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  server.use(http.get("/api/pane/:id", () => HttpResponse.json({ text: "rows", truncated: false, revision: 1 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
});

describe("FORK: the large-screen layout is off", () => {
  it("reads the mode as off whatever the device stored", () => {
    setWideLayoutMode("auto");
    expect(wideLayoutMode()).toBe("off");
    localStorage.setItem("collie:wide-layout-mode:v1", "auto");
    expect(wideLayoutMode()).toBe("off");
  });

  it("keeps the compact width class on a 1280 by 800 window", () => {
    const { result } = renderHook(() => useWidthClass());
    expect(result.current).toBe("compact");
  });

  it("draws the phone's pane screen on a 1280 by 800 window: no sidebar, no strip", async () => {
    const { container } = render(<RouterProvider router={makeRouter("w1:p1")} />);
    await waitFor(() => expect(container.querySelector('[data-testid="chat"]')).not.toBeNull());
    expect(container.querySelector('[data-slot="wide-layout"]')).toBeNull();
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-testid="chat"]')?.dataset.inStrip).toBe("false");
  });
});
