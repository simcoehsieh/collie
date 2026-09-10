import type { StyledLine } from "../../blocks";
import { isBlank, isBoxBorder, lineText } from "./markers";
import { findAutocompleteRun } from "./autocomplete";

const MAX_STATUS_LINES = 4;
const MAX_DRAFT_LINES = 100;
const PROMPT_REGEX = /^[❯›>]\s*/;

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
  for (let s = 0; s < MAX_STATUS_LINES && bot - s >= 0; s++) {
    const idx = bot - s;
    if (isBoxBorder(texts[idx]!)) {
      bottomBorder = idx;
      break;
    }
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
