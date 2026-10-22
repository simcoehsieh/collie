// The free-text reply: one Send Protocol request (M56 spec 06).
//
// This file used to hold the phone's own race guard for issue #34: a pre-flight read of the pane, a
// type-then-verify loop that polled the screen until the text showed in the input box, a sweep of a
// stranded draft and a settle wait before Enter. All of it lived on the phone because the bridge's old
// reply route typed, waited a fixed 350 ms and pressed Enter blind. The bridge now runs the Send
// Protocol on every text (bridge/surface/protocol.ts): it reads the screen fresh at S0, refuses a
// dialog, a draft or a screen it cannot read before any key, probes where it must, checks the box
// before Enter and answers with a receipt. So the phone reads nothing before a send and sends no key
// of its own. What remains here is the request id, the call and the outcome mapping.
//
// The per-harness draft and status readers stay, for display only: the stranded-draft preview, the
// echo suppression (lib/draft-match.ts) and the status line.

import { postSend } from "./api";
import { describeThrownError } from "./api-error-message";
import { requestIdFor, type IntentId } from "./durable-control";
import { t } from "./i18n";
import { isLive } from "./liveness";
import type { Scope } from "./scope";
import { isCommand, readSend, type SendReading, type SendReply } from "./send-protocol";
import type { SendMode, SendRequestBody } from "./surface/send";
import { mintRequestId } from "./worktree-name";
import { classifySendFailure, type SendFailure } from "./send-failure";

export interface ReplyArgs {
  readonly paneId: string;
  readonly text: string;
  /** Which machine and which named session the pane lives in. */
  readonly scope?: Scope | undefined;
  /** `send`, or `command` for a reserved lead, when absent. An offer names its own mode. */
  readonly mode?: SendMode;
  /** The rows the person saw, for a commit after an `unconfirmed` refusal. */
  readonly rowsHash?: string | null;
  /** The person's extra confirm after the cap's notice (M56 spec 09): true on that commit and no other. */
  readonly capAck?: boolean;
  /** A resend of an ended held row (M56 spec 15): the old request id. The text goes empty; the bridge takes the row's own. */
  readonly resendOf?: string | undefined;
  /** The intent the last tap left without an answer: the same intent keeps its request id. */
  readonly held: IntentId | null;
  /** Test seam for the request id. */
  readonly mint?: () => string;
}

export type SendTextOutcome =
  /** The bridge answered. `reading.clear` is true only on `sent` or `effective`. */
  | { readonly status: "answered"; readonly reply: SendReply; readonly reading: SendReading }
  /**
   * No answer arrived (a dropped link, a timeout, a body the phone cannot read). The intent comes
   * back: the next tap on the same text asks for the same request id, so a lost answer never sends
   * twice.
   */
  | {
      readonly status: "noAnswer";
      readonly error: string;
      readonly intent: IntentId;
      /**
       * FORK: whose failure it was (lib/send-failure.ts): the link's (`network`, `auth`, `server`) or
       * null for anything else. The saved-sends queue (lib/send-queue.ts) keeps a link failure.
       */
      readonly transport: SendFailure | null;
    }
  /**
   * Nothing was asked: the bridge has not answered a read for this pane lately (M46 spec 11), so the
   * screen the person acted on may be old. No queue and no retry: a person sends again once the pane
   * reads live.
   */
  | { readonly status: "refused"; readonly reason: "offline"; readonly error: string };

/** The mode of a text with no offer behind it: a reserved lead is a command, everything else a send. */
export function modeFor(text: string): SendMode {
  return isCommand(text) ? "command" : "send";
}

/** One Send Protocol request for a text, and what its answer means. Never throws. */
export async function sendText(args: ReplyArgs): Promise<SendTextOutcome> {
  // The backstop behind every disabled Send: a UI that slipped through (a stale render, a handler held
  // across an outage) still cannot reach the bridge from a pane it has not just read.
  if (!isLive(args.paneId, args.scope)) {
    return { status: "refused", reason: "offline", error: t("composer.send.reconnect") };
  }
  const mode = args.mode ?? modeFor(args.text);
  const rowsHash = args.rowsHash ?? null;
  const capAck = args.capAck === true;
  // The extra confirm is its own intent: it must not replay the commit the cap refused.
  const resendOf = args.resendOf;
  const intent = requestIdFor(args.held, `${mode}\u0000${rowsHash ?? ""}\u0000${capAck ? "cap" : ""}\u0000${resendOf ?? ""}\u0000${args.text}`, args.mint ?? mintRequestId);
  const body: SendRequestBody = { id: intent.requestId, pane: args.paneId, text: args.text, mode };
  try {
    const reply = await postSend({ ...body, rowsHash: rowsHash ?? undefined, capAck: capAck ? true : undefined, resendOf }, args.scope);
    return { status: "answered", reply, reading: readSend(reply) };
  } catch (e) {
    return { status: "noAnswer", error: describeThrownError(e), intent, transport: classifySendFailure(e) };
  }
}

