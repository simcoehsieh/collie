import { memo, useCallback, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { AgentIcon } from "@/components/agent-icon";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { saveDataRequested } from "@/hooks/use-polling";
import { ambientPanes, paneScope } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { homePath, panePath } from "@/lib/nav";
import { tailFor, useOverviewTails } from "@/lib/overview";
import { paneParts } from "@/lib/pane-name";
import { useRootData } from "@/lib/route-data";
import type { Scope } from "@/lib/scope";
import { triage } from "@/lib/triage";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: every agent pane on one screen, each with the last few lines of its mirror.
//
// The dashboard is a LIST — one line per pane, and the line is the pane's name and status. That is
// the right shape for "what needs me", and the wrong one for "what is everyone doing": four
// long-lived agents that are all `working` are four identical rows, and telling them apart means
// opening each. This screen is the other shape: a grid of cards, one per agent, each showing what
// its terminal said last. The order is the dashboard's own (lib/triage.ts, pins first), so the
// two screens agree about which pane comes first.
//
// The tails come from lib/overview.ts — a read of each pane WITHOUT marking it seen, so opening this
// screen does not clear the "Ready · unseen" alerts the dashboard is built around.
export function OverviewRoute() {
  const data = useRootData();
  const navigate = useNavigate();
  const { prefs } = useDashPrefs();
  useLocale();

  // The same narrowing the dashboard's navigator does: the panes of the machine and session on
  // screen. A card is a mirror, and a mirror of another host's `w1:p1` under this host's label is
  // the confusion `ambientPanes` exists to prevent.
  const panes = useMemo(
    () => ambientPanes(data.agents, data.shellPanes, data.scope, data.servers, data.sessions).agents,
    [data.agents, data.shellPanes, data.scope, data.servers, data.sessions],
  );
  const ordered = useMemo(
    () => triage(panes, prefs.recentDir, prefs.pinned).flatMap((s) => s.agents),
    [panes, prefs.recentDir, prefs.pinned],
  );
  const version = useOverviewTails(ordered, data.scope, data.ts, prefs.lowPower || saveDataRequested());

  const open = useCallback(
    (pane: AgentView) =>
      navigate(panePath(pane.paneId, paneScope(data.scope, pane, data.servers, data.sessions))),
    [navigate, data.scope, data.servers, data.sessions],
  );

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-md flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              onClick={() => navigate(homePath(data.scope))}
              aria-label={t("settings.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
              {t("overview.title")}
            </h1>
            <SettingsGear scope={data.scope} />
          </>
        }
      />
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {ordered.length === 0 ? (
          <p className="py-24 text-center text-sm text-muted-foreground">
            {data.error ? t("home.empty.disconnected") : t("home.empty.noAgents")}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-slot="overview-grid">
            {ordered.map((pane) => (
              <OverviewCard
                key={pane.paneId}
                pane={pane}
                scope={data.scope}
                version={version}
                pinned={prefs.pinned.includes(pane.paneId)}
                onOpen={open}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// One card. Memoised on the pane object and the tail store's version: a poll that changed nothing
// hands the same `pane` reference (loaders.ts keeps snapshot identity) and the same version, so the
// grid re-renders nothing.
const OverviewCard = memo(function OverviewCard({
  pane,
  scope,
  version,
  pinned,
  onOpen,
}: {
  pane: AgentView;
  scope: Scope | undefined;
  version: number;
  pinned: boolean;
  onOpen: (pane: AgentView) => void;
}) {
  // `version` is a PROP by design — it is how a landed read reaches this memoised card; the
  // lookup itself is one Map read, so it is not memoised.
  void version;
  const tail = tailFor(scope, pane.paneId);
  const parts = paneParts(pane);
  const title = parts.secondary ?? parts.tab ?? parts.project;
  const blocked = pane.status === "blocked";
  return (
    <button
      type="button"
      onClick={() => onOpen(pane)}
      data-pane-row={pane.paneId}
      data-slot="overview-card"
      className={cn(
        "flex min-h-36 w-full flex-col gap-2 rounded-xl border bg-card p-3 text-left shadow-card transition-transform active:scale-[0.99]",
        blocked && "border-status-blocked/40 bg-status-blocked/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AgentIcon agent={pane.agent} className="size-4" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {pinned && <span className="text-[10px] text-muted-foreground">{t("home.pin.pinned")}</span>}
        <StatusBadge status={pane.status} />
      </div>
      {parts.project !== title && (
        <div className="truncate text-xs text-muted-foreground">{parts.project}</div>
      )}
      {/* The tail: mono, small, never wrapping past the card. Plain text — ANSI stripped by
          lib/overview.ts — because six rows at this size are read for their words, not their
          colours, and a card is not a mirror (ADR 0002's MIRROR_SPACE rules apply to the mirror). */}
      <pre
        data-slot="overview-tail"
        className="mt-auto max-h-28 min-h-20 overflow-hidden whitespace-pre font-mono text-[11px] leading-[1.35] text-muted-foreground"
        aria-label={t("overview.tailAria")}
      >
        {tail === undefined ? t("overview.loading") : tail.lines.join("\n")}
      </pre>
    </button>
  );
});
