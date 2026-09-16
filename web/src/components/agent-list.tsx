import { memo } from "react";
import { Check, WifiOff } from "lucide-react";

import { clockTime } from "@/lib/format";
import { useMuxCapability } from "@/lib/mux-capability";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { PaneRowsSkeleton } from "@/components/route-skeleton";
import { SwipeClose } from "@/components/swipe-close";
import { EmptyState } from "@/components/empty-state";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@/lib/pane-groups";
import { Chip } from "@/components/ui/chip";
import { StatusCounts } from "@/components/status-counts";
import { STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { bucketOf, sectionHeaderProps, triage, worstTriage, type TriageKey } from "@/lib/triage";
import type { AgentView, BridgeStatus, TabView } from "@/lib/types";
import { paneRowKey } from "@/lib/hosts";
import { AgentCard } from "./agent-card";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
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
  /**
   * FORK: close this pane. Given, every row becomes swipe-to-close; omitted, no row is (the sidebar
   * and the palette pass nothing, and a read-only device is handed nothing either, so the gesture
   * does not exist there rather than existing and refusing).
   *
   * Resolves TRUE when the pane is gone. The caller owns the request, its error copy and the
   * revalidate; this list owns none of that and only needs the verdict to decide whether the row
   * springs shut.
   */
  onClosePane?: (pane: AgentView) => Promise<boolean>;
  /** The raw tab list, for the multiplexer's own tab order inside a workspace. */
  tabs?: readonly TabView[];
  /**
   * The workspace filter the strip on top drives, per device (hooks/use-dash-prefs.ts). `isolated`
   * shows one workspace alone; `hidden` drops workspaces from the list while their chips stay in
   * the strip, dimmed, still carrying their status dot, so a hidden workspace that needs you is
   * never silent. Keys from `workspacePrefKey` (machine, session, workspace name). Omit both and the list shows everything.
   */
  isolated?: string | null;
  hidden?: readonly string[];
  /** Tap a chip: isolate that workspace, or clear the filter (null). */
  onIsolate?: (key: string | null) => void;
  /** Long-press a chip: hide the workspace, or show it again. */
  onToggleHidden?: (key: string) => void;
}

/** The sections that mean "a human is required here" — pulled to the top and given the accented
 *  header, and now the only ones the dashboard sorts by URGENCY at all. */
/** A module-level empty list: a fresh `[]` default per render is a new reference for nothing. */
const NO_PANES: AgentView[] = [];
const NO_KEYS: readonly string[] = [];

/** The heading's dot, in the worst URGENT status inside the group; none when quiet. */
function urgentDot(g: WorkspaceGroup): string | undefined {
  const worst = worstTriage(g.panes);
  if (worst === "needs") return "bg-status-blocked";
  return undefined;
}

function urgentCount(g: WorkspaceGroup): number {
  return g.panes.filter((p) => ATTENTION.has(bucketOf(p))).length;
}

/**
 * The key a device REMEMBERS a workspace by, for hide and isolate: its machine, session and NAME.
 * The group key carries Herdr's workspace id, which is opaque and can change when Herdr restarts, so
 * a preference keyed on it would quietly stop applying. The name is the project folder and stays.
 */
export function workspacePrefKey(g: WorkspaceGroup): string {
  const cut = g.key.lastIndexOf("\u0000");
  return `${cut === -1 ? "" : g.key.slice(0, cut)}\u0000${g.label}`;
}

