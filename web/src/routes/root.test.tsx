import { act, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { BootSplash, RootLayout, routeEnter, shownLastSeenAt } from "./root";
import { CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { collieMark, markIsLive, markPaper } from "@/test/collie-mark";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";

// BootSplash is the router's HydrateFallback: it stays mounted until the FIRST loader run settles, so
// over a dead tailnet (a hanging initial fetch) it can otherwise bloom the mark forever with no way
// out. It must escalate to an actionable "Not connected" state once stuck past CONNECTION_LOST_MS.
// Fake timers drive the wall-clock hook (Vitest advances Date.now with them).
describe("BootSplash — escalates a stuck cold start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // module-load anchor == frozen clock: a dead cold start escalates ~15s in
  });
  afterEach(() => vi.useRealTimers());

  it("blooms the mark on the connecting splash before the threshold", () => {
    const { container } = render(<BootSplash />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    // The bloom is a colour as well as turning — a reduced-motion reader gets the accents only.
    expect(markIsLive(container)).toBe(true);
    expect(markPaper(container)).toBe("var(--background)");
    // still the plain splash a beat before the threshold
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(markIsLive(container)).toBe(true);
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });

  it("escalates to 'Not connected' with a Retry once stuck past the threshold", () => {
    const { container } = render(<BootSplash />);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Can.t reach Collie/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Same mark throughout — it is never swapped for a second drawing, it only stops blooming: the
    // rest state is that mark still, muted. No bloom, because we have stopped trying, and a
    // blooming mark would say otherwise. (The "no gallop sprite here" assertion went with the
    // sprite itself — `dog-gallop` no longer exists to match, so the check had become vacuous.)
    const mark = collieMark(container);
    expect(markIsLive(container)).toBe(false);
    expect(mark?.getAttribute("class")).toMatch(/grayscale/);
  });
});

// The one connection surface is mounted in RootLayout and dates what is on screen. On the dashboard
// that is the herd; inside a pane it is the mirror, and after a cold boot the two stamps can be hours
// apart — the operator opened the pane at 12:05 and left the dashboard polling until 14:32.

const NOON = new Date(2026, 0, 2, 12, 5).getTime();
const AFTERNOON = new Date(2026, 0, 2, 14, 32).getTime();

function home(lastSeenAt?: number): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: true,
    authError: false,
    lastSeenAt,
  };
}

function pane(overrides: Partial<PaneData>): PaneData {
  return {
    paneId: "w1:p1",
    scope: {},
    text: "old terminal text",
    truncated: false,
    requestedLines: 600,
    revision: 0,
    error: true,
    authError: false,
    ...overrides,
  };
}

describe("which 'last seen' the connection bar shows", () => {
  it("uses the snapshot's stamp on the dashboard (no pane route active)", () => {
    expect(shownLastSeenAt(home(AFTERNOON), undefined)).toBe(AFTERNOON);
  });

  it("uses the PANE's own stamp while a stale mirror is what's being read", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ lastSeenAt: NOON }))).toBe(NOON);
  });

  it("says nothing rather than borrowing the herd's stamp for an undatable mirror", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ lastSeenAt: undefined }))).toBeUndefined();
  });

  it("falls back to the snapshot when the stale pane has no text to date", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ text: "", lastSeenAt: undefined }))).toBe(
      AFTERNOON,
    );
  });

  it("falls back to the snapshot when the pane itself is live", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ error: false, lastSeenAt: NOON }))).toBe(
      AFTERNOON,
    );
  });
});

// The root wrapper is the ONE flex column the whole app renders inside (banners + header + outlet, all
// in-flow). It must never itself become a scrolling element: a scrollport nested inside it that hits
// its own bound (the statusline strip, the mirror) would otherwise chain an over-drag into the
// document, dragging the banners and header off screen with it and leaving no scroll position to
// snap back from. `overflow-hidden` here is what forces every scroll to stay inside a scrollport that
// actually declares one.
describe("RootLayout — the document itself never scrolls", () => {
  it("renders its flex column with overflow-hidden", async () => {
    const router = createMemoryRouter(
      [{ id: ROOT_ROUTE_ID, path: "/", loader: () => home(AFTERNOON), element: <RootLayout /> }],
      { initialEntries: ["/"] },
    );
    const { container } = render(<RouterProvider router={router} />);
    // The loader resolves on a microtask even though it's synchronous — the route isn't hydrated yet
    // on the first render.
    const column = await waitFor(() => {
      const el = container.querySelector(".app-viewport.flex.flex-col");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(column.className).toMatch(/(?:^|\s)overflow-hidden(?=\s|$)/);
  });
});

// FORK: one entrance for every kind of navigation was the loudest "this is a website" tell the app
// had. What is pinned here is the DECISION, not the CSS: the animation lives in skin.css, and the
// only thing that can be wrong in TypeScript is which of the three words this returns.
describe("routeEnter — which way a route arrives", () => {
  it("raises Settings and the Overview regardless of where they were opened from", () => {
    expect(routeEnter("settings", "PUSH", 1, 0)).toBe("modal");
    expect(routeEnter("overview", "PUSH", 1, 0)).toBe("modal");
    // Even a Back INTO one of them rises: it has no sibling at its own level, so a sideways slide
    // would claim a hierarchy that does not exist.
    expect(routeEnter("settings", "POP", 1, 2)).toBe("modal");
  });

  it("pops on the browser's own Back, and on any move to a shallower path", () => {
    expect(routeEnter("", "POP", 0, 2)).toBe("pop");
    expect(routeEnter("", "PUSH", 0, 2)).toBe("pop");
    expect(routeEnter("space", "PUSH", 2, 3)).toBe("pop");
  });

  it("pushes deeper — and answers a same-depth hop the SAME way, so nothing replays", () => {
    expect(routeEnter("pane", "PUSH", 2, 0)).toBe("push");
    // pane → pane keeps the wrapper mounted (it is keyed by route KIND), so a different answer here
    // would change the attribute under a live element and replay an entrance for a hop that moved
    // nothing.
    expect(routeEnter("pane", "PUSH", 2, 2)).toBe("push");
  });
});
