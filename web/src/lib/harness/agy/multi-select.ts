// Antigravity's MULTI-SELECT question — `ask_user_question` with `is_multi_select: true` — at the
// TAIL of a pane buffer, lifted into the harness-neutral `MultiSelectModel`.
//
// The screen (agy--multi-select-*.txt, Antigravity CLI 1.2.0, 2026-09-10):
//
//     Question 1/1: Which toppings do you want?
//     > 1. [ ] Cheese
//       2. [ ] Olives
//       3. [x] Mushrooms
//       4. Write-in...
//       ↑/↓ Navigate · space Toggle · enter Submit · esc Skip
//     esc to cancel                                    Gemini 3.8 Flash · high
//
// What the keys DO, every one live-probed on that build (grammar/AGY_NOTES.md):
//   * a DIGIT moves the pointer onto that row AND toggles it — so from the model's point of view a
//     digit is a toggle, exactly the intent the neutral action already has;
//   * `space` toggles the pointed row (never emitted: the digit is deterministic, space is not);
//   * `Enter` SUBMITS THE WHOLE SET from wherever the pointer sits. It does not toggle the pointed
//     row (Enter with nothing checked submitted the empty set), and there is no advance row to walk
//     onto and no review screen — which is why this model sets `submitKeys` and lets the neutral
//     action send Enter directly instead of walking a pointer it has nowhere to walk;
//   * EXCEPT on the `Write-in...` row: Enter there opens a text field (`Your answer:` over an
//     `enter Submit · esc Back` footer) into which every later key — a digit included — is TYPED.
//     That focused state is refused outright below, so it falls to the raw mirror; and the action's
//     direct-submit path nudges Up off that row before it ever presses Enter.
//
// Fail-closed like every sibling: no checkbox footer at the tail, no `Question k/N:` header, a
// `Your answer:` field, or a numbering we cannot send as a single digit — null, raw mirror.
// Pure over `StyledLine[]`; no pane access, no network.

import type { StyledLine } from "../../blocks";
import { isBlank, isHorizontalRule, lineText } from "./markers";
import type { MultiPointer, MultiSelectModel, MultiSelectOption } from "../multi-select-model";

export type { MultiPointer, MultiSelectModel, MultiSelectOption };

/** Detection result for buildBlocks: the model plus the region's first line (the `Question k/N:`
 *  header) — [`startLine` … tail] is replaced by the native block. */
export interface MultiSelectRegion {
  model: MultiSelectModel;
  startLine: number;
}

/** The keys the neutral action sends to submit the set — the footer's own `enter Submit`. */
export const AGY_MULTI_SELECT_SUBMIT_KEYS = ["Enter"];

// The checkbox screen's hint row. Both verbs are required: `space Toggle` is what no other agy
// screen prints, and `enter Submit` is the promise `submitKeys` relies on.
const CHECKBOX_FOOTER = /\bspace\s+toggle\b/i;
const SUBMIT_HINT = /\benter\s+submit\b/i;
// The Write-in field's own footer, and the field's label row — the state in which a key types.
const WRITE_IN_FOOTER = /^\s*enter\s+submit\s*·\s*esc\s+back\s*$/i;
const WRITE_IN_FIELD = /^\s*your answer:/i;

// `> 3. [x] Mushrooms` — pointer (optional), single digit, checkbox, label.
const CHECKBOX_ROW = /^(>?)\s*([1-9])\.\s+\[([ xX✔✓])\]\s+(.+?)\s*$/;
// `  4. Write-in...` — a numbered row WITHOUT a checkbox: agy's free-text escape. Tolerated in the
// run, never an option, never a button.
const PLAIN_ROW = /^(>?)\s*([1-9])\.\s+(.+?)\s*$/;
const QUESTION_HEADER = /^Question\s+\d+\/\d+:\s*\S/;

const OPTION_SCAN_WINDOW = 24;
const MAX_FOOTER_GAP = 3;
const QUESTION_SCAN_LIMIT = 4;

interface Row {
  index: number;
  n: number;
  pointed: boolean;
  checked: boolean | null; // null = the plain (free-text) row
  label: string;
}

function parseRow(text: string): Row | null {
  const cb = CHECKBOX_ROW.exec(text);
  if (cb) {
    return {
      index: -1,
      n: Number(cb[2]),
      pointed: cb[1] === ">",
      checked: cb[3] !== " ",
      label: cb[4]!,
    };
  }
  const plain = PLAIN_ROW.exec(text);
  if (plain) return { index: -1, n: Number(plain[2]), pointed: plain[1] === ">", checked: null, label: plain[3]! };
  return null;
}

