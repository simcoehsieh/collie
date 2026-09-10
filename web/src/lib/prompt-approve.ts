import { buildBlocks } from "./harness";
import { parseAnsi } from "./ansi";
import { splitLines, type PromptOption } from "./blocks";
import type { PromptModel } from "./harness/prompt-model";

// A single-choice dialog that a plain "Yes" or "No" answers — the one shape a notification button
// or a dashboard row may answer WITHOUT showing the operator the dialog itself. Everything here is a
// pure function over a `PromptModel` the pane's own harness grammar produced, so the keystrokes a
// button sends are BY CONSTRUCTION the ones the tappable option in the pane view sends: this file
// picks an option, it never invents a key.
//
// What counts as yes/no is deliberately narrow. A permission prompt ("Do you want to proceed?" →
// Yes / Yes, and don't ask again / No), a folder-trust prompt (Yes, I trust this folder / No, exit)
// and a plan approval (Yes, and use auto mode / Yes, manually approve edits / No, refine…) all are;
// an AskUserQuestion pick (Red / Green / Blue) is not, and neither is a dialog whose feedback row
// has focus — every digit is text there, and the pane view locks its own buttons for the same
// reason (lib/prompt-action.ts).

/** The two options a yes/no dialog resolves to, with the model they were read from. */
export interface BinaryChoice {
  yes: PromptOption;
  no: PromptOption;
}

const YES = /^yes\b/i;
const NO = /^no\b/i;
/**
 * A Yes that ALSO changes what happens next time — "don't ask again", "auto mode", "allow all edits
 * this session". Never the one a blind button should press while a plainer Yes is on the menu: the
 * operator tapped "Yes" to this one prompt, not to every prompt after it. Mirrors the bridge's own
 * coarse check (bridge/prompt-peek.ts) so the two agree on which Yes a button means.
 */
const STICKY_YES = /don.t ask|do not ask|auto.?accept|auto mode|allow all|always|this session/i;

/** The plain Yes and the No of `prompt`, or null when it is not a yes/no dialog (or is not safe to
 *  answer blind right now). */
export function binaryChoice(prompt: PromptModel): BinaryChoice | null {
  if (prompt.feedback?.focused) return null;
  const yesOptions = prompt.options.filter((o) => YES.test(o.label));
  const no = prompt.options.find((o) => NO.test(o.label));
  if (yesOptions.length === 0 || no === undefined) return null;
  const yes = yesOptions.find((o) => !STICKY_YES.test(o.label)) ?? yesOptions[0]!;
  return { yes, no };
}

/**
 * The prompt-select dialog at the tail of a pane's text, derived through the pane's agent's own
 * grammar — the same `parseAnsi → splitLines → buildBlocks` pipeline the mirror renders with, so a
 * button and the mirror can only ever disagree about a screen one of them has not seen. Null when
 * the agent has no grammar or its tail is not a single-choice dialog.
 */
export function promptAtTail(text: string, agent: string | undefined): PromptModel | null {
  const blocks = buildBlocks(splitLines(parseAnsi(text)), { agent });
  const block = blocks.find((b) => b.kind === "prompt-select");
  return block === undefined ? null : block.prompt;
}
