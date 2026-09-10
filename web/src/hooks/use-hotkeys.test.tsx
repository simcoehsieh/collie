import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { __resetDashPrefs, setPinned } from "@/hooks/use-dash-prefs";
import type { HomeData } from "@/lib/loaders";
import { fixtureAgents } from "@/test/handlers";
import { CHORD_MS, isEditable, PALETTE_EVENT, paneOrder, stepRow, useHotkeys } from "./use-hotkeys";

// FORK: the desk's shortcuts. Driven with `enabled: true`, because jsdom has no `matchMedia` and
// the gate is the first thing the hook checks.

const data = (): HomeData => ({
  bridge: "connected",
  device: undefined,
  agents: fixtureAgents,
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
  error: false,
  authError: false,
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
function Host({ enabled = true }: { enabled?: boolean }) {
  const { helpOpen } = useHotkeys(data(), enabled);
  return (
    <>
      <Where />
      <div data-testid="help">{helpOpen ? "open" : "closed"}</div>
      <button type="button" data-pane-row="a">
        a
      </button>
      <button type="button" data-pane-row="b">
        b
      </button>
      <textarea data-slot="chat-input" aria-label="box" />
    </>
  );
}
function mount(enabled = true) {
  const router = createMemoryRouter([{ path: "*", element: <Host enabled={enabled} /> }], {
    initialEntries: ["/"],
  });
  render(<RouterProvider router={router} />);
  return router;
}
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key: k, ...init });

beforeEach(() => {
  localStorage.clear();
  __resetDashPrefs();
});

describe("isEditable", () => {
  it("names fields, and nothing else", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    const ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    ce.append(inner);
    expect(isEditable(input)).toBe(true);
    expect(isEditable(div)).toBe(false);
    expect(isEditable(inner)).toBe(true);
    expect(isEditable(null)).toBe(false);
  });
});

describe("paneOrder", () => {
  it("is the dashboard's order, pins first", () => {
    const last = fixtureAgents[fixtureAgents.length - 1]!.paneId;
    expect(paneOrder(data()).length).toBe(fixtureAgents.length);
    setPinned(last, true);
    expect(paneOrder(data())[0]!.paneId).toBe(last);
    expect(paneOrder(undefined)).toEqual([]);
  });
});

describe("useHotkeys", () => {
  it("j/k walk the pane rows by focus, from nowhere onto the first", () => {
    mount();
    expect(stepRow(1)).toBe(true);
    expect(document.activeElement).toHaveTextContent("a");
    key("j");
    expect(document.activeElement).toHaveTextContent("b");
    key("j"); // the end holds
    expect(document.activeElement).toHaveTextContent("b");
    key("k");
    expect(document.activeElement).toHaveTextContent("a");
  });

  it("a digit opens the nth pane, and g-chords navigate", () => {
    const router = mount();
    key("2");
    expect(router.state.location.pathname).toBe(
      `/pane/${encodeURIComponent(paneOrder(data())[1]!.paneId)}`,
    );
    key("g");
    key("o");
    expect(router.state.location.pathname).toBe("/overview");
    key("g");
    key("s");
    expect(router.state.location.pathname).toBe("/settings");
    key("g");
    key("h");
    expect(router.state.location.pathname).toBe("/");
  });

  it("a g that waits too long is forgotten", () => {
    const router = mount();
    key("g");
    const later = Date.now() + CHORD_MS + 1;
    const real = Date.now;
    Date.now = () => later;
    try {
      key("o");
    } finally {
      Date.now = real;
    }
    expect(router.state.location.pathname).toBe("/");
  });

  it("nothing fires while typing, except Escape leaving the field", () => {
    const router = mount();
    const box = screen.getByLabelText("box");
    box.focus();
    fireEvent.keyDown(box, { key: "2" });
    expect(router.state.location.pathname).toBe("/");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(document.activeElement).not.toBe(box);
  });

  it("/ focuses the composer, ? toggles the sheet, Escape closes it", () => {
    mount();
    key("/");
    expect(document.activeElement).toBe(screen.getByLabelText("box"));
    screen.getByLabelText("box").blur();
    key("?");
    expect(screen.getByTestId("help")).toHaveTextContent("open");
    key("Escape");
    expect(screen.getByTestId("help")).toHaveTextContent("closed");
  });

  it("⌘K raises the palette event, even from inside a field", () => {
    mount();
    let raised = 0;
    const count = () => raised++;
    document.addEventListener(PALETTE_EVENT, count);
    fireEvent.keyDown(screen.getByLabelText("box"), { key: "k", metaKey: true });
    key("k", { ctrlKey: true });
    document.removeEventListener(PALETTE_EVENT, count);
    expect(raised).toBe(2);
  });

  it("does nothing at all when disabled (a phone)", () => {
    const router = mount(false);
    key("2");
    expect(router.state.location.pathname).toBe("/");
  });

  it("needs a router — pinned so a mount outside RootLayout fails here, not on a phone", () => {
    expect(() => renderHook(() => useHotkeys(undefined, false))).toThrow();
  });
});

describe("stepRow", () => {
  it("answers false with no rows on the page", () => {
    render(<div />);
    expect(stepRow(1)).toBe(false);
    expect(stepRow(-1)).toBe(false);
  });
});
