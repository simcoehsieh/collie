import type { AgentView, PaneNotifyMode, PaneNotifyRule } from "./types";

// FORK: the phone's half of per-pane notification rules — which rule the bridge WILL apply to a
// pane (a mirror of bridge/notify-prefs.ts `ruleFor`, so the settings list shows the truth), and
// the edits the list makes to the rule set. Pure; the hook posts the result.

/** The rule that applies to `pane`: an exact id match first, then the first label match — the
 *  bridge's own order, restated so the list and the bridge cannot disagree about a row. */
export function ruleFor(rules: readonly PaneNotifyRule[], pane: AgentView): PaneNotifyRule | null {
  for (const rule of rules) if (rule.paneId !== undefined && rule.paneId === pane.paneId) return rule;
  const haystack = [pane.paneLabel, pane.tabLabel, pane.workspaceLabel, pane.terminalTitle]
    .filter((s): s is string => s !== undefined && s !== "")
    .map((s) => s.toLowerCase());
  if (haystack.length === 0) return null;
  for (const rule of rules) {
    if (rule.label === undefined) continue;
    const needle = rule.label.toLowerCase();
    if (haystack.some((h) => h.includes(needle))) return rule;
  }
  return null;
}

/**
 * The name a new rule carries so it outlives the pane id: the operator's own label for the pane
 * when there is one, else the SPACE. Not the tab (four listener panes all sit on a tab called
 * "claude") and not the terminal title (it changes with every task the agent takes on).
 */
export function stableLabel(pane: AgentView): string | undefined {
  return pane.paneLabel || pane.workspaceLabel || undefined;
}

/** Whether a rule names the pane by id — the one it was created from, as opposed to a label hit. */
export function ownRule(rules: readonly PaneNotifyRule[], pane: AgentView): PaneNotifyRule | null {
  return rules.find((r) => r.paneId !== undefined && r.paneId === pane.paneId) ?? null;
}

/** Whether a rule carries a snooze that has not elapsed. */
export function ruleSnoozed(rule: PaneNotifyRule | null, now = Date.now()): boolean {
  return rule !== null && rule.snoozedUntil !== undefined && rule.snoozedUntil > now;
}

/** A rule that says nothing — `default` mode and no live snooze — is a rule to delete, not keep. */
function isNoop(rule: PaneNotifyRule, now: number): boolean {
  return rule.mode === "default" && !(rule.snoozedUntil !== undefined && rule.snoozedUntil > now);
}

/** The rule list with `pane`'s own rule set to `mode` (created when absent, dropped when it would
 *  say nothing). A label hit on another rule is left alone: the pane gets a rule of its own. */
export function withMode(
  rules: readonly PaneNotifyRule[],
  pane: AgentView,
  mode: PaneNotifyMode,
  now = Date.now(),
): PaneNotifyRule[] {
  const own = ownRule(rules, pane);
  const next: PaneNotifyRule = own ? { ...own, mode } : { paneId: pane.paneId, mode };
  if (!own) {
    const label = stableLabel(pane);
    if (label !== undefined) next.label = label;
  }
  const rest = rules.filter((r) => r !== own);
  return isNoop(next, now) ? rest : [...rest, next];
}

/** The rule list with `pane`'s own rule snoozed until `until` (null resumes). */
export function withSnooze(
  rules: readonly PaneNotifyRule[],
  pane: AgentView,
  until: number | null,
  now = Date.now(),
): PaneNotifyRule[] {
  const own = ownRule(rules, pane);
  const next: PaneNotifyRule = own ? { ...own } : { paneId: pane.paneId, mode: "default" };
  if (!own) {
    const label = stableLabel(pane);
    if (label !== undefined) next.label = label;
  }
  if (until === null || until <= now) delete next.snoozedUntil;
  else next.snoozedUntil = until;
  const rest = rules.filter((r) => r !== own);
  return isNoop(next, now) ? rest : [...rest, next];
}

/** The rule list without `rule`. */
export function without(rules: readonly PaneNotifyRule[], rule: PaneNotifyRule): PaneNotifyRule[] {
  return rules.filter((r) => r !== rule);
}

/** Rules that name no pane currently in `panes` — left over from a pane that closed, or a label rule
 *  nothing matches right now. Listed so they can be seen and removed. */
export function orphanRules(rules: readonly PaneNotifyRule[], panes: readonly AgentView[]): PaneNotifyRule[] {
  const claimed = new Set<PaneNotifyRule>();
  for (const pane of panes) {
    const hit = ruleFor(rules, pane);
    if (hit !== null) claimed.add(hit);
  }
  return rules.filter((r) => !claimed.has(r));
}
