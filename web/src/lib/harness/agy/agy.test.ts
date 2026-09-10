import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { agyAdapter, antigravityAdapter } from "./index";
import { detectPromptSelect } from "./prompt-select";
import { describeAdapterConformance } from "../conformance";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

/** AGY paints its composer between two full-width rules; 60 columns clears isBoxBorder. */
const RULE = "────────────────────────────────────────────────────────────";

const load = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

const allFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.endsWith(".txt"))
  .toSorted();

const allAgyFixtures = allFixtures.filter((f) => f.startsWith("agy--"));

// Captures that lift NOTHING by design: idle/working/done screens, a multi-line draft, the `?`
// shortcuts overlay (no rule anchors it, so it stays raw with the composer refused), and the
// multi-select's focused Write-in field (refused: a key there TYPES).
const NEUTRAL = new Set([
  "agy--fresh-idle.txt",
  "agy--working.txt",
  "agy--done.txt",
  "agy--draft-multiline.txt",
  "agy--help-overlay.txt",
  "agy--multi-select-writein.txt",
]);

const ownFixtures = allAgyFixtures.filter((f) => !NEUTRAL.has(f));
const neutralFixtures = allAgyFixtures.filter((f) => NEUTRAL.has(f));
const foreignFixtures = allFixtures.filter((f) => !f.startsWith("agy--"));

// Measured on Antigravity CLI 1.2.0 (2026-09-10, AGY_NOTES.md): a multi-question ask_user_question
// call is painted as one `Question k/N:` select after another with no stepper (each lifts as
// prompt-select), and the tool's schema — printed by the agent itself — carries no preview field.
const NOT_APPLICABLE = {
  wizard: "a multi-question call is a run of `Question k/N:` selects, each lifted as prompt-select",
  "preview-select": "ask_user_question has no preview field (schema: question, options, is_multi_select)",
} as const;

describeAdapterConformance(agyAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
  notApplicable: NOT_APPLICABLE,
});

describeAdapterConformance(antigravityAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
  notApplicable: NOT_APPLICABLE,
});

describe("agyAdapter unit & footer safety", () => {
  it("claims agent 'agy' and 'antigravity'", () => {
    expect(agyAdapter.agent).toBe("agy");
    expect(antigravityAdapter.agent).toBe("antigravity");
  });

  it("detects an AskUserQuestion prompt with a footer and lifts it into interactive prompt-select options", () => {
    const raw = [
      "Which action would you like to take?",
      "❯ 1. Run build directly",
      "  2. Inspect directory first",
      "  3. Skip step",
      "Enter to select · ↑/↓ to navigate",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.question).toBe("Which action would you like to take?");
    expect(model!.family).toBe("select");
    expect(model!.options).toHaveLength(3);
    expect(model!.options[0]!.label).toBe("Run build directly");
    // The digit alone: probed on 1.2.0 to select AND submit (a trailing Enter double-answers a
    // multi-question call — see "a digit alone answers" below).
    expect(model!.options[0]!.keys).toEqual(["1"]);
    expect(model!.options[1]!.label).toBe("Inspect directory first");
    expect(model!.options[1]!.keys).toEqual(["2"]);

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.some((b) => b.kind === "prompt-select")).toBe(true);
  });

  it("declines a numbered list without a dialog footer (ADR 0009 safety)", () => {
    const raw = [
      "Available skills:",
      "  1. agy-customizations - Guide and reference",
      "  2. graphify - Knowledge graph analysis",
      "  3. antigravity-guide - Overview and quick reference",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).toBeNull();

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.every((b) => b.kind === "raw")).toBe(true);
  });

  it("detects tool permission prompt and extracts digit key alone", () => {
    const raw = [
      "Allow bash command: `npm test`?",
      "  1. Yes",
      "  2. No",
      "  3. Always allow",
      "Tab to amend · Esc to cancel",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.family).toBe("permission");
    expect(model!.options[0]!.label).toBe("Yes");
    expect(model!.options[0]!.keys).toEqual(["1"]);
    expect(model!.options[1]!.label).toBe("No");
    expect(model!.options[1]!.keys).toEqual(["2"]);
  });

  it("answers composerReady false when a prompt dialog is on screen", () => {
    const raw = [
      "Which model should be used?",
      "  1. Gemini 3.7 Pro",
      "  2. Gemini 3.7 Flash",
      "Enter to select",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("answers composerReady true at a boxed idle composer", () => {
    const raw = ["Ready for instructions.", RULE, "> ", RULE, "? for shortcuts"].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
  });

  // AGY echoes every submitted message as a `> ` transcript row, and paints an answered
  // ask_user_question selection the same way. Without the enclosing box those rows are
  // indistinguishable from a live composer, so an unanchored `>` must never claim one: Collie would
  // report a writable pane over a busy agent and hand the echo back as the operator's draft.
  it("refuses an unanchored tail `>` row — a transcript echo is not a composer", () => {
    const raw = ["some transcript output", "----------------", "> this is a quoted line"].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.extractStatusLines!(lines)).toEqual([]);
  });

  it("keeps a bare `>` prompt with no box and no status row out of the composer grammar", () => {
    const lines = splitLines(parseAnsi(["Ready for instructions.", "> "].join("\n")));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("correctly locates the input box and extracts statusline on agy--fresh-idle.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--fresh-idle.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.composerReady!(lines)).toBe(true);

    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("? for shortcuts");
    expect(statusText).toContain("Gemini 3.7 Flash");

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.kind).toBe("raw");
    const mirrorText = blocks[0]!.lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    expect(mirrorText).not.toContain("? for shortcuts");
    expect(mirrorText).not.toContain("──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>");
  });

  it("extracts no spurious draft and extracts statusline on agy--done.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--done.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.composerReady!(lines)).toBe(true);

    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("? for shortcuts");
  });

  it("extracts working statusline on agy--working.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--working.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("Gemini 3.7 Flash");
  });

  it("a digit alone answers a `Question k/N:` step — no trailing Enter (agy--wizard-q1/q2)", () => {
    // Probed 2026-09-10 on 1.2.0: `2` on Question 1/2 chose Green AND advanced to Question 2/2; an
    // Enter sent after it chose the second question's pointed default sight unseen.
    for (const name of ["agy--wizard-q1.txt", "agy--wizard-q2.txt", "agy--select-menu.txt"]) {
      const blocks = agyAdapter.buildBlocks(load(name));
      const block = blocks.find((b) => b.kind === "prompt-select");
      expect(block, name).toBeDefined();
      if (!block || block.kind !== "prompt-select") continue;
      for (const option of block.prompt.options) expect(option.keys, name).toEqual([option.keys[0]]);
      expect(block.prompt.options.every((o) => !/write-in/i.test(o.label)), name).toBe(true);
    }
    const q2 = agyAdapter.buildBlocks(load("agy--wizard-q2.txt")).find((b) => b.kind === "prompt-select");
    if (q2 && q2.kind === "prompt-select") {
      expect(q2.prompt.question).toBe("Question 2/2: Which size?");
      expect(q2.prompt.options.map((o) => o.label)).toEqual(["Small", "Large"]);
    }
  });

  it("reads a multi-line draft as one space-joined line (agy--draft-multiline.txt)", () => {
    const lines = load("agy--draft-multiline.txt");
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).toBe("first line of a draft second line here third line");
    expect(agyAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
  });

  it("extracts typed user draft inside an input box", () => {
    const raw = [
      "────────────────────────────────────────────────────────────",
      "> write a python fibonacci function",
      "────────────────────────────────────────────────────────────",
      "? for shortcuts                                 Gemini 3.7",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBe("write a python fibonacci function");
  });
});

