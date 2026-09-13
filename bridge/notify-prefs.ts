import type { JsonObject, JsonValue } from "./json.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { AgentStatus } from "./types.ts";

// Which agent lifecycle events are worth a push. A companion to Snooze (the do-not-disturb deadline):
// where Snooze mutes everything for a while, this decides which *kinds* of alert ever fire. By default
// only "agent needs your input" (blocked) pushes; a "done" push is off — most people don't want a buzz
// for every completed task. Bridge-wide (not per-device), like Snooze, because a push fans out to
// every subscribed device. Persisted to the state dir so a preference survives the `systemctl restart`
// that backend changes require. Missing file / missing keys fall back to defaults.
//
// ── PER-PANE RULES (fork) ──────────────────────────────────────────────────────
// The bridge-wide switches are the DEFAULT; a pane can override them. Four long-lived listener panes
// on one machine are the case: one of them blocks on a permission prompt every few minutes as part of
// its normal work, and a phone that buzzes for every one of those trains its owner to ignore the buzz
// that matters. A rule names the pane two ways — its id, which is exact but dies with the multiplexer
// restart that renumbers panes, and a label, which survives the restart because the operator's own
// name for the pane (or its tab, or its space) comes back with it. The id wins when both match.

/** How a rule changes the bridge-wide switches for the panes it names. */
export type PaneNotifyMode =
  /** Follow the switches above (the rule exists only to carry a snooze). */
  | "default"
  /** Push on every notifiable status, whatever the switches say. */
  | "all"
  /** Push only when the pane needs input. */
  | "blocked"
  /** Never push for this pane. */
  | "mute";

export const PANE_NOTIFY_MODES: readonly PaneNotifyMode[] = ["default", "all", "blocked", "mute"];

/** One pane's override. At least one of `paneId` / `label` names the pane it applies to. */
export interface PaneNotifyRule {
  /** Exact pane id on this bridge. Unstable across a multiplexer restart — that is what `label` is for. */
  paneId?: string;
  /** Case-insensitive substring matched against the pane's own label, its tab, its space and its
   *  terminal title, in that order. */
  label?: string;
  mode: PaneNotifyMode;
  /** A quiet deadline for this pane alone (epoch ms). Elapsed means not snoozed; never pruned, so a
   *  rule that was only a snooze keeps its `default` mode and simply stops mattering. */
  snoozedUntil?: number;
}

