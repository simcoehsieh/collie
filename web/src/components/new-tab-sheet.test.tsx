import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Launcher } from "@/lib/types";
import { NewTabSheet } from "./new-tab-sheet";

// What the tab strip's "+" opens, reached by holding it. The sheet's whole subject is what the "+"
// does, so choosing IS configuring — and the two claims below are the ones that make that honest:
// a tap does both, and the sheet says so before you tap.

const ROWS: Launcher[] = [
  { command: "claude", label: "claude" },
  { command: "codex --profile work", label: "codex", cwd: "/home/op/git/collie" },
];

function renderSheet(overrides: Partial<Parameters<typeof NewTabSheet>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    launchers: ROWS,
    selected: "",
    onPick: vi.fn(),
    home: "/home/op",
    ...overrides,
  };
  render(<NewTabSheet {...props} />);
  return props;
}

describe("NewTabSheet", () => {
  it("offers the plain shell first, and every declared launcher after it", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: /plain shell/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /claude/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /codex/ })).toBeInTheDocument();
  });

  it("keeps the plain shell even with no launchers at all", () => {
    // It is the shipped behaviour, so it is never the row that goes missing — a sheet whose only
    // content was "nothing declared" would be a worse answer than the one it is replacing.
    renderSheet({ launchers: [] });
    expect(screen.getByRole("button", { name: /plain shell/i })).toBeInTheDocument();
  });

  it("marks the pinned row, and only it", () => {
    renderSheet({ selected: "claude" });
    expect(screen.getByRole("button", { name: /claude/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /plain shell/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("a tap picks the row and closes — one gesture, both jobs", async () => {
    const user = userEvent.setup();
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: /claude/ }));
    expect(props.onPick).toHaveBeenCalledWith("claude");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("the plain shell picks the EMPTY command, which is what means 'a bare shell'", async () => {
    const user = userEvent.setup();
    const props = renderSheet({ selected: "claude" });
    await user.click(screen.getByRole("button", { name: /plain shell/i }));
    expect(props.onPick).toHaveBeenCalledWith("");
  });

  it("says that a tap also sets the default, rather than leaving it to be discovered", () => {
    // The one thing a reader cannot infer from the rows: that choosing here is permanent until
    // changed. Without the line, a tap looks like a one-off launch.
    renderSheet();
    expect(screen.getByText(/makes it what \+ does/i)).toBeInTheDocument();
  });

  it("draws each row's own agent mark, and hides it from the accessible name", () => {
    // The app already ships these tiles — the tab strip and the herd list draw the same ones — so a
    // row here is recognisable at a glance rather than by reading it. Hidden from the a11y tree
    // because the label beside it already names the row, and `AgentIcon` names ITSELF "<agent> logo".
    renderSheet();
    const claude = screen.getByRole("button", { name: /claude/ });
    const mark = claude.querySelector('[aria-hidden="true"]');
    expect(mark).not.toBeNull();
    expect(mark?.querySelector("svg, span")).not.toBeNull();
    // One name, not two: the row announces as its label alone.
    expect(claude).toHaveAccessibleName("claude");
  });

  it("resolves the mark from the COMMAND, so flags and paths do not lose it", () => {
    // `codex --profile work` is codex. The row's label is the operator's own word and may be
    // anything, so it is the command that has to answer this.
    renderSheet({
      launchers: [{ command: "/opt/homebrew/bin/codex --profile work", label: "work" }],
    });
    const row = screen.getByRole("button", { name: "work" });
    expect(row.querySelector('[role="img"], svg')).not.toBeNull();
  });

  it("leaves the plain shell a glyph rather than a tile", () => {
    // It is the ABSENCE of an agent; a tile would read as one more brand in the list.
    renderSheet();
    const shell = screen.getByRole("button", { name: /plain shell/i });
    expect(shell.querySelector("svg.lucide-terminal")).not.toBeNull();
  });

  it("shows a pinned directory shortened, and nothing where a row has none", () => {
    renderSheet();
    expect(screen.getByText("~/git/collie")).toBeInTheDocument();
    expect(screen.queryByText("/home/op/git/collie")).not.toBeInTheDocument();
  });
});
