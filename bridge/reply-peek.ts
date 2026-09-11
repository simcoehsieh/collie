// FORK — WHAT THE AGENT ACTUALLY SAID, for the push that says it finished.
//
// "claude is done · ai-live · /home/s/git/ai-live" is a notification you have to open to learn
// anything from. The agent's last message almost always opens with the answer — "All 114 tests pass",
// "Blocked: the migration needs a password", "Done; the diff is in three files" — and one line of it
// is the difference between a buzz you act on and a buzz you clear.
//
// BRIDGE-SIDE, AND SHAPED LIKE `prompt-peek.ts` FOR THE SAME REASONS. The phone is asleep when this
// runs, so the only place the journal can be read is here. It is asked ONCE, for a single outstanding
// `done` alert, after the coordinator's debounce has already decided the alert is real — so a herd of
// panes flapping costs no journal reads at all, and a digest ("3 agents done") costs none either.
// A failure is silence: the push goes out with the body it always had.
//
// IT IS PURE. The fs half lives at the call site (bridge/index.ts builds the ref, the store and the
// adapter, exactly as the history route does), so the grammar question this module answers — "which
// turn, and which line of it" — is table-testable with no temp files.

import type { TranscriptEntry } from "./journal/types.ts";

/**
 * How much of the line rides in the push.
 *
 * Apple caps a whole payload at 4 KB and a phone's lock screen shows roughly two lines collapsed, so
 * the budget is the SCREEN's and not the transport's. 120 characters is about two lines at a phone's
 * body size, which is what an operator reads without unlocking.
 */
export const REPLY_PEEK_CHARS = 120;

/** Markdown furniture that carries no words: a heading's hashes, a bullet, a quote, emphasis runs. */
const LEADING_MARKUP = /^[#>\s]*(?:[-*+]\s+|\d+[.)]\s+)?/u;

/**
 * One line of prose out of a turn: the first line that says something.
 *
 * A reply routinely opens with a fenced block, a heading or a bullet, so "the first line" taken
 * literally is often "```" or "## Summary". Lines are walked until one has letters or digits left
 * after its markup is stripped — which is the same "is there content here" test the fold in
 * `web/src/lib/latest-reply.ts` makes, for the same reason.
 */
export function firstProseLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.replace(LEADING_MARKUP, "").replace(/[*_`]+/gu, "").trim();
    if (line === "") continue;
    if (!/[\p{L}\p{N}]/u.test(line)) continue; // a rule, a fence, a row of dashes
    return line.replace(/\s+/gu, " ");
  }
  return "";
}

/**
 * The newest assistant turn's opening line, clamped, or null when there is nothing to say.
 *
 * `null` and not `""` on purpose: the caller has a body it would otherwise send unchanged, and
 * "there is no line" has to be distinguishable from "the line is empty" so it never ships a push
 * whose body is a stray separator.
 */
export function replyFirstLine(
  entries: readonly TranscriptEntry[],
  max: number = REPLY_PEEK_CHARS,
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined || entry.role !== "assistant") continue;
    // Prose only. Thinking is not what the agent said to you, and a tool call is not speech — the
    // same filter `replyProse` applies on the phone.
    const prose = entry.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("\n");
    const line = firstProseLine(prose);
    if (line === "") continue;
    return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
  }
  return null;
}
