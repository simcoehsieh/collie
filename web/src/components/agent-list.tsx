import { memo } from "react";
import { Check, WifiOff } from "lucide-react";

import { clockTime } from "@/lib/format";
import { useMuxCapability } from "@/lib/mux-capability";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { PaneRowsSkeleton } from "@/components/route-skeleton";
import { EmptyState } from "@/components/empty-state";
import { groupPanesByWorkspace } from "@/lib/pane-groups";
import { bucketOf, sectionHeaderProps, triage, type TriageKey } from "@/lib/triage";
import type { AgentView, BridgeStatus } from "@/lib/types";
import { paneRowKey } from "@/lib/hosts";
import { AgentCard } from "./agent-card";
import { t, tn } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface AgentListProps {
  agents: AgentView[];
  /**
   * Bare shell panes. They join their own workspace's group, after that tab's agents — a shell is a
   * pane of the tab it sits in, not a species that deserves a pen of its own (lib/pane-groups.ts).
   * Omit and the list is agents alone, exactly as it was.
   */
  shellPanes?: AgentView[];
  bridge?: BridgeStatus | undefined;
  /**
   * Open a row. Takes the PANE, not its id: `w1:p1` names a different terminal on every machine in a
   * crew, and this list is one herd across all of them — an id alone cannot say which row was tapped.
   */
  onOpen: (pane: AgentView) => void;
  /** Show the "no agents" placeholder when the herd is empty (default true). */
  emptyState?: boolean;
  /**
   * The snapshot on screen is stale — the last fetch failed, or this is a cold boot rendering from the
   * write-through cache. An EMPTY herd then means "we don't know", never "nothing is running", so the
   * placeholder must not claim the latter.
   */
  error?: boolean;
  /** When the stale data was fetched, for the "last seen HH:MM" half of the disconnected placeholder. */
  lastSeenAt?: number;
  /** FORK: pane ids pinned to the top, in the operator's order (hooks/use-dash-prefs.ts). Omit to
   *  render the plain triage — the sidebar and the palette never pin. */
  pinned?: readonly string[];
  /** FORK: a long press on a row — the dashboard opens its pin sheet. Omitted elsewhere. */
  onLongPress?: (pane: AgentView) => void;
}

/** The sections that mean "a human is required here" — pulled to the top and given the accented
 *  header, and now the only ones the dashboard sorts by URGENCY at all. */
/** A module-level empty list: a fresh `[]` default per render is a new reference for nothing. */
const NO_PANES: AgentView[] = [];

const ATTENTION: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);

/** FORK: the sections that sit on top — the urgent two, plus the operator's pins. */
const LIFTED: ReadonlySet<TriageKey> = new Set<TriageKey>(["pinned", "needs", "ready"]);

