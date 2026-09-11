// The one ordering the whole app agrees on: what needs you, then what's newly ready, then what's
// running, then everything else by when you last touched it. Used by the dashboard, the in-pane
// sidebar and the command palette — kept in one place so those three can't drift apart (which is
// the job the module this replaces, agent-groups.ts, was written to do).
//
// It runs on the two timestamps the bridge keeps per pane (bridge/activity.ts):
//   lastActiveAt — when the agent last changed status
//   lastSeenAt   — when you last opened or drove it through Collie
import type { AgentStatus, AgentView } from "./types";
import { t } from "./i18n";

/** Which way the Recent section runs. Attention sections never invert. */
export type RecentDir = "newest" | "oldest";

/** FORK: `pinned` is the operator's own section — see {@link triage}'s third argument. */
export type TriageKey = "pinned" | "needs" | "ready" | "working" | "recent";
/** The keys a pane can be CLASSIFIED into — every section but the operator's own. */
export type BucketKey = Exclude<TriageKey, "pinned">;

export interface TriageSection {
  key: TriageKey;
  label: string;
  /** Render the heading in the alert colour (the "needs you" group). */
  accent?: boolean;
  /** Section bullet class — the same status palette the badges use, so a section's colour can't
   *  drift from the status it collects. FORK: its MARK half (`bg-status-X-mark`), because a bullet
   *  is a fill and the text half rasterises to a brown at 8px. See index.css. */
  dot: string;
  /** Whether the user may fold this section away. Attention sections may not: collapsing an alert
   *  defeats the alert. */
  collapsible?: boolean;
  agents: AgentView[];
}

/**
 * An agent that finished while you weren't looking. NOT a stored flag — it's this comparison, which
 * is why opening the pane clears it with no bookkeeping: the read bumps `lastSeenAt` past
 * `lastActiveAt` and the agent falls into Recent on the next poll.
 *
 * Both timestamps absent (an older bridge) yields `false`, so the section is simply empty there.
 */
export function isUnseen(a: AgentView): boolean {
  return a.status === "done" && (a.lastActiveAt ?? 0) > (a.lastSeenAt ?? 0);
}

/** Which section an agent belongs to. The single classifier — {@link triage} and
 *  {@link worstTriage} both route through it, so a list and a chip can't disagree. */
export function bucketOf(a: AgentView): BucketKey {
  if (a.status === "blocked") return "needs";
  if (isUnseen(a)) return "ready";
  if (a.status === "working") return "working";
  return "recent";
}

/** Display order, most urgent first. */
export const TRIAGE_ORDER: readonly TriageKey[] = ["needs", "ready", "working", "recent"];

/**
 * The status one representative {@link StatusDot} should show for a bucket, so a tab chip, a space
 * chip and a list row all draw the same colour for the same meaning.
 */
export const TRIAGE_STATUS = {
  // A pinned row's colour is its own status (the row draws its dot); the section has no colour of
  // its own to advertise, and `idle` is the quietest one to hand a chip that asks anyway.
  pinned: "idle",
  needs: "blocked",
  ready: "done",
  working: "working",
  recent: "idle",
} satisfies Record<TriageKey, AgentStatus>;

/**
 * The most urgent bucket among a set of panes — what a tab or space chip should advertise. Null when
 * the set holds no agent at all, which is deliberately NOT the same as "idle": an empty tab has
 * nothing to report, and showing it a resting dot would claim otherwise.
 */
export function worstTriage(agents: readonly AgentView[]): TriageKey | null {
  let best: number | null = null;
  for (const a of agents) {
    const rank = TRIAGE_ORDER.indexOf(bucketOf(a));
    if (best === null || rank < best) best = rank;
  }
  return best === null ? null : TRIAGE_ORDER[best]!;
}

/** Descending comparator over an optional timestamp; absent sorts last but ties, never throws. */
function byDesc(key: (a: AgentView) => number | undefined) {
  return (x: AgentView, y: AgentView) => (key(y) ?? 0) - (key(x) ?? 0);
}

/** Fresh every call so a caller re-rendering after a `setLocale()` picks up the new language —
 *  see the `useLocale()` note on every component that calls {@link triage} / {@link sectionHeaderProps}. */
