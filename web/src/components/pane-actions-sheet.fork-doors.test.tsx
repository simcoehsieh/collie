import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import type { AgentView, MuxCapability, MuxConfig } from "@/lib/types";
import { PaneActionsSheet } from "./pane-actions-sheet";

// FORK — UPSTREAM 1.24/1.25 DOORS IN THE GROUPED ⋮ (the 1.25 merge, 2026-11-02).
//
// Zoom: upstream's door is an icon pill in the belt's pinned block, which this install does not draw
// (FORK_BELT_PINS_ON), so the output zoom gets a View row here instead.
// Report a problem: upstream's row is drawn only under FORK_REPORT_ON, which is off in the app. The
// gate is mocked off for the whole file; upstream's own pane-actions-sheet.test.tsx runs with it on.

vi.mock("@/lib/fork-shape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork-shape")>()),
  FORK_REPORT_ON: false,
}));

const agent: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/webapp",
  focused: false,
};

function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

beforeEach(() => declares({ renamePane: true, closePane: true, setFocus: true }));

type Props = React.ComponentProps<typeof PaneActionsSheet>;

function paneDoor(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    onClose: vi.fn(),
    pane: agent,
    onRenamed: vi.fn(),
    onClosed: vi.fn(),
    onHistory: vi.fn(),
    onFind: vi.fn(),
    onCopyOutput: vi.fn(),
    onSettings: vi.fn(),
    onZen: vi.fn(),
    ...overrides,
  };
}

describe("PaneActionsSheet — the fork's doors for upstream 1.25", () => {
  it("draws Zoom output in the View group, beside Zen, and the tap closes the sheet then opens the zoom", async () => {
    const user = userEvent.setup();
    const onZoom = vi.fn();
    const onClose = vi.fn();
    render(<PaneActionsSheet {...paneDoor({ onZoom, onClose })} />);
    const view = screen.getByRole("group", { name: "View" });
    const rows = within(view)
      .getAllByRole("button")
      .map((el) => el.textContent?.trim());
    expect(rows).toContain("Zoom output");
    expect(rows.indexOf("Zoom output")).toBe(rows.indexOf("Zen mode") - 1);
    await user.click(within(view).getByRole("button", { name: "Zoom output" }));
    expect(onClose).toHaveBeenCalled();
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  it("draws no Zoom row when the pane view passes no zoom (a pane with no screen)", () => {
    render(<PaneActionsSheet {...paneDoor()} />);
    expect(screen.queryByRole("button", { name: "Zoom output" })).toBeNull();
  });

  it("draws no Report a problem row with FORK_REPORT_ON off, even when the pane view passes one", () => {
    render(<PaneActionsSheet {...paneDoor({ onReport: vi.fn() })} />);
    expect(screen.getByRole("button", { name: "Zen mode" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
  });
});
