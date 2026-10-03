import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetLocale, setLocale, whenLocaleReady } from "@/lib/i18n";
import type { AgentView, MuxCapability, MuxConfig } from "@/lib/types";
import { PaneActionsSheet } from "./pane-actions-sheet";

// FORK — THE ⋮ MENU IN GROUPS (survey round 3). Upstream's own cases for this sheet stay in
// pane-actions-sheet.test.tsx; what is pinned here is the fork's shape: the four read tiles first,
// then View / Output / Manage, the least-used rows folded behind "More" for one opening only, and
// Close still last and still two taps. The doors with no read rows keep their short, unfolded sheet.

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

/** Serve an `/api/config` whose mux block declares exactly `capabilities`. */
function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

// ONE mux block for the whole file. The config store is module-level, and a test that ends with its
// `/api/config` read still in flight lets that answer land in the NEXT test — so every test here is
// served the same block, and a stale answer can only ever be an identical one.
beforeEach(() => declares({ renamePane: true, closePane: true, setFocus: true }));
afterEach(() => __resetOperatorCommands());

type Props = React.ComponentProps<typeof PaneActionsSheet>;

/** Every read the pane view's ⋮ hands the sheet. */
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
    onDiff: vi.fn(),
    onSettings: vi.fn(),
    onDisplay: vi.fn(),
    onZen: vi.fn(),
    onDocs: vi.fn(),
    onArtifacts: vi.fn(),
    onHandoff: vi.fn(),
    onAnnotate: vi.fn(),
    ...overrides,
  };
}

const names = (els: readonly HTMLElement[]) => els.map((el) => el.textContent?.trim());

describe("PaneActionsSheet — the ⋮ in groups", () => {
  it("leads with the four read tiles, in the order History, Find, Copy output, What changed", () => {
    render(<PaneActionsSheet {...paneDoor()} />);
    const tiles = screen.getByRole("group", { name: "Read this pane" });
    expect(names(within(tiles).getAllByRole("button"))).toEqual([
      "Conversation history",
      "Find in output",
      "Copy output",
      "What changed",
    ]);
    // Before every other control in the sheet.
    const firstOther = screen.getByRole("button", { name: "Zen mode" });
    expect(tiles.compareDocumentPosition(firstOther) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("files the rest under View, Output and Manage, in that order", () => {
    render(<PaneActionsSheet {...paneDoor()} />);
    const view = screen.getByRole("group", { name: "View" });
    const output = screen.getByRole("group", { name: "Output" });
    const manage = screen.getByRole("group", { name: "Manage" });
    expect(names(within(view).getAllByRole("button"))).toEqual(["Pane settings", "Display settings", "Zen mode"]);
    expect(names(within(output).getAllByRole("button"))).toEqual(["Documents", "Artifacts"]);
    expect(within(manage).getByRole("button", { name: "Pin to top" })).toBeInTheDocument();
    expect(view.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(output.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws no heading over a group it was handed nothing for", () => {
    render(<PaneActionsSheet {...paneDoor({ onDocs: undefined, onArtifacts: undefined })} />);
    expect(screen.queryByRole("group", { name: "Output" })).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("folds hand off, screenshot and show-in-terminal behind More", async () => {
    const user = userEvent.setup();
    render(<PaneActionsSheet {...paneDoor()} />);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Hand off to another agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Screenshot & annotate…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Focus in reference" })).toBeNull();
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Hand off to another agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Screenshot & annotate…" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Focus in reference" })).toBeInTheDocument();
  });

  it("opens every sheet folded: the fold lives for one opening only", async () => {
    const user = userEvent.setup();
    const props = paneDoor();
    const { rerender } = render(<PaneActionsSheet {...props} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Hand off to another agent" })).toBeInTheDocument();
    rerender(<PaneActionsSheet {...props} open={false} />);
    rerender(<PaneActionsSheet {...props} open />);
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Hand off to another agent" })).toBeNull();
  });

  // Read-only takes "Show in terminal" (a write); with no hand off and no screenshot either, the fold
  // would hold nothing, so there is no fold.
  it("draws no More at all when nothing would be inside it", () => {
    render(<PaneActionsSheet {...paneDoor({ readOnly: true, onHandoff: undefined, onAnnotate: undefined })} />);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pin to top" })).toBeInTheDocument();
  });

  // A seam the bridge cannot run never reaches this sheet as a callback (bridge/command-paths.ts
  // withholds `shot` from /api/config), and a row with no callback is not drawn — folded or not.
  it("draws no screenshot row when it was not handed one, even unfolded", async () => {
    const user = userEvent.setup();
    render(<PaneActionsSheet {...paneDoor({ onAnnotate: undefined })} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Screenshot & annotate…" })).toBeNull();
  });

  it("keeps Close last in the sheet, and two taps", async () => {
    const user = userEvent.setup();
    const props = paneDoor();
    server.use(http.post("/api/pane/w1%3Ap1/close", () => HttpResponse.json({ ok: true })));
    render(<PaneActionsSheet {...props} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    const close = await screen.findByRole("button", { name: "Close pane" });
    const all = screen.getAllByRole("button");
    expect(all.at(-1)).toBe(close);
    await user.click(close);
    expect(props.onClosed).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tap again to close" }));
    await waitFor(() => expect(props.onClosed).toHaveBeenCalledWith("w1:p1"));
  });

  it("closes before it acts, from a tile and from a folded row alike", async () => {
    const user = userEvent.setup();
    const props = paneDoor();
    render(<PaneActionsSheet {...props} />);
    await user.click(screen.getByRole("button", { name: "What changed" }));
    expect(vi.mocked(props.onClose).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(props.onDiff!).mock.invocationCallOrder[0]!,
    );
  });
});

describe("PaneActionsSheet — the doors with no read rows stay short", () => {
  it("keeps Show in terminal a plain row under Manage, with no fold", async () => {
    render(
      <PaneActionsSheet open onClose={vi.fn()} pane={agent} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    const manage = screen.getByRole("group", { name: "Manage" });
    expect(await within(manage).findByRole("button", { name: "Focus in reference" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Read this pane" })).toBeNull();
  });
});

describe("PaneActionsSheet — the operator's language", () => {
  afterEach(() => {
    localStorage.clear();
    __resetLocale();
  });

  it("names the groups and the fold in Traditional Chinese", async () => {
    setLocale("zh-TW");
    await whenLocaleReady();
    render(<PaneActionsSheet {...paneDoor()} />);
    expect(screen.getByRole("group", { name: "閱讀這個窗格" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "檢視" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "產出" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "管理" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多" })).toBeInTheDocument();
  });
});
