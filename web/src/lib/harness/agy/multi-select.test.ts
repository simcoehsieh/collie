import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { multiSelectEquals, multiSelectIdentity } from "../multi-select-model";
import { agyAdapter } from "./index";
import { AGY_MULTI_SELECT_SUBMIT_KEYS, detectMultiSelect, detectMultiSelectRegion } from "./multi-select";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

const STATUS = "esc to cancel                                                Gemini 3.8 Flash · high";
const FOOTER = "  ↑/↓ Navigate · space Toggle · enter Submit · esc Skip";

function screen(rows: string[]): ReturnType<typeof load> {
  return splitLines(parseAnsi(rows.join("\n")));
}

describe("agy multi-select — the checkbox ask_user_question (1.2.0 corpus)", () => {
  it("lifts agy--multi-select-unchecked.txt: three options, none checked, pointer on an option", () => {
    const model = detectMultiSelect(load("agy--multi-select-unchecked.txt"));
    expect(model).not.toBeNull();
    expect(model!.phase).toBe("checkbox");
    if (model!.phase !== "checkbox") return;
    expect(model!.question).toBe("Question 1/1: Which toppings do you want?");
    expect(model!.options.map((o) => [o.n, o.label, o.checked])).toEqual([
      [1, "Cheese", false],
      [2, "Olives", false],
      [3, "Mushrooms", false],
    ]);
    expect(model!.escape).toBeNull(); // `4. Write-in...` is a text field, never a button
    expect(model!.pointer).toBe("option");
    expect(model!.steps).toBeNull();
    expect(model!.advanceLabel).toBe("Submit");
    expect(model!.submitKeys).toEqual(AGY_MULTI_SELECT_SUBMIT_KEYS);
    expect(model!.signature.length).toBeGreaterThan(0);
    expect(model!.regionSignature).toContain("Question 1/1: Which toppings do you want?");
    expect(model!.regionSignature).toContain("4. Write-in...");
    expect(model!.regionSignature).not.toContain("space Toggle");
  });

  it("lifts agy--multi-select-checked.txt with Mushrooms checked, and reads it as the SAME dialog", () => {
    const a = detectMultiSelect(load("agy--multi-select-unchecked.txt"))!;
    const b = detectMultiSelect(load("agy--multi-select-checked.txt"))!;
    expect(b.phase).toBe("checkbox");
    if (a.phase !== "checkbox" || b.phase !== "checkbox") return;
    expect(b.options.map((o) => o.checked)).toEqual([false, false, true]);
    // The pointer and the checkbox glyphs are normalised out of the signature …
    expect(b.signature).toBe(a.signature);
    // … but a flipped box is drift for the mid-flight identity, and a different committing screen.
    expect(multiSelectIdentity(a, b)).toBe(false);
    expect(multiSelectEquals(a, b)).toBe(false);
    expect(multiSelectEquals(b, detectMultiSelect(load("agy--multi-select-checked.txt"))!)).toBe(true);
  });

  it("replaces the region from the `Question k/N:` header down, keeping the transcript raw", () => {
    const lines = load("agy--multi-select-unchecked.txt");
    const region = detectMultiSelectRegion(lines)!;
    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "multi-select"]);
    expect(blocks[1]!.lines.length).toBe(lines.length - region.startLine);
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("refuses the focused Write-in field (agy--multi-select-writein.txt): a key there types", () => {
    const lines = load("agy--multi-select-writein.txt");
    expect(detectMultiSelect(lines)).toBeNull();
    expect(agyAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("reports the pointer as `other` on the Write-in row, so the submit path nudges off it first", () => {
    const model = detectMultiSelect(
      screen([
        "Question 1/1: Which toppings do you want?",
        "  1. [ ] Cheese",
        "  2. [x] Olives",
        "> 3. Write-in...",
        FOOTER,
        STATUS,
      ]),
    );
    expect(model).not.toBeNull();
    if (model!.phase !== "checkbox") return;
    expect(model!.pointer).toBe("other");
    expect(model!.options).toHaveLength(2);
  });

  it("refuses without the `Question k/N:` header, without the space-Toggle footer, or with a gap in the numbering", () => {
    expect(
      detectMultiSelect(screen(["Which toppings?", "  1. [ ] Cheese", "  2. [ ] Olives", FOOTER, STATUS])),
    ).toBeNull();
    expect(
      detectMultiSelect(
        screen([
          "Question 1/1: Which toppings do you want?",
          "  1. [ ] Cheese",
          "  2. [ ] Olives",
          "  ↑/↓ Navigate · enter Select · esc Skip",
          STATUS,
        ]),
      ),
    ).toBeNull();
    expect(
      detectMultiSelect(
        screen(["Question 1/1: Which toppings do you want?", "  1. [ ] Cheese", "  3. [ ] Olives", FOOTER, STATUS]),
      ),
    ).toBeNull();
  });

  it("does not lift Claude's checkbox screens (foreign corpus stays raw)", () => {
    for (const name of ["claude--select-multiselect-checked.txt", "claude--wizard-multiselect-q1.txt"]) {
      expect(detectMultiSelect(load(name)), name).toBeNull();
    }
  });
});