/** The pointer/checkbox-independent signature over [`from` … `to`]: the `>` pointer and every
 *  checkbox glyph normalised out, so a toggle or a pointer move is not "a different dialog" — those
 *  are compared separately through the options[] (multiSelectEquals / multiSelectIdentity). */
function coreSignature(texts: string[], from: number, to: number): string {
  return texts
    .slice(from, to + 1)
    .map((t) => t.replace(/^(\s*)>/, "$1 ").replace(/\[[xX✔✓]\]/g, "[ ]").trimEnd())
    .join("\n");
}

/** Literal text over [`from` … `to`] — what the bridge binds the first write to. */
function literalRegion(texts: string[], from: number, to: number): string {
  return texts
    .slice(from, to + 1)
    .map((t) => t.trimEnd())
    .join("\n");
}

/**
 * Detect agy's checkbox question at the tail of `lines`. Returns the model + its start line, or
 * null. Ordered bails, cheapest first: the footer (allowing the status row beneath it), the
 * focused Write-in field, the option run, the `Question k/N:` header.
 */
export function detectMultiSelectRegion(lines: StyledLine[]): MultiSelectRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  // The hint row is the last non-blank line, or the one above agy's `esc to cancel … <model>` status
  // row — the same two-row tail prompt-select allows for.
  let footer = -1;
  for (let i = fi, seen = 0; i >= 0 && seen < 2; i--) {
    if (isBlank(texts[i]!)) continue;
    seen++;
    if (WRITE_IN_FOOTER.test(texts[i]!)) return null; // the field has the keyboard: a key TYPES
    if (CHECKBOX_FOOTER.test(texts[i]!) && SUBMIT_HINT.test(texts[i]!)) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;

  // The numbered run directly above the footer: checkbox rows plus, at most, the plain Write-in
  // row. Anything else between an option and the footer is a layout we do not know.
  const rows: Row[] = [];
  let i = footer - 1;
  let gap = 0;
  for (; i >= 0 && footer - i <= OPTION_SCAN_WINDOW; i--) {
    const t = texts[i]!;
    if (isBlank(t)) {
      if (rows.length > 0) break;
      if (++gap > MAX_FOOTER_GAP) return null;
      continue;
    }
    if (WRITE_IN_FIELD.test(t)) return null;
    const row = parseRow(t);
    if (!row) break;
    row.index = i;
    rows.unshift(row);
  }
  if (rows.length < 2) return null;
  if (footer - rows[rows.length - 1]!.index > MAX_FOOTER_GAP) return null;
  // Numbered 1..m, in order, or we cannot promise which digit toggles which row.
  if (!rows.every((r, k) => r.n === k + 1)) return null;
  const checkboxRows = rows.filter((r) => r.checked !== null);
  if (checkboxRows.length < 2) return null;
  // Only the LAST row may be the plain free-text row; a plain row among the checkboxes is not this
  // dialog.
  if (rows.some((r, k) => r.checked === null && k !== rows.length - 1)) return null;

  // The header sits within a few rows above the first option (blank rows tolerated). A rule in
  // between means the options belong to something else.
  const firstOpt = rows[0]!.index;
  let questionIdx = -1;
  for (let j = firstOpt - 1, seen = 0; j >= 0 && seen < QUESTION_SCAN_LIMIT; j--, seen++) {
    const t = texts[j]!;
    if (isBlank(t)) continue;
    if (isHorizontalRule(t)) return null;
    if (QUESTION_HEADER.test(t.trim())) questionIdx = j;
    break;
  }
  if (questionIdx < 0) return null;

  const options: MultiSelectOption[] = checkboxRows.map((r) => ({
    n: r.n,
    label: r.label,
    checked: r.checked === true,
  }));

  const pointed = rows.find((r) => r.pointed);
  let pointer: MultiPointer = null;
  if (pointed) pointer = pointed.checked === null ? "other" : "option";

  const lastRow = rows[rows.length - 1]!.index;
  const model: MultiSelectModel = {
    phase: "checkbox",
    question: texts[questionIdx]!.trim(),
    options,
    escape: null,
    pointer,
    steps: null,
    advanceLabel: "Submit",
    submitKeys: AGY_MULTI_SELECT_SUBMIT_KEYS,
    signature: coreSignature(texts, questionIdx, footer),
    regionSignature: literalRegion(texts, questionIdx, lastRow),
  };
  return { model, startLine: questionIdx };
}

/** Just the model (or null) — the race guard's re-derivation entry point. */
export function detectMultiSelect(lines: StyledLine[]): MultiSelectModel | null {
  return detectMultiSelectRegion(lines)?.model ?? null;
}