// ── FORK: THE SAVED-SENDS QUEUE'S SENDER, ON THE SEND PROTOCOL ─────────────────────────────────
//
// The fork keeps a message whose send failed on the LINK (a dropped radio, a lapsed Access session,
// a restarting bridge) and sends it again when a live poll proves the link is back (lib/send-queue.ts,
// components/queued-sends.tsx), and the notes sheet sends its prompt the same way. Both read the
// outcome shape below, which is the one the phone's own guard answered with before upstream 1.22
// moved that guard to the bridge. `blocked` and `stalled` are no longer produced; they stay in the
// type so a row persisted by the old path, and the queue's tests, still read.
//
// Through `sendText`, so the queue's resend is one Send Protocol request like any other: the bridge
// reads the screen fresh, refuses a dialog or a draft, and answers with a receipt.
//
// DELIVERY EVIDENCE (69452bb5). An answer that never arrived after the POST went out is not proof
// that nothing was typed: `possiblyDelivered` holds the row for review instead of repeating it on the
// next healthy poll. An explicit sign-in refusal (`auth`) is the front door's, before the bridge, and
// so known unsent.

export type ReplyOutcome =
  /** The bridge took the text: sent, effective, queued behind the turn, or held by the bridge. */
  | { status: "sent" }
  /** Retired with the phone's own guard (upstream 1.22); never produced, read for old rows and tests. */
  | { status: "blocked"; error: string; noEcho?: string }
  /** Retired with the phone's own guard (upstream 1.22); never produced, read for old rows and tests. */
  | { status: "stalled"; error: string; noEcho?: string }
  /**
   * The bridge refused, or no answer arrived. `transport` names a link failure; `possiblyDelivered`
   * says the POST may have landed. `textDelivered`: the text is in the box unsubmitted
   * (`typed_not_submitted`), so it must not be resent.
   */
  | { status: "error"; error: string; textDelivered?: boolean; transport?: SendFailure; possiblyDelivered?: boolean }
  /** Nothing was asked: the pane has not been read live lately (M46 spec 11). */
  | { status: "refused"; reason: "offline"; error: string };

export interface GuardedReplyArgs {
  paneId: string;
  text: string;
  /** The pane's agent when the send was made. Kept for the callers' rows; the bridge reads its own. */
  agent?: string | null | undefined;
  scope?: Scope | undefined;
  /** Test seam for the request id. */
  mint?: () => string;
}

/** A lost answer in the queue's shape: whose failure it was, and whether the text may have landed. */
export function noAnswerOutcome(res: Extract<SendTextOutcome, { status: "noAnswer" }>): Extract<ReplyOutcome, { status: "error" }> {
  const outcome: Extract<ReplyOutcome, { status: "error" }> = { status: "error", error: res.error };
  if (res.transport !== null) {
    outcome.transport = res.transport;
    // The POST went out: only the front door's own refusal proves the bridge never saw it.
    if (res.transport !== "auth") outcome.possiblyDelivered = true;
  }
  return outcome;
}

/** The same verdict in the queue's shape: what `sendText` answered, mapped. Pure. */
export function guardedOutcome(res: SendTextOutcome): ReplyOutcome {
  if (res.status === "refused") return { status: "refused", reason: res.reason, error: res.error };
  if (res.status === "noAnswer") return noAnswerOutcome(res);
  if (res.reading.clear) return { status: "sent" };
  const error = sendReadingSentence(res.reading.note, res.reading.detail);
  return res.reply.outcome === "typed_not_submitted" ? { status: "error", error, textDelivered: true } : { status: "error", error };
}

/** One Send Protocol request for a queued or noted message, answered in the queue's shape. Never throws. */
export async function sendGuardedReply(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  const res = await sendText({ paneId: args.paneId, text: args.text, scope: args.scope, held: null, mint: args.mint });
  return guardedOutcome(res);
}

/** The refusal in words, for a row's hold: the note's sentence, and the bridge's own line after it. */
function sendReadingSentence(note: SendReading["note"], detail: string | null): string {
  // The cap's sentence carries numbers this row does not hold; its plain reason says the same thing.
  const sentence = t(`composer.protocol.${note === "capConfirm" ? "unconfirmed" : note}`);
  return detail === null ? sentence : `${sentence} ${detail}`;
}
