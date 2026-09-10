import { lineText, type StyledLine } from "@/lib/blocks";

/** A closed Markdown code fence in a run of mirror lines: the line indices of its two ``` rows. */
export interface CodeFence {
  /** The opening ``` line (may carry a language tag: ```sh). */
  open: number;
  /** The closing ``` line. Always > open. */
  close: number;
}

// A fence row is three or more backticks, optionally indented, with nothing but a language tag
// after the OPENING one and nothing after the CLOSING one. The TUI prints Markdown code fences
// verbatim inside an agent's prose (Claude Code, Codex and agy all do), and an indented fence is
// one inside a list item.
const FENCE_ROW = /^\s*(`{3,})\s*(\S*)\s*$/;

/**
 * FORK. The closed code fences of a block, in order, non-overlapping. An opening fence with no
 * close before the end of the block is not reported: the agent is still writing it, and a Copy of
 * half a block is worse than no Copy. A closing row must carry no language tag — ```sh opens, a
 * bare ``` closes — so two consecutive opens do not pair up as one fence.
 */
export function codeFences(lines: readonly StyledLine[]): CodeFence[] {
  const out: CodeFence[] = [];
  let open: { at: number; ticks: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_ROW.exec(lineText(lines[i]!));
    if (!m) continue;
    const ticks = m[1]!.length;
    const tag = m[2]!;
    if (open === null) {
      open = { at: i, ticks };
      continue;
    }
    // CommonMark: a close must be at least as long as its open, and must carry no info string.
    if (tag === "" && ticks >= open.ticks) {
      out.push({ open: open.at, close: i });
      open = null;
    }
  }
  return out;
}