/** Notification type preferences: which notifiable statuses actually push. */
export interface NotifyPrefs {
  /** Push when an agent becomes blocked (waiting on your input). Default on. */
  blocked: boolean;
  /** Push when an agent finishes its task. Default off. */
  done: boolean;
  /** Push when a newer Collie release is available. Default on — the off-switch for update alerts,
   *  which otherwise bypass snooze (an update isn't quiet-hours material). Not an agent status, so it
   *  never flows through {@link isNotifiable}; the update monitor reads it directly. */
  updates: boolean;
  /** Per-pane overrides, first match wins within each of the two match kinds (id before label). */
  panes: PaneNotifyRule[];
  /**
   * FORK: the operator's rules from `notify.toml` (bridge/operator-notify.ts), matched AFTER
   * `panes` so a phone-set rule wins for the same pane. Read-only on the wire and never persisted
   * here — the file is their home. Present only when the file has rules, so an install without one
   * answers byte-identically to before.
   */
  operatorPanes?: PaneNotifyRule[];
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { blocked: true, done: false, updates: true, panes: [] };

/** The pane facts a rule is matched against — the slice of an `AgentView` that names it. */
export interface PaneIdentity {
  paneId: string;
  paneLabel?: string;
  tabLabel?: string;
  workspaceLabel?: string;
  terminalTitle?: string;
}

/** The longest label a rule may carry — a pattern, not a paragraph. */
const LABEL_MAX = 120;
/** How many rules the file will hold; a phone's settings list is the only writer. */
const RULES_MAX = 64;

function isMode(v: JsonValue | undefined): v is PaneNotifyMode {
  return typeof v === "string" && PANE_NOTIFY_MODES.some((m) => m === v);
}

/** One rule off an untrusted value, or null when it names no pane or has no valid mode. */
export function coercePaneRule(raw: JsonValue | undefined): PaneNotifyRule | null {
  if (typeof raw !== "object" || raw === null || raw === undefined || Array.isArray(raw)) return null;
  const o: JsonObject = raw;
  if (!isMode(o.mode)) return null;
  const rule: PaneNotifyRule = { mode: o.mode };
  if (typeof o.paneId === "string" && o.paneId !== "" && o.paneId.length <= LABEL_MAX) rule.paneId = o.paneId;
  const label = typeof o.label === "string" ? o.label.trim().slice(0, LABEL_MAX) : "";
  if (label !== "") rule.label = label;
  if (rule.paneId === undefined && rule.label === undefined) return null;
  if (typeof o.snoozedUntil === "number" && Number.isFinite(o.snoozedUntil) && o.snoozedUntil > 0) {
    rule.snoozedUntil = o.snoozedUntil;
  }
  return rule;
}

/** The rules off an untrusted value: not an array, or an array of junk, is no rules at all. */
export function coercePaneRules(raw: JsonValue | undefined): PaneNotifyRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: PaneNotifyRule[] = [];
  for (const item of raw) {
    const rule = coercePaneRule(item);
    if (rule !== null) rules.push(rule);
    if (rules.length >= RULES_MAX) break;
  }
  return rules;
}

/**
 * Coerce an untrusted parsed value into a {@link NotifyPrefs}, filling any missing or non-boolean key
 * from the defaults. Pure + exported so the file-shape handling is unit-testable.
 */
export function coerceNotifyPrefs(raw: JsonValue | undefined): NotifyPrefs {
  const o: JsonObject =
    typeof raw === "object" && raw !== null && raw !== undefined && !Array.isArray(raw) ? raw : {};
  return {
    blocked: typeof o.blocked === "boolean" ? o.blocked : DEFAULT_NOTIFY_PREFS.blocked,
    done: typeof o.done === "boolean" ? o.done : DEFAULT_NOTIFY_PREFS.done,
    updates: typeof o.updates === "boolean" ? o.updates : DEFAULT_NOTIFY_PREFS.updates,
    panes: coercePaneRules(o.panes),
  };
}

/**
 * Validate an untrusted `/api/notifications/prefs` body into a partial patch. The three switches must
 * be booleans when present; `panes`, when present, must be an array and REPLACES the rule list whole
 * (a phone edits the list it was shown, so a merge would have nothing to merge against). A rule that
 * names no pane or carries an unknown mode is dropped rather than refused — the list is the phone's
 * own and one bad row must not cost the others. Unknown keys are ignored; an empty patch is a valid
 * no-op that echoes the current prefs. Null → 400.
 */
export function parseNotifyPrefsPatch(v: JsonValue | undefined): Partial<NotifyPrefs> | null {
  if (typeof v !== "object" || v === null || v === undefined || Array.isArray(v)) return null;
  const o: JsonObject = v;
  const patch: Partial<NotifyPrefs> = {};
  for (const key of ["blocked", "done", "updates"] as const) {
    if (!(key in o)) continue;
    const value = o[key];
    if (typeof value !== "boolean") return null;
    patch[key] = value;
  }
  if ("panes" in o) {
    if (!Array.isArray(o.panes)) return null;
    patch.panes = coercePaneRules(o.panes);
  }
  return patch;
}