// The herd in the one order the app agrees on: Needs you → Ready · unseen → Working → Recent
// (lib/triage.ts). Only Recent folds, and only Recent takes the direction toggle; the three
// attention sections are pinned open and never invert.
//
// FORK: a PINNED row is lifted with the urgent ones — the operator asked for it to sit on top, and
// `triage` already pulls it out of its bucket — so it is excluded from the workspace groups below
// and listed exactly once, on the same terms an urgent row is.
export const AgentList = memo(function AgentList({
  agents,
  shellPanes = NO_PANES,
  bridge,
  onOpen,
  emptyState = true,
  error = false,
  lastSeenAt,
  pinned,
  onLongPress,
}: AgentListProps) {
  useLocale();
  // Whether the multiplexer can say which agent a pane holds. Read unconditionally — a hook cannot
  // sit behind the early return below, and the answer is only consulted in the empty branch.
  const agentDetection = useMuxCapability("agentDetection");
  // A herd with nothing but bare shells in it is still something to show, and "No agents running."
  // is then true rather than empty — so the placeholder waits for BOTH lists to be empty.
  if (agents.length === 0 && shellPanes.length === 0) {
    if (!emptyState) return null;
    // "No agents running." is a claim about the herd, and only the bridge can make it. A stale render
    // (failed fetch, or a cold boot with nothing cached) knows nothing about the herd — saying the
    // herd is empty there is the bug this branch exists to prevent, so the outage is named instead.
    // `bridge` is no help on its own: a cached snapshot still says "connected".
    if (error) {
      return (
        // FORK: the app's one empty-state shape. The mark is a glyph and NOT the cat here — a lost
        // connection is a narrower fact than "the app has nothing to show", and the brand has no
        // business presiding over an outage.
        <EmptyState
          mark={<WifiOff className="size-7" />}
          heading={
            lastSeenAt === undefined
              ? t("home.empty.disconnected")
              : t("home.empty.disconnectedAt", { time: clockTime(lastSeenAt) })
          }
          body={t("home.empty.disconnectedBody")}
        />
      );
    }
    // FORK: "waiting for the multiplexer" is not an empty herd, it is an UNKNOWN one — and the
    // shape of what is about to arrive is a list of pane rows. So it gets the list, drawn empty,
    // rather than a sentence that reads like a verdict and a disc that reads like a stall. Three
    // rows because three is the count at which a run reads as a list; the skeleton holds its paint
    // for 120ms (ui/skeleton.tsx), so a bridge that answers immediately never flashes it.
    if (bridge !== "connected") return <PaneRowsSkeleton />;
    // PRESENTATION, not a gate (M10/06). Without `agentDetection` every pane arrives as a shell
    // with an unknown status, so this list is empty on a machine that may be running plenty — and
    // "No agents running." is then a claim the bridge cannot actually make. The adapter's own
    // sentence says why, and the rest says where the panes went, so the dashboard reads as one
    // coherent screen instead of an empty one. On a multiplexer that reports agents (i.e. on Herdr)
    // the body is the plain one.
    const undetected = !agentDetection.capable && agentDetection.note !== "";
    return (
      <EmptyState
        heading={t("home.empty.noAgents")}
        body={
          undetected
            ? `${agentDetection.note} ${t("home.empty.panesHint")}`
            : t("home.empty.body")
        }
      />
    );
  }

  // Two passes over one herd. The attention buckets keep `triage()` exactly as they had it; the
  // rest of the panes leave triage behind entirely and are grouped by workspace, in the order the
  // bridge sent them (which is what `filter` preserves here). That `filter` is the whole of the
  // pulled-out rule: a pane listed on top is never handed to the grouper, so it cannot appear a
  // second time and the group's count never counts it.
  const all = triage(agents, "newest", pinned);
  const pinnedIds = new Set(pinned ?? []);
  const lifted = all.filter((s) => LIFTED.has(s.key) && s.agents.length > 0);
  const groups = groupPanesByWorkspace(
    agents.filter((a) => !ATTENTION.has(bucketOf(a)) && !pinnedIds.has(a.paneId)),
    shellPanes,
  );
  if (lifted.length === 0 && groups.length === 0) return null;
  // "What needs me right now?" deserves an answer even when the answer is "nothing". Without this
  // the section simply doesn't render, and an absence reads the same as a stale load.
  const allClear = all.find((s) => s.key === "needs")!.agents.length === 0;

  // The FULL row identity, not the pane id — see `paneRowKey`. A pane id is unique only within one
  // session on one machine, so a merged or widened list holds several rows that answer to `w1:p1`;
  // keyed by the id alone React recycles one row's element for another's between polls, and the
  // card you are looking at acquires a different row's `onClick`. On this list, that is a tap
  // landing in another terminal.
  const row = (a: AgentView, scope: "herd" | "place", unseen = false, isPinned = false) => (
    <AgentCard
      key={paneRowKey(a)}
      agent={a}
      onClick={() => onOpen(a)}
      scope={scope}
      statusStyle="dot"
      density="row"
      unseen={unseen}
      // FORK: the pin glyph rides the row in the one section a pinned pane can sit in, and the hold
      // opens the pane menu from the dashboard.
      pinned={isPinned}
      {...(onLongPress ? { onLongPress: () => onLongPress(a) } : {})}
    />
  );

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {/* The product of the twenty-times-a-day glance. Rendered with presence, not as a caption:
          you should be able to resolve it one-handed at arm's length without focusing. */}
      {allClear && (
        <p className="flex items-center gap-2 py-1 text-sm font-medium">
          <Check className="size-5 shrink-0 text-status-done" aria-hidden />
          {t("home.allClear")}
        </p>
      )}
      {lifted.map((s) => (
        <section key={s.key} className="flex flex-col gap-2">
          <SectionHeader {...sectionHeaderProps(s)} />
          <ListGroup id={`agent-section-${s.key}`}>
            {s.agents.map((a) => row(a, "herd", s.key === "ready", s.key === "pinned"))}
          </ListGroup>
        </section>
      ))}

      {/* Everything else, by workspace. The heading IS the marker: it names the workspace and counts
          the rows it actually holds, so a row under it says neither. Flat rows in ONE bordered
          group, which gives the run of hairlines a first edge and a last edge for 2px. */}
      {groups.map((g) => (
        <section key={g.key} className="flex flex-col gap-2">
          <SectionHeader
            label={g.label}
            trailing={
              // The count in words rather than in the header's own `(n)` parentheses: this heading
              // is an address, and "3 panes" after it says what the three things ARE — which is the
              // whole reason the list is grouped this way. It counts what is LISTED here, not what
              // the workspace holds: a pane pulled to the top is answered up there.
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {tn("home.workspace.paneCount", g.panes.length)}
              </span>
            }
          />
          <ListGroup>{g.panes.map((p) => row(p, "place"))}</ListGroup>
        </section>
      ))}
    </div>
  );
});
