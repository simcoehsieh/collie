import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import { agyAdapter } from "./index";
import { detectAutocompleteRegion } from "./autocomplete";
import { extractInputDraft, extractStatusLines, hasInputBox } from "./chrome";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

describe("agy autocomplete — the slash-completion popup (1.2.0 corpus)", () => {
  it("lifts agy--autocomplete-slash.txt: five entries as printed, box live under the popup", () => {
    const lines = load("agy--autocomplete-slash.txt");
    const region = detectAutocompleteRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.model.entries.map((e) => e.name)).toEqual([
      "/model",
      "/migrate-workflows",
      "/permissions",
      "/time-context",
      "/gsap-frameworks",
    ]);
    expect(region!.model.entries[2]!.description).toBe("Manage tool permissions");
    // The peel: the box IS on screen, the draft is the partial command, the status row still reads.
    expect(hasInputBox(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe("/mo");
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    const status = extractStatusLines(lines).map(lineText).join(" ");
    expect(status).toContain("esc to cancel");
    expect(status).not.toContain("/migrate-workflows");

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "autocomplete"]);
    // The box (with its `/mo` draft) and the popup are both out of the mirror; the transcript's own
    // `/model` rows above the box stay.
    const rows = blocks[0]!.lines.map((l) => lineText(l).trim());
    expect(rows).not.toContain("> /mo");
    expect(rows.some((r) => r.includes("tab Complete"))).toBe(false);
    expect(rows.some((r) => r.includes("Exited /model command"))).toBe(true);
  });

  it("declines Claude's popup (no agy hint row) and an idle agy screen", () => {
    expect(detectAutocompleteRegion(load("claude--autocomplete-slash-short.txt"))).toBeNull();
    expect(detectAutocompleteRegion(load("agy--fresh-idle.txt"))).toBeNull();
  });
});
