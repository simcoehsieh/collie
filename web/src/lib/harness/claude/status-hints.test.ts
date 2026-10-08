import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { withUnreadDialog } from "../index";
import { extractInputDraft, hasInputBox, inputBoxTail, namesAModalKey } from "./chrome";
import { claudeAdapter } from "./index";
import { classifyFooter, lineText } from "./markers";

// Claude's default footer prints two hints that read like a modal's "<key> to <verb>" row but belong
// to the live composer: "esc to interrupt" while a turn runs, and "↓ to manage" while background
// tasks exist. Both used to make the box locator refuse the box, and the unread-dialog card then
// drew "Collie cannot read this dialog" over a healthy pane. The 2.1.278 lab corpus never saw them
// because it ran under a custom statusline, which replaces the default footer.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const read = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

describe("Claude status hints in the footer", () => {
  it.each([
    ["claude--working-esc-to-interrupt.txt", "a turn is running"],
    ["claude--idle-background-shell.txt", "a background shell is running"],
  ])("%s keeps its input box (%s)", (fixture) => {
    const lines = read(fixture);
    expect(hasInputBox(lines)).toBe(true);
    expect(inputBoxTail(lines)).toBe("statusline");
  });

  it.each(["claude--working-esc-to-interrupt.txt", "claude--idle-background-shell.txt"])(
    "%s draws no unread-dialog card",
    (fixture) => {
      const lines = read(fixture);
      const blocks = claudeAdapter.buildBlocks(lines);
      expect(withUnreadDialog(claudeAdapter, lines, blocks).map((b) => b.kind)).not.toContain(
        "unread-dialog",
      );
    },
  );
});

// FORK (2026-10-04): a multi-line draft makes the composer's footer print "ctrl+g to edit in VS Code"
// at its right edge, and classifyFooter read that as the ExitPlanMode dialog's footer — whose hint is
// the same words. The box locator then refused the box, extractInputDraft returned null, and every
// multi-line send from the phone (an attached image is its own line) stalled with "Message didn't
// reach the input box" while the text sat typed in the terminal.
describe("the composer's own ctrl+g hint", () => {
  const fixture = "claude--draft-multiline-vscode-hint.txt";
  const sent = "/Users/you/.local/state/collie/uploads/w1_p1-mutzj7mr-5a1c0e2d.png\n\n測試一下這個";

  it("keeps the input box and reads the multi-line draft", () => {
    const lines = read(fixture);
    expect(hasInputBox(lines)).toBe(true);
    expect(claudeAdapter.extractInputDraft(lines)).toBe(
      "/Users/you/.local/state/collie/uploads/w1_p1-mutzj7mr-5a1c0e2d.png 測試一下這個",
    );
    expect(sent.endsWith("測試一下這個")).toBe(true);
  });

  it("is not the plan dialog's footer, which always carries a '·' after the hint", () => {
    const texts: string[] = [];
    expect(classifyFooter("  ⏵⏵ bypass permissions on (shift+tab to cycle)        ctrl+g to edit in VS Code", texts)).toBeNull();
    expect(classifyFooter("? for shortcuts                ctrl+g to edit in Vim", texts)).toBeNull();
    // The fork's own `·` rule went at the 1.17 merge: upstream 1.17.2 claims the plan family only when
    // the plan dialog's own words are on screen (ADR 0053), which covers this case and the fixture
    // above. Its tests pin the real plan dialog; these two rows only pin the composer's hint.
  });
});

describe("namesAModalKey", () => {
  it.each([
    "⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents",
    "⏵⏵ bypass permissions on · 2 monitors · ← for agents · ↓ to manage",
    "esc to interrupt",
    "Esc to interrupt",
    "↓ to manage",
    // Claude clips the footer with "…" on a narrow pane.
    "⏵⏵ bypass permissions on · esc to inter…",
    "⏵⏵ bypass permissions on · esc to…",
    "⏵⏵ bypass permissions on · ↓ to man…",
  ])("does not take %j for a modal footer", (row) => {
    expect(namesAModalKey(row)).toBe(false);
  });

  it.each([
    "Esc to cancel",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
    "Esc to close",
    // A modal footer that happens to sit beside a status hint is still a modal footer.
    "esc to interrupt · Esc to cancel",
    "↓ to manage · Enter to select",
    // Only the closed list is exempt, not the verb "interrupt" for any key.
    "ctrl+c to interrupt",
    "esc to interrupt the dialog",
  ])("still takes %j for a modal footer", (row) => {
    expect(namesAModalKey(row)).toBe(true);
  });
});

// Claude Code 2.1.291 prints "ctrl+g to edit in nano" while the draft holds more than one line:
// right-aligned on the statusline's row at 82 and 120 columns, on a row of its own at 40. The plan
// dialog's footer opens with the same words, and Collie read the hint as that dialog: the box
// vanished, the unread-dialog card was drawn, and a send from the phone stalled. The hint is the
// composer's whenever the plan dialog's own words are not on screen.
describe("the multi-line draft's ctrl+g hint (Claude Code 2.1.291)", () => {
  const DRAFTS = [
    "claude-lab--draft-adversarial--w40.txt",
    "claude-lab--draft-adversarial--w82.txt",
    "claude-lab--draft-adversarial--w120.txt",
  ];

  it.each(DRAFTS)("%s is an idle screen with its input box", (fixture) => {
    const lines = read(fixture);
    expect(hasInputBox(lines)).toBe(true);
    expect(inputBoxTail(lines)).toBe("statusline");
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
    expect(extractInputDraft(lines)).toContain("compare these two lines:");
  });

  it.each(DRAFTS)("%s draws no unread-dialog card and lifts nothing", (fixture) => {
    const lines = read(fixture);
    const blocks = withUnreadDialog(claudeAdapter, lines, claudeAdapter.buildBlocks(lines));
    expect(blocks.map((b) => b.kind)).toEqual(["raw"]);
  });

  it("the hint is a status hint beside the draft, and a modal key with no screen to read", () => {
    const draft = read("claude-lab--draft-adversarial--w40.txt").map(lineText);
    expect(namesAModalKey("ctrl+g to edit in nano", draft)).toBe(false);
    expect(namesAModalKey("ctrl+g to edit in nano")).toBe(true);
    // Only the hint is exempt: a modal key beside it still names a modal.
    expect(namesAModalKey("ctrl+g to edit in nano · Esc to cancel", draft)).toBe(true);
  });

  it("the same words still name the plan dialog's footer when that dialog is on screen", () => {
    const plan = read("claude-lab--plan-approval--w40.txt").map(lineText);
    expect(namesAModalKey("ctrl+g to edit in nano", plan)).toBe(true);
  });
});