function sectionMeta() {
  return {
    pinned: { key: "pinned", label: t("status.section.pinned"), dot: "bg-muted-foreground/40" },
    needs: { key: "needs", label: t("status.section.needsYou"), accent: true, dot: "bg-status-blocked-mark" },
    ready: { key: "ready", label: t("status.section.readyUnseen"), dot: "bg-status-done-mark" },
    working: { key: "working", label: t("status.section.working"), dot: "bg-status-working-mark" },
    recent: { key: "recent", label: t("status.section.recent"), dot: "bg-status-idle-mark", collapsible: true },
  } satisfies Record<TriageKey, Omit<TriageSection, "agents">>;
}

/**
 * Bucket and order a herd. Returns every section (including empty ones) in fixed display order —
 * callers drop the empties, which keeps "which sections exist" a property of this module rather
 * than something each view re-derives.
 *
 * The first three sections are pinned: they never move and never invert. `dir` reaches Recent only.
 *
 * **The old-bridge path is free.** With no timestamps every comparator returns 0, and
 * `Array.prototype.sort` is stable, so each section preserves the order the bridge already sent
 * (`STATUS_RANK → workspaceNumber → paneId`). Ready·unseen is empty because `isUnseen` is false.
 * No feature detection, no branch.
 */
export function triage(
  agents: readonly AgentView[],
  dir: RecentDir = "newest",
  pinned?: readonly string[],
): TriageSection[] {
  const needs: AgentView[] = [];
  const ready: AgentView[] = [];
  const working: AgentView[] = [];
  const recent: AgentView[] = [];

  // FORK: THE PINNED ROWS COME FIRST, IN THE OPERATOR'S ORDER, AND NOWHERE ELSE. Four long-lived
  // panes that shuffle position every time one of them changes status never let muscle memory form;
  // a pin says "this one lives here". A pinned pane is lifted OUT of its bucket, not duplicated —
  // a row that appears twice on one list is a row you tap in the wrong place — and it keeps its own
  // status dot, so "pinned" costs the glance nothing. Pinned ids the herd does not hold are simply
  // skipped (the store prunes them at edit time; see hooks/use-dash-prefs.ts).
  //
  // `bucketOf` is untouched: `worstTriage` and every chip still ask which bucket a pane is IN,
  // and pinning changes where a row is drawn, not what it needs.
  const pinnedRows: AgentView[] = [];
  const lifted = new Set<AgentView>();
  if (pinned !== undefined && pinned.length > 0) {
    const byId = new Map<string, AgentView>();
    for (const a of agents) if (!byId.has(a.paneId)) byId.set(a.paneId, a);
    for (const id of pinned) {
      const a = byId.get(id);
      if (a !== undefined && !lifted.has(a)) {
        pinnedRows.push(a);
        lifted.add(a);
      }
    }
  }

  const into = { needs, ready, working, recent };
  for (const a of agents) if (!lifted.has(a)) into[bucketOf(a)].push(a);

  needs.sort(byDesc((a) => a.lastActiveAt));
  ready.sort(byDesc((a) => a.lastActiveAt));
  working.sort(byDesc((a) => a.lastActiveAt));
  recent.sort(byDesc((a) => a.lastSeenAt));
  if (dir === "oldest") recent.reverse();

  const meta = sectionMeta();
  return [
    // Present only when it has rows: an install that never pinned anything renders exactly the
    // four sections it always did, and callers that filter empties see no new heading either way.
    ...(pinnedRows.length > 0 ? [{ ...meta.pinned, agents: pinnedRows }] : []),
    { ...meta.needs, agents: needs },
    { ...meta.ready, agents: ready },
    { ...meta.working, agents: working },
    { ...meta.recent, agents: recent },
  ];
}

/**
 * The presentation fields a section header needs, in one place. Both the dashboard and the pane
 * switcher spread this rather than picking fields by hand — that's how the dashboard silently ended
 * up without the status-colour bullet the switcher had, and a new field would have done it again.
 */
export function sectionHeaderProps(s: TriageSection) {
  // `accent` is passed through as-is rather than conditionally spread: the prop is optional, so an
  // explicit `undefined` and an absent key are the same thing to the component that destructures it.
  return {
    label: s.label,
    count: s.agents.length,
    dot: s.dot,
    accent: s.accent,
  };
}

/** The other direction — for the toggle. */
export function flipDir(dir: RecentDir): RecentDir {
  return dir === "newest" ? "oldest" : "newest";
}

/** Statuses that put an agent in an attention section (so a caller can tint a row without
 *  re-deriving the rule). */
export function isAttention(status: AgentStatus): boolean {
  return status === "blocked";
}
