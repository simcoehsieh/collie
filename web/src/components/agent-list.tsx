import { memo } from "react";
import { ArrowDown, ArrowUp, Check, WifiOff } from "lucide-react";

import { clockTime } from "@/lib/format";
import { useMuxCapability } from "@/lib/mux-capability";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { PaneRowsSkeleton } from "@/components/route-skeleton";
import { EmptyState } from "@/components/empty-state";
import { flipDir, sectionHeaderProps, triage, type RecentDir, type TriageKey } from "@/lib/triage";
import type { AgentView, BridgeStatus } from "@/lib/types";
import { paneRowKey } from "@/lib/hosts";
import { AgentCard } from "./agent-card";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface AgentListProps {
  agents: AgentView[];
  bridge?: BridgeStatus | undefined;
  /**
   * Open a row. Takes the PANE, not its id: `w1:p1` names a different terminal on every machine in a
   * crew, and this list is one herd across all of them — an id alone cannot say which row was tapped.
   */
  onOpen: (pane: AgentView) => void;
  /** Which way Recent runs, and how to flip it. Omit to render Recent newest-first with no toggle. */
  recentDir?: RecentDir;
  onRecentDirChange?: (dir: RecentDir) => void;
  /** Whether Recent is expanded, and how to fold it. Omit to leave it always open (the sidebar). */
  recentOpen?: boolean;
  onRecentOpenChange?: (open: boolean) => void;
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

/** Which timestamp a section's rows date themselves by. Attention rows show none — a blocked
 *  agent's age is noise beside the fact that it's blocked. */
const AGE_BY_SECTION = new Map<TriageKey, "seen" | "active">([
  ["ready", "active"],
  // "working for 3h" and "working for 40s" are very different facts, and now that the age rides
  // the title row it costs no vertical space to say which.
  ["working", "active"],
  ["recent", "seen"],
]);

/** The sections that mean "a human is required here" — the only ones that get card chrome. */
const ATTENTION: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);

// The herd in the one order the app agrees on: Needs you → Ready · unseen → Working → Recent
// (lib/triage.ts). Only Recent folds, and only Recent takes the direction toggle; the three
// attention sections are pinned open and never invert.
export const AgentList = memo(function AgentList({
  agents,
  bridge,
  onOpen,
  recentDir = "newest",
  onRecentDirChange,
  recentOpen = true,
  onRecentOpenChange,
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
  if (agents.length === 0) {
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

  const all = triage(agents, recentDir, pinned);
  const sections = all.filter((s) => s.agents.length > 0);
  if (sections.length === 0) return null;
  // "What needs me right now?" deserves an answer even when the answer is "nothing". Without this
  // the section simply doesn't render, and an absence reads the same as a stale load.
  const allClear = all.find((s) => s.key === "needs")!.agents.length === 0;

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
      {sections.map((s) => {
        // Recent is the only foldable section, and only where the parent wired the state.
        const foldable = !!s.collapsible && onRecentOpenChange !== undefined;
        const open = foldable ? recentOpen : true;
        const bodyId = `agent-section-${s.key}`;
        const age = AGE_BY_SECTION.get(s.key);
        // statusStyle="dot": the section heading already says the status, so a pill on every row
        // restates it and costs the width the title needs.
        const rows = s.agents.map((a) => (
          <AgentCard
            // The FULL row identity, not the pane id — see `paneRowKey`. A pane id is unique only
            // within one session on one machine, so a merged or widened list holds several rows that
            // answer to `w1:p1`; keyed by the id alone React recycles one row's element for
            // another's between polls, and the card you are looking at acquires a different row's
            // `onClick`. On this list, that is a tap landing in another terminal.
            key={paneRowKey(a)}
            agent={a}
            onClick={() => onOpen(a)}
            statusStyle="dot"
            density={ATTENTION.has(s.key) ? "card" : "row"}
            {...(age ? { age } : {})}
            // FORK: a pinned row wears its glyph in every section it could sit in — which is only
            // this one, since triage lifts it out of the others.
            pinned={s.key === "pinned"}
            {...(onLongPress ? { onLongPress: () => onLongPress(a) } : {})}
          />
        ));

        return (
          <section key={s.key} className="flex flex-col gap-2">
            <SectionHeader
              {...sectionHeaderProps(s)}
              {...(foldable ? { open, onToggle: onRecentOpenChange, controls: bodyId } : {})}
              trailing={
                // A sibling of the fold button, never a child: nesting would be invalid markup and
                // would make flipping the sort also fold the section. Hidden while folded, since
                // sorting rows nobody can see does nothing.
                s.key === "recent" && onRecentDirChange && open ? (
                  <SortToggle dir={recentDir} onChange={onRecentDirChange} />
                ) : undefined
              }
            />
            {/* Cards mean "a human is required here", so only the attention sections get them —
                and an attention section is a GAP LIST: every row is already a bordered object, so
                it gets NO group frame. Wrapping it would be a box inside a box. Do not "fix" this
                to a ListGroup later.

                Every other section is flat rows in ONE bordered group. The frame gives the run of
                hairlines a first edge and a last edge for 2px, which is the whole of what the
                mockups changed — the row itself is untouched. */}
            {open &&
              (ATTENTION.has(s.key) ? (
                <div id={bodyId} className="flex flex-col gap-2">
                  {rows}
                </div>
              ) : (
                <ListGroup id={bodyId}>{rows}</ListGroup>
              ))}
          </section>
        );
      })}
    </div>
  );
});

// One tap flips the Recent order. Deliberately not a menu — the design offers a direction, not a
// choice of sort keys. min-h-9 keeps it on the 36px touch floor.
function SortToggle({ dir, onChange }: { dir: RecentDir; onChange: (dir: RecentDir) => void }) {
  useLocale();
  const newest = dir === "newest";
  const Icon = newest ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={() => onChange(flipDir(dir))}
      aria-label={newest ? t("home.sort.aria.newest") : t("home.sort.aria.oldest")}
      // A bordered chip, not bare text: unstyled it read as an annotation ("sorted newest") rather
      // than something you can press. Fixed width so flipping it doesn't shift the header. No fill —
      // filled, it outweighed the heading it sits beside, which is backwards for a control that
      // reorders the section you care least about.
      className="flex min-h-9 items-center justify-center gap-1 rounded-full border border-transparent bg-muted px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="w-[3.25rem] text-left">{newest ? t("home.sort.newest") : t("home.sort.oldest")}</span>
    </button>
  );
}
