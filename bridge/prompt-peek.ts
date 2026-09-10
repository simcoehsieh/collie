import { normalizePromptRegion } from "./prompt-binding.ts";

// A coarse look at a blocked pane's tail, asked ONE question: is the dialog sitting there one a
// person could answer with a plain Yes or No? The answer decides whether the push for that pane
// carries the two notification action buttons (web/src/sw.ts) — and nothing else. The phone's own
// harness grammar (web/src/lib/harness/claude/prompt-select.ts) is what actually derives the
// keystroke at tap time, from a FRESH read, bound to the region it read; this detector never picks a
// key. So a false positive here costs one tap that falls back to opening the pane, and a false
// negative costs the buttons — which is the right asymmetry for a check that runs on the bridge,
// which has no grammar and should not grow one.
//
// The shape it looks for is Claude Code's numbered single-choice menu directly above a footer hint:
//
//     Do you want to proceed?
//     ❯ 1. Yes
//       2. Yes, and don't ask again for: mkfifo fixture-fifo *
//       3. No
//
//     Esc to cancel · Tab to amend · ctrl+e to explain
//
// "Directly above" is the false-positive guard shared with the web grammar: a menu the agent has
// scrolled past has real output beneath it, and the trailing numbered run then sits too far from the
// end of the buffer to count.

/** A numbered menu row, with or without the `❯` pointer. Same shape as the web grammar's OPTION_ROW. */
const OPTION_ROW = /^(?:❯\s*)?(\d+)\.\s+(.+)$/;

/** How many non-blank lines may follow the last option: the footer, and at most a hint line or two
 *  a dialog wraps under its rows ("shift+tab to approve with this feedback"). */
const TAIL_SLACK = 4;
/** How far up the tail to look for the menu — a dialog's options never span more than this. */
const LOOKBACK = 40;

/**
 * What a notification button needs in order to answer WITHOUT the app: the keystrokes for the
 * plain Yes and for the No, and the dialog's own text to bind them to. The service worker sends
 * these verbatim (`POST /api/pane/:id/keys` with `expected_prompt: region`), and the bridge's
 * prompt binding refuses the keys unless that region is still at the tail of a FRESH read
 * (bridge/prompt-binding.ts) — so a dialog that moved on between the push and the tap is never
 * answered, and the tap falls back to opening the pane.
 *
 * It rides in the push payload's `data`, which Apple caps at 4 KB with the rest of the payload, so
 * `region` is bounded: the menu and its question always, the subject above them as far as the
 * budget allows. `yes`/`no` are key NAMES in the shape `/api/pane/:id/keys` takes — the same
 * recipe the phone's grammar uses for the same dialog (web/src/lib/harness/prompt-model.ts: a
 * digit alone for a permission / trust / plan dialog, digit-then-Enter for a "select" one).
 */
export interface BinaryPromptPeek {
  /** The keystrokes that answer Yes — the plain one, not "and don't ask again". */
  yes: string[];
  /** The keystrokes that answer No. */
  no: string[];
  /** The dialog's on-screen text (SGR stripped, blank lines dropped), footer last. */
  region: string;
}

/** The most `region` may weigh on the wire — leaves room for the rest of a 4 KB payload. */
const REGION_MAX_BYTES = 1500;
/** Lines of subject to try to keep above the question, budget permitting. */
const SUBJECT_LINES = 12;

/** Claude's "select" family confirms on Enter after the digit; every other footer confirms on the
 *  digit alone — the same split web/src/lib/harness/claude/markers.ts `classifyFooter` draws. */
function keysFor(n: number, footer: string[]): string[] {
  const digit = String(n);
  return footer.some((l) => /\benter to select\b/i.test(l)) ? [digit, "Enter"] : [digit];
}

const YES = /^yes\b/i;
const NO = /^no\b/i;
/** A Yes that also changes future behaviour — never the one a notification button should press
 *  when a plainer Yes is on the menu. Mirrors web/src/lib/prompt-approve.ts. */
const STICKY_YES = /don.t ask|do not ask|auto.?accept|auto mode|allow all|always|this session/i;

/**
 * The plain Yes and the No of a Claude-shaped menu at the tail of `text` (SGR escapes tolerated), or
 * null when the tail is not such a menu, or the menu is not a yes/no one (an AskUserQuestion pick).
 */
export function peekBinaryPrompt(text: string): BinaryPromptPeek | null {
  const lines = normalizePromptRegion(text);
  if (lines.length === 0) return null;
  const from = Math.max(0, lines.length - LOOKBACK);
  // Every numbered row in the window, in order.
  const rows: { at: number; n: number; label: string }[] = [];
  for (let i = from; i < lines.length; i++) {
    const m = OPTION_ROW.exec(lines[i]!.trim());
    if (m) rows.push({ at: i, n: Number(m[1]), label: m[2]!.trim() });
  }
  if (rows.length === 0) return null;
  // The menu is the maximal SUFFIX numbered 1..m; a plan body's own "1./2./3." steps sit above it.
  let start = rows.length - 1;
  while (start > 0 && rows[start - 1]!.n === rows[start]!.n - 1) start--;
  const menu = rows.slice(start);
  if (menu[0]!.n !== 1 || menu.length < 2) return null;
  // Tail invariant: only the footer (and a hint line or two) may follow the last option.
  if (lines.length - 1 - menu[menu.length - 1]!.at > TAIL_SLACK) return null;

  const yesRows = menu.filter((r) => YES.test(r.label));
  const noRow = menu.find((r) => NO.test(r.label));
  if (yesRows.length === 0 || noRow === undefined) return null;
  const yes = yesRows.find((r) => !STICKY_YES.test(r.label)) ?? yesRows[0]!;
  const footer = lines.slice(menu[menu.length - 1]!.at + 1);

  // The region, built upward from the footer: the menu and everything after it are the floor, then
  // the question and as much subject as the budget holds — whole lines only, because the binding
  // compares lines exactly.
  const first = menu[0]!.at;
  const floor = lines.slice(first);
  let bytes = Buffer.byteLength(floor.join("\n"), "utf8");
  let top = first;
  for (let i = first - 1; i >= Math.max(0, first - SUBJECT_LINES); i--) {
    const cost = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (bytes + cost > REGION_MAX_BYTES) break;
    bytes += cost;
    top = i;
  }
  return { yes: keysFor(yes.n, footer), no: keysFor(noRow.n, footer), region: lines.slice(top).join("\n") };
}
