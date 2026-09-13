// Antigravity's SLASH-COMPLETION POPUP — the candidate list it paints DIRECTLY UNDER the input
// box's bottom rule while the draft is a partial `/command` (agy--autocomplete-slash.txt, 1.2.0):
//
//     ────────────────────────────                     ← the box's bottom rule
//     > /model                 Set a model, or run …   ← ENTRY row, `>` on the highlighted one
//       /migrate-workflows     Automatically migrate … ← ENTRY row
//        ↓ 6 more                                      ← optional overflow row
//       ↑/↓ Navigate · enter Select · tab Complete     ← the popup's own hint row
//     esc to cancel                    Gemini 3.8 …    ← agy's status row, as ever
//
// Unlike Claude's popup this one names keys, and its hint row reads to `classifyFooter` as a select
// footer. It is still NOT a dialog: the input box above it is live, typing keeps filtering it, and
// it vanishes when the draft stops matching — so it is lifted as the keyless `autocomplete` block and
// the composer stays open. prompt-select cannot claim it (no numbered rows) and the menu grammar
// declines it (`classifyFooter` owns the footer, and the box is on screen once this run is peeled).
//
// The peel is what makes the box findable at all: chrome.ts's tail walk allows a few status rows
// under the bottom rule, and the popup is taller than that. Pure over line text; no pane access.

import type { StyledLine } from "../../blocks";
import type { AutocompleteEntry, AutocompleteModel } from "../autocomplete-model";
import { isBlank, isBoxBorder, lineText } from "./markers";

const POPUP_FOOTER = /^\s*↑\/↓ Navigate · enter Select · tab Complete\s*$/;
const MORE_ROW = /^\s*↓ \d+ more\s*$/;
// `> /model     Set a model…` or `  /permissions   Manage tool permissions` or a bare `  /foo`.
const ENTRY_ROW = /^[> ] (\/[A-Za-z0-9][A-Za-z0-9:_-]*)(?:\s{2,}(\S.*?))?\s*$/;

// Rows under the popup's hint row that may sit at the tail: agy's status row, at most this many.
const MAX_TRAILING_ROWS = 2;
const MAX_ENTRY_ROWS = 40;

export interface AutocompleteRun {
  /** Index of the first entry row — the line directly below the box's bottom rule. */
  start: number;
  /** Index of the popup's hint row; the status row(s) follow it. */
  footer: number;
  entries: AutocompleteEntry[];
}

/**
 * Find the popup at the tail of `texts` (`end` exclusive, `end - 1` the last non-blank line):
 * the hint row within MAX_TRAILING_ROWS of the tail, an optional overflow row above it, then
 * entry rows up to a box border directly above the first. Null on anything else.
 */
export function findAutocompleteRun(texts: string[], end: number): AutocompleteRun | null {
  let footer = -1;
  for (let i = end - 1, seen = 0; i >= 0 && seen <= MAX_TRAILING_ROWS; i--) {
    if (isBlank(texts[i]!)) continue;
    seen++;
    if (POPUP_FOOTER.test(texts[i]!)) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;

  // agy pads a blank row above its hint row; the overflow row, when present, sits above that.
  let i = footer - 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  if (i >= 0 && MORE_ROW.test(texts[i]!)) i--;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  const entries: AutocompleteEntry[] = [];
  let rows = 0;
  for (; i >= 0 && rows < MAX_ENTRY_ROWS; i--, rows++) {
    const t = texts[i]!;
    if (isBlank(t) || isBoxBorder(t)) break;
    const m = ENTRY_ROW.exec(t);
    if (!m) return null;
    entries.unshift({ name: m[1]!, description: (m[2] ?? "").trimEnd() });
  }
  if (entries.length === 0) return null;
  if (i < 0 || !isBoxBorder(texts[i]!)) return null;
  return { start: i + 1, footer, entries };
}

export interface AutocompleteRegion {
  model: AutocompleteModel;
  startLine: number;
}

/** Detect the popup at the tail of `lines`, trailing blank rows ignored. Does NOT check the box is
 *  there — the caller pairs it with `hasInputBox`, whose locator peels this same run. */
export function detectAutocompleteRegion(lines: StyledLine[]): AutocompleteRegion | null {
  const texts = lines.map(lineText);
  let end = texts.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;
  const run = findAutocompleteRun(texts, end);
  return run === null ? null : { model: { entries: run.entries }, startLine: run.start };
}