/** A DOM id for a workspace group, so the summary line can scroll to it. */
function groupDomId(key: string): string {
  return `ws-group-${key.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

const ATTENTION: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);

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
  onClosePane,
  tabs,
  isolated = null,
  hidden = NO_KEYS,
  onIsolate,
  onToggleHidden,
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

  // ONE PASS, NOTHING MOVES (2026-09-16, after four arrangements on the phone and a counsel).
  // Every pane stays in its workspace, in the multiplexer's own order: workspaces by number, tabs by
  // number, panes by id. A status change never moves a row or a group, because the operator finds a
  // pane by where it sits, and the urgent sections that used to pull a pane to the top broke exactly
  // that. Urgency is a MARK now, never a position: a full-row wash, a lit heading, a lit chip, and
  // the one summary line. Push and the badge carry the alarm; this screen answers "where".
  //
  // FORK: the ONE exception is a PIN. Upstream's rule is that status never moves a row, and this
  // keeps it: a pin is not a status, it is the operator saying "I am living in this one today", and
  // it is their own hand that put it there. So the pinned section is lifted and `needs` / `ready`
  // are not — they are marks now, exactly as upstream intends. A pinned pane is listed ONCE: it is
  // filtered out of the workspace groups below, so no group counts it twice.
  const all = triage(agents, "newest", pinned);
  const pinnedIds = new Set(pinned ?? []);
  const pinnedSection = all.find((s) => s.key === "pinned");
  const groups = groupPanesByWorkspace(
    agents.filter((a) => !pinnedIds.has(a.paneId)),
    shellPanes,
    { order: "fixed", tabs },
  );
  if (groups.length === 0 && pinnedSection === undefined) return null;
  // A stale key (a workspace since closed) filters nothing: an isolation nobody can see is dropped.
  const isolatedGroup = isolated === null ? undefined : groups.find((g) => workspacePrefKey(g) === isolated);
  const hiddenSet = new Set(hidden);
  const shown = isolatedGroup ? [isolatedGroup] : groups.filter((g) => !hiddenSet.has(workspacePrefKey(g)));
  // Over the WHOLE herd, pinned rows included: lifting a blocked pane into the pinned section must
  // not make the summary line say everything is clear.
  const allClear = !agents.some((a) => ATTENTION.has(bucketOf(a)));
  const firstUrgent = groups.find((g) => urgentCount(g) > 0);
  const jumpTo = (g: WorkspaceGroup) => {
    // The target may be filtered out: isolate it, which is also the scroll.
    if (!shown.includes(g)) {
      onIsolate?.(workspacePrefKey(g));
      return;
    }
    document.getElementById(groupDomId(g.key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // The FULL row identity, not the pane id — see `paneRowKey`. A pane id is unique only within one
  // session on one machine, so a merged or widened list holds several rows that answer to `w1:p1`;
  // keyed by the id alone React recycles one row's element for another's between polls, and the
  // card you are looking at acquires a different row's `onClick`. On this list, that is a tap
  // landing in another terminal.
  // FORK: every row is swipe-to-close when the caller handed one down — a pane the operator is done
  // with is decided HERE, on the list, and the close it used to take was three screens away inside
  // the pane. The wrapper only reveals a button; the button is the two-tap (swipe-close.tsx).
  const row = (a: AgentView, isPinned = false) =>
    onClosePane === undefined ? (
      card(a, isPinned)
    ) : (
      <SwipeClose
        key={paneRowKey(a)}
        label={t("home.close.label")}
        confirmLabel={t("home.close.confirm")}
        closingLabel={t("home.close.closing")}
        onConfirm={() => onClosePane(a)}
      >
        {card(a, isPinned)}
      </SwipeClose>
    );

  const card = (a: AgentView, isPinned = false) => (
    <AgentCard
      key={paneRowKey(a)}
      agent={a}
      onClick={() => onOpen(a)}
      scope="place"
      statusStyle="dot"
      density="row"
      unseen={bucketOf(a) === "ready"}
      tint
      // FORK: the pin glyph rides the row in the one section a pinned pane can sit in, and the hold
      // opens the pane menu from the dashboard.
      pinned={isPinned}
      {...(onLongPress ? { onLongPress: () => onLongPress(a) } : {})}
    />
  );

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {/* THE WORKSPACE STRIP, a filter. "All", then one chip per workspace in the list's own order,
          each lit with the worst status inside. Tap a chip to see that workspace alone, tap it or
          All to see everything again. Long-press a chip to hide the workspace, and again to bring it
          back; a hidden chip stays in the strip, dimmed, with its dot, so hiding never silences a
          workspace that needs you. One height always, so nothing below moves. */}
      <nav aria-label={t("space.strip.title")} className="-mx-4">
        <div className={cn(STRIP_SCROLLER, "px-4 py-0")}>
          <Chip label={t("space.tabStrip.all")} active={!isolatedGroup} onClick={() => onIsolate?.(null)} />
          {groups.map((g) => (
            <Chip
              key={g.key}
              label={g.label}
              active={isolatedGroup?.key === g.key}
              dimmed={!isolatedGroup && hiddenSet.has(workspacePrefKey(g))}
              status={worstTriage(g.panes)}
              onClick={() => onIsolate?.(isolatedGroup?.key === g.key ? null : workspacePrefKey(g))}
              onLongPress={onToggleHidden ? () => onToggleHidden(workspacePrefKey(g)) : undefined}
            />
          ))}
        </div>
      </nav>

      {/* The twenty-times-a-day glance, in ONE slot of one height: every state counted, with its
          word, once for the whole dashboard (the headings below repeat the numbers, not the words).
          The all-clear check leads when nothing needs you. A tap goes to the first workspace
          holding something urgent. */}
      <button
        type="button"
        onClick={() => firstUrgent && jumpTo(firstUrgent)}
        disabled={!firstUrgent}
        className="flex min-h-8 items-center gap-3 text-left text-xs font-medium text-foreground disabled:opacity-100"
      >
        {allClear && (
          <span className="flex items-center gap-1.5 leading-none">
            <Check className="size-4 shrink-0 text-status-done" aria-hidden />
            {t("home.allClear")}
          </span>
        )}
        <StatusCounts panes={agents} labelled={!allClear} className={allClear ? "text-muted-foreground" : undefined} />
      </button>

      {/* FORK: the operator's own pins, above the workspaces. The only thing on this screen that
          moves a row, and the only thing that should: a hand put it there. */}
      {pinnedSection && (
        <section key="pinned" className="flex flex-col gap-2">
          <SectionHeader {...sectionHeaderProps(pinnedSection)} />
          <ListGroup id="agent-section-pinned">
            {pinnedSection.agents.map((a) => row(a, true))}
          </ListGroup>
        </section>
      )}

      {/* By workspace. The heading IS the landmark: full ink, its own case, and it lights up with a
          dot and a count when a pane inside needs you. Flat rows in ONE bordered group. */}
      {shown.map((g) => (
        <section key={g.key} id={groupDomId(g.key)} className="flex scroll-mt-4 flex-col gap-2">
          <SectionHeader
            label={g.label}
            tone="strong"
            dot={urgentDot(g)}
            trailing={
              <StatusCounts panes={g.panes} className="shrink-0 text-[11px] text-muted-foreground" />
            }
          />
          <ListGroup>{g.panes.map((a) => row(a))}</ListGroup>
        </section>
      ))}
    </div>
  );
});
