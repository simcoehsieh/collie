import type { JsonObject } from "./json.ts";
import {
  PANE_NOTIFY_MODES,
  coercePaneRule,
  type PaneNotifyRule,
  type SessionNotifyRule,
} from "./notify-prefs.ts";
import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";

// FORK — the operator's own per-pane notification rules, read from `notify.toml` next to their
// `.env`: the sixth sibling of `commands.toml`, `keys.toml`, `quick-replies.toml`, `theme.toml` and
// `launchers.toml`, read the same way (operator-file.ts owns the mtime cache and the failure posture).
//
// WHY A FILE WHEN THE PHONE ALREADY SETS RULES. The phone's rules live in the state dir, written by
// Settings → Notifications, and they are exactly right for "this pane, today". They are wrong for
// the rule that is part of the INSTALL: four long-lived listener panes whose every completion is a
// scheduled job finishing, which nobody wants a buzz for, on every machine that runs this setup. A
// rule like that belongs in a file the operator can put in a repo, copy to the next machine and
// diff — not in a JSON blob a phone happens to have written once.
//
// PRECEDENCE: the phone's rules win. Both lists are matched by the same `ruleFor` (an exact id
// first, then the first label hit), with the phone's rules ahead of these, so a rule set from
// Settings for a pane overrides the file's rule for the same pane, and the file speaks only where
// the phone said nothing. The phone shows which is which (components/notify-prefs-control.tsx).
//
// ```toml
// [[panes]]
// label = "listener"     # case-insensitive substring of the pane's label, tab, space or title
// mode = "blocked"       # default | all | blocked | mute
//
// [[panes]]
// paneId = "w2:p1"       # exact id — precise, but dies with the next multiplexer restart
// mode = "mute"
//
// [[sessions]]
// session = "dev"        # a whole Herdr session, by its registry name (`app`, `dev`)
// mode = "mute"
// ```
//
// WHY A SESSION ROW. A label is a naming convention, and a convention is only as good as the last
// agent that remembered it: a workspace opened in `dev` as `Tradingview` instead of `aux-…` pushed
// every finished job (2026-10-04). The operator's design is that `dev` holds agents a controller in
// `app` supervises, so nothing in `dev` should reach the phone at all — a fact about the SESSION,
// not about any name inside it. A session row is the most general rule, so it speaks last: a pane
// rule, the phone's or the file's, still wins for the pane it names.

/** A parsed `notify.toml` document, before a byte of it is believed. */
interface NotifyDocument {
  panes?: unknown;
  sessions?: unknown;
}

/**
 * Turn a parsed TOML document into rules, dropping anything malformed with one warning line each.
 * Pure and total, like `validateOperatorLaunchers`: a bad row costs that row, never the file.
 *
 * The row grammar is the phone's own (`coercePaneRule`), so a rule the file can express is exactly
 * a rule the phone could have set — one vocabulary, one matcher. `snoozedUntil` is accepted by the
 * coercer but pointless in a file (a deadline in a file is a typo waiting to be forgotten), so it is
 * stripped here with a warning.
 */
export function validateOperatorNotifyRules(
  doc: NotifyDocument | null | undefined,
  warn = defaultWarn,
): PaneNotifyRule[] {
  const rows = doc?.panes;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    warn("`panes` must be an array of [[panes]] tables — ignoring the file's rules");
    return [];
  }
  const out: PaneNotifyRule[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null || raw === undefined || Array.isArray(raw)) {
      warn("ignoring a row that is not a [[panes]] table");
      continue;
    }
    const row: JsonObject = raw;
    if (typeof row.mode !== "string" || !PANE_NOTIFY_MODES.some((m) => m === row.mode)) {
      warn(`ignoring a row whose mode is not one of ${PANE_NOTIFY_MODES.join(" | ")}: ${JSON.stringify(row.mode)}`);
      continue;
    }
    const rule = coercePaneRule(row);
    if (rule === null) {
      warn(`ignoring a "${row.mode}" row that names no pane — give it a label or a paneId`);
      continue;
    }
    if (rule.snoozedUntil !== undefined) {
      warn(`"${rule.label ?? rule.paneId ?? ""}": snoozedUntil is ignored in notify.toml — snooze from the phone`);
      delete rule.snoozedUntil;
    }
    out.push(rule);
  }
  return out;
}

/** A session's registry name: what `/api/snapshot`'s `sessions[].name` says (`app`, `dev`). */
const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * FORK: the `[[sessions]]` tables — one mode for every pane of a Herdr session. Same posture as the
 * pane rows: a bad row costs that row with one warning line, a later row for the same session is a
 * typo and is dropped (the first one stands, as `ruleFor`'s first label hit does).
 */
export function validateOperatorNotifySessions(
  doc: NotifyDocument | null | undefined,
  warn = defaultWarn,
): SessionNotifyRule[] {
  const rows = doc?.sessions;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    warn("`sessions` must be an array of [[sessions]] tables — ignoring the file's session rules");
    return [];
  }
  const out: SessionNotifyRule[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null || raw === undefined || Array.isArray(raw)) {
      warn("ignoring a row that is not a [[sessions]] table");
      continue;
    }
    const row: JsonObject = raw;
    const mode = PANE_NOTIFY_MODES.find((m) => m === row.mode);
    if (mode === undefined) {
      warn(`ignoring a session row whose mode is not one of ${PANE_NOTIFY_MODES.join(" | ")}: ${JSON.stringify(row.mode)}`);
      continue;
    }
    const session = typeof row.session === "string" ? row.session.trim() : "";
    if (!SESSION_NAME.test(session)) {
      warn(`ignoring a "${mode}" session row whose session is not a session name: ${JSON.stringify(row.session)}`);
      continue;
    }
    if (out.some((r) => r.session === session)) {
      warn(`"${session}": a second [[sessions]] row for the same session is ignored — the first one stands`);
      continue;
    }
    out.push({ session, mode });
  }
  return out;
}

function defaultWarn(message: string): void {
  console.warn(`[notify] ${message}`);
}

/** A reader for the operator's `notify.toml` — literally the same reader `launchers.toml` gets. */
export function createOperatorNotifyRules(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<PaneNotifyRule[]> {
  return createOperatorFileReader(path, validateOperatorNotifyRules, io, warn);
}

/** FORK: the same file, read for its `[[sessions]]` tables (its own mtime cache, same failure posture). */
export function createOperatorNotifySessions(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<SessionNotifyRule[]> {
  return createOperatorFileReader(path, validateOperatorNotifySessions, io, warn);
}
