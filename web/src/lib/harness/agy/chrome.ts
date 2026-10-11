import type { StyledLine } from "../../blocks";
import { findAutocompleteRun } from "./autocomplete";
import { classifyFooter, isBlank, isBoxBorder, lineText } from "./markers";
import { detectPromptSelectRegionIn, parseOptionRow, trailingMenuRows } from "./prompt-select";

// Rows under the bottom border. A custom `statusLine` command prints as many rows as the user wrote,
// so this matches the Claude reader's ceiling (claude/chrome.ts MAX_STATUS_LINES).
const MAX_STATUS_LINES = 8;
const MAX_DRAFT_LINES = 100;
const PROMPT_REGEX = /^[❯›>]\s*/;
const ESC_TO_CANCEL = /\besc(?:ape)?\s+to\s+cancel\b/i;

// What a dialog paints under its rule and a status line never does: a footer hint, `esc to cancel`,
// or a numbered menu (rows 1., 2. …, as `trailingMenuRows` reads one). Idle and working composers
// print `? for shortcuts` under the box (every capture in the corpus), so any of these under a rule
// means that rule belongs to a modal. One numbered item alone is not enough: a custom `statusLine`
// may print `1. build ok  2. tests ok` (claude-lab--statusline-numbered-rows--w82.txt), and that is
// still a live box.
function dialogUnder(texts: string[], bottomBorder: number, end: number): boolean {
  const options: { n: number }[] = [];
  for (let j = bottomBorder + 1; j < end; j++) {
    const text = texts[j]!;
    if (classifyFooter(text) !== null || ESC_TO_CANCEL.test(text)) return true;
    const option = parseOptionRow(text);
    if (option !== null) options.push(option);
  }
  return trailingMenuRows(options).length >= 2;
}

export interface LocatedBox {
  top: number;
  prompt: number;
  bottomBorder: number;
  statusEnd: number;
  /** First row of the status run when something (the completion popup) sits between the bottom
   *  border and it; absent = the row after the bottom border. */
  statusFrom?: number;
  draft: string | null;
}

/**
 * The box at the tail, with the slash-completion popup PEELED first: agy paints that popup between
 * the bottom border and the status row, taller than the MAX_STATUS_LINES window the walk allows, so
 * without the peel a `/mo` draft would read as "no box" and the composer would refuse to type. The
 * peel is confirmed, not assumed — the box it yields must hold a draft starting with "/", the only
 * state in which agy shows the popup; otherwise the walk runs unchanged from `end`.
 */
export function locateInputBox(texts: string[], end: number): LocatedBox | null {
  const popup = findAutocompleteRun(texts, end);
  if (popup !== null) {
    const box = walkInputBox(texts, popup.start);
    if (box !== null && box.draft !== null && box.draft.startsWith("/")) {
      return { ...box, statusEnd: end, statusFrom: popup.footer + 1 };
    }
  }
  return walkInputBox(texts, end);
}

function walkInputBox(texts: string[], end: number): LocatedBox | null {
  if (end === 0) return null;
  let bot = end - 1;
  while (bot >= 0 && isBlank(texts[bot]!)) bot--;
  if (bot < 0) return null;

  // 1. Look for bottom border within MAX_STATUS_LINES from the tail (allowing status/hint lines below)
  let bottomBorder = -1;
  let statusEnd = end;
  for (let s = 0; s <= MAX_STATUS_LINES && bot - s >= 0; s++) {
    const idx = bot - s;
    if (isBoxBorder(texts[idx]!)) {
      bottomBorder = idx;
      break;
    }
  }

  // The window is wide enough (8 rows) to reach the rule under a dialog's `Question` label. A short
  // `select-menu` dialog (one real option and a write-in) puts that rule inside it, and the echoed
  // user message `> …` above it then reads as an idle prompt. A modal under the rule, or a prompt
  // grammar claiming the screen, means no composer: fail closed, like step 2.
  if (bottomBorder !== -1 && (dialogUnder(texts, bottomBorder, end) || detectPromptSelectRegionIn(texts) !== null)) {
    return null;
  }

  if (bottomBorder !== -1) {
    let p = bottomBorder - 1;
    let walk = 0;
    while (p >= 0 && walk < MAX_DRAFT_LINES) {
      const t = texts[p]!;
      if (isBoxBorder(t)) return null;
      if (PROMPT_REGEX.test(t)) {
        let top = p - 1;
        while (top >= 0 && isBlank(texts[top]!)) top--;
        if (top >= 0 && isBoxBorder(texts[top]!)) {
          let head = t.replace(PROMPT_REGEX, "").trim();
          const parts = [head];
          for (let j = p + 1; j < bottomBorder; j++) {
            const cont = texts[j]!.trim();
            if (cont.length > 0) parts.push(cont);
          }
          const draft = parts.join(" ").trim() || null;
          return { top, prompt: p, bottomBorder, statusEnd, draft };
        }
      }
      p--;
      walk++;
    }
  }

  // 2. No fallback. AGY's composer is ALWAYS boxed — a top rule, the `>` row, a bottom rule, then
  // the `? for shortcuts …` status row (every capture in the corpus). A bare `>` row with nothing
  // anchoring it is a TRANSCRIPT row, not a composer: AGY echoes each submitted message as `> …`
  // and paints its ask_user_question selection the same way (see agy--done.txt). Claiming those
  // would report a live composer over a busy agent, hand the echo back as the operator's draft, and
  // authorise a reply the pane cannot receive. Failing closed costs a refused send; failing open
  // types into a running turn.
  return null;
}

export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  const box = locateInputBox(texts, end);
  if (box !== null) {
    end = box.top;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return [];

  const box = locateInputBox(texts, end);
  if (box === null) return [];

  const rows: StyledLine[] = [];
  for (let j = box.statusFrom ?? box.bottomBorder + 1; j < box.statusEnd; j++) {
    if (!isBlank(texts[j]!)) rows.push(lines[j]!);
  }
  return rows;
}

export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;
  const box = locateInputBox(texts, end);
  return box?.draft ?? null;
}

export function hasInputBox(lines: StyledLine[]): boolean {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return false;
  return locateInputBox(texts, end) !== null;
}