/** The rule that applies to `pane`: an exact id match first, then the first label match. */
export function ruleFor(rules: readonly PaneNotifyRule[], pane: PaneIdentity): PaneNotifyRule | null {
  for (const rule of rules) if (rule.paneId !== undefined && rule.paneId === pane.paneId) return rule;
  const haystack = [pane.paneLabel, pane.tabLabel, pane.workspaceLabel, pane.terminalTitle]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .map((s) => s.toLowerCase());
  if (haystack.length === 0) return null;
  for (const rule of rules) {
    if (rule.label === undefined) continue;
    const needle = rule.label.toLowerCase();
    if (haystack.some((h) => h.includes(needle))) return rule;
  }
  return null;
}

export class NotifyPrefsStore {
  private prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, panes: [] };
  private readonly file: string;
  /** FORK: the last rules `operatorRules` answered with — what the sync `isNotifiable` reads. */
  private operator: PaneNotifyRule[] = [];

  constructor(
    private readonly cfg: Config,
    private readonly now: () => number = Date.now,
    /** FORK: the operator's `notify.toml` reader; absent means no file (the tests' default). */
    private readonly operatorRules?: () => Promise<PaneNotifyRule[]>,
  ) {
    this.file = join(cfg.stateDir, "notify-prefs.json");
  }

  /**
   * FORK: re-read `notify.toml` (behind the reader's own mtime check, so this is a stat when nothing
   * changed). Called at boot, on a timer, and before the prefs are answered to a phone — the matcher
   * itself stays synchronous on the cached list. A reader that throws keeps the last list.
   */
  async refreshOperatorRules(): Promise<void> {
    if (this.operatorRules === undefined) return;
    try {
      this.operator = structuredClone(await this.operatorRules());
    } catch {
      /* the last good list stands — the reader already warned */
    }
  }

  async load(): Promise<void> {
    try {
      this.prefs = coerceNotifyPrefs(await Bun.file(this.file).json());
    } catch {
      /* none saved yet — keep defaults */
    }
  }

  /** A copy of the current prefs (never the internal object, so callers can't mutate our state). */
  current(): NotifyPrefs {
    const view: NotifyPrefs = { ...this.prefs, panes: this.prefs.panes.map((r) => ({ ...r })) };
    if (this.operator.length > 0) view.operatorPanes = this.operator.map((r) => ({ ...r }));
    return view;
  }

  /**
   * Whether a transition into `status` should notify, per the current prefs. Any status that isn't a
   * notifiable kind (idle/working/unknown) is always false — mirrors the coordinator's old static set.
   *
   * With `pane`, the pane's own rule is consulted first: a snoozed pane never notifies, a muted one
   * never, a `blocked` one only for blocked, an `all` one for every notifiable status, and `default`
   * (or no rule) falls through to the switches. Without `pane` — a caller that predates the rules —
   * only the switches speak.
   */
  isNotifiable(status: AgentStatus, pane?: PaneIdentity): boolean {
    if (status !== "blocked" && status !== "done") return false;
    // FORK: the phone's rules first, then the file's — `ruleFor` keeps that order within each kind.
    const rule = pane === undefined ? null : ruleFor([...this.prefs.panes, ...this.operator], pane);
    if (rule !== null) {
      if (rule.snoozedUntil !== undefined && rule.snoozedUntil > this.now()) return false;
      if (rule.mode === "mute") return false;
      if (rule.mode === "blocked") return status === "blocked";
      if (rule.mode === "all") return true;
    }
    if (status === "blocked") return this.prefs.blocked;
    return this.prefs.done;
  }

  /** Merge a partial patch (only booleans are applied; `panes` replaces), persist, and return the
   *  updated prefs. */
  async set(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
    // `Partial<NotifyPrefs>` already types each key `boolean | undefined`, so presence IS the test.
    if (patch.blocked !== undefined) this.prefs.blocked = patch.blocked;
    if (patch.done !== undefined) this.prefs.done = patch.done;
    if (patch.updates !== undefined) this.prefs.updates = patch.updates;
    if (patch.panes !== undefined) this.prefs.panes = patch.panes.map((r) => ({ ...r }));
    await this.save();
    return this.current();
  }

  /** Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target. */
  private async save(): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.prefs, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
