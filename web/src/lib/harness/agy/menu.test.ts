import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { agyAdapter } from "./index";
import { detectMenu, parseAgyKeyHintFooter } from "./menu";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

describe("agy footer grammar — `Keyboard: <key> <Verb>  <key> <Verb>` and `<key> <Verb> · …`", () => {
  it("reads the /model footer: Enter and Esc as actions, the arrow pairs by name", () => {
    const hints = parseAgyKeyHintFooter("Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back");
    expect(hints).toEqual({
      actions: [
        { label: "Select", keys: ["Enter"] },
        { label: "Go Back", keys: ["Escape"], cancel: true },
      ],
      upDown: true,
      leftRightVerb: "Effort",
    });
  });

  it("reads the dot-separated popup footer too", () => {
    const hints = parseAgyKeyHintFooter("  ↑/↓ Navigate · enter Select · tab Complete");
    expect(hints!.actions.map((a) => a.keys[0])).toEqual(["Enter", "Tab"]);
    expect(hints!.upDown).toBe(true);
  });

  it("declines Claude's and Codex's `<key> to <verb>` grammar, and any line with an unmappable token", () => {
    expect(parseAgyKeyHintFooter("Enter to set as default · s to use this session only · Esc to cancel")).toBeNull();
    expect(parseAgyKeyHintFooter("tab to add notes | enter to submit answer")).toBeNull();
    // Claude's background-agents row: `↓` would map to Down, but `◯` and `1m` do not — the line is prose.
    expect(parseAgyKeyHintFooter("  ◯ worker:scout  Reviewing the test suite      1m 17s · ↓ 12.0k tokens")).toBeNull();
    expect(parseAgyKeyHintFooter("                     Gemini 3.8 Flash · high")).toBeNull();
    expect(parseAgyKeyHintFooter("esc to cancel")).toBeNull();
  });
});

describe("agy menu — /model and /permissions (1.2.0 corpus)", () => {
  it("lifts agy--menu-model.txt: title, footer keys, both arrow pairs, Effort as the live value", () => {
    const lines = load("agy--menu-model.txt");
    const menu = detectMenu(lines);
    expect(menu).not.toBeNull();
    expect(menu!.title).toBe("Switch Model");
    expect(menu!.actions).toEqual([
      { label: "Select", keys: ["Enter"] },
      { label: "Go Back", keys: ["Escape"], cancel: true },
    ]);
    expect(menu!.nav.upDown).toBe(true);
    expect(menu!.nav.leftRight?.verb).toBe("Effort");
    expect(menu!.nav.leftRight?.label.startsWith("Effort")).toBe(true);
    expect(menu!.signature).toContain("Gemini 3.7 Flash");
    expect(agyAdapter.buildBlocks(lines).map((b) => b.kind)).toEqual(["raw", "menu"]);
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("lifts agy--menu-permissions.txt with Save / Close and no left-right nav", () => {
    const menu = detectMenu(load("agy--menu-permissions.txt"));
    expect(menu).not.toBeNull();
    expect(menu!.title).toBe("Permission Config Editor");
    expect(menu!.actions.map((a) => [a.label, a.keys[0]])).toEqual([
      ["Save", "Enter"],
      ["Close", "Escape"],
    ]);
    expect(menu!.nav.upDown).toBe(true);
    expect(menu!.nav.leftRight).toBeUndefined();
  });

  it("leaves the `?` shortcuts overlay raw (no rule anchors it) with the composer refused", () => {
    const lines = load("agy--help-overlay.txt");
    expect(detectMenu(lines)).toBeNull();
    expect(agyAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("never claims another harness's picker (Claude and omp /model screens)", () => {
    for (const name of ["claude--menu-model-picker.txt", "omp--menu-model.txt", "codex--fresh-idle.txt"]) {
      expect(detectMenu(load(name)), name).toBeNull();
    }
  });
});
