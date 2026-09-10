import { useCallback, useMemo, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { useNavigate } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { SessionSwitcher } from "@/components/session-switcher";
import { ServerSwitcher } from "@/components/server-switcher";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { SpaceOverview } from "@/components/space-overview";
import { NewSpaceSheet, type WorktreeRepo } from "@/components/new-space-sheet";
import { PinSheet } from "@/components/pin-sheet";
import { QuotaCard } from "@/components/quota-card";
import { StatusArea } from "@/components/status-area";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { BuildStamp } from "@/components/build-stamp";
import { CrewFooterLink } from "@/components/crew-footer-link";
import { UpdateBanner } from "@/components/update-banner";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useMuxCapability } from "@/lib/mux-capability";
import { useQuotaEnabled } from "@/lib/operator-config";
import { ambientPanes, leadHost, paneScope, sessionsOnHost } from "@/lib/hosts";
import { panePath, spacePath } from "@/lib/nav";
import { overviewPath } from "@/lib/overview";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import type { AgentView } from "@/lib/types";
import { useRootData } from "@/lib/route-data";

// Dashboard home screen. Everything you might ACT on comes first — Needs you → Ready · unseen →
// Working → Recent (see lib/triage.ts) — and the Spaces navigator sits last, under the thing it
// navigates to. Recent and Spaces fold; fold both and the page is the triaged herd and nothing else.
// Launchers sit directly above Spaces: they are one-tap act-on-able actions like the herd above
// them, but they CREATE rather than triage, so they sit under the triaged herd and above the
// navigator their new Space will appear in. Tapping an agent opens its pane; tapping a space
// drills into /space/:id; tapping a launcher creates a throwaway Space and types its command.
export function HomeRoute() {
  const data = useRootData();
  const navigate = useNavigate();
  useLocale();
  const { newSpace, newWorktree, showWorktree, creatingSpace } = useSpaceActions();
  // FORK: the row a long press picked up, for the pin sheet. Null while the sheet is closed.
  const [held, setHeld] = useState<AgentView | null>(null);
  const hold = useCallback((pane: AgentView) => setHeld(pane), []);
  const knownIds = useMemo(() => data.agents.map((a) => a.paneId), [data.agents]);

  // Which repos a worktree could be branched from: one entry per repo, taken from the space that
  // shows the repo ITSELF (a worktree's own space would branch from the same repo, so listing both
  // would offer the same thing twice under two names). In the spaces list's order, so the first
  // entry — the sheet's default — is the repo most recently used.
  // Asked of the machine this view is showing (M22/03): absent `?h=` is the lead, as everywhere.
  const canCreateWorktree = useMuxCapability("createWorktree", data.scope);
  const worktreeRepos: WorktreeRepo[] = canCreateWorktree
    ? data.workspaces
        .filter((w) => w.repoRoot !== undefined && w.isWorktree === false)
        .map((w) => ({ workspaceId: w.workspaceId, repoRoot: w.repoRoot!, label: w.label }))
    : [];
  // ONE TAP each in the new-space picker: the directories this operator is demonstrably already
  // working in. Repo roots lead, because a project's root is what you want far more often than
  // wherever a pane happens to have cd'd to; the panes' own cwds follow and fill in everything that
  // is not a repo. Deduped in that order, and capped — a strip you scroll is not a shortcut.
  //
  // NARROWED TO THE MACHINE the picker will browse. A pack's rows come from every member, and a
  // peer's path pasted into the lead's browser is a 404 with no explanation; `ambientPanes` is the
  // same narrowing every other list on this page already does.
  const dirShortcuts = useMemo(() => {
    const host = data.scope?.host;
    const onHost = <T extends { host?: string }>(row: T): boolean =>
      host === undefined || row.host === undefined || row.host === host;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const path of [
      ...data.workspaces.filter(onHost).map((w) => w.repoRoot),
      ...[...data.agents, ...data.shellPanes].filter(onHost).map((p) => p.cwd),
    ]) {
      if (path === undefined || path === "" || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (out.length === 8) break;
    }
    return out;
  }, [data.workspaces, data.agents, data.shellPanes, data.scope?.host]);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const { prefs, setSpacesOpen, setRecentOpen, setRecentDir, setQuotaOpen } = useDashPrefs();
  // FORK: the usage section draws only on a bridge that can answer `/api/quota` — absent from
  // `/api/config` is the feature off, and the dashboard is byte for byte what it was.
  const quotaOn = useQuotaEnabled();
  // No stored choice yet? The space count decides — a two-space install shouldn't be handed a
  // mystery collapsed header, and a forty-space one shouldn't be handed a wall.
  const spacesOpen = openForCount(prefs.spacesOpen, data.workspaces.length);
  // The Launch section folds on the same terms. Its count comes from the component (it owns the
  // config read), so the un-chosen default is decided there against the same threshold.

  // A row is opened with the PANE's host, never the ambient one: the dashboard is one list across
  // every machine (hosts are a label, not a split), so the row you tapped may well live somewhere
  // other than where the URL currently points. Resolving it here is what stops a reply landing on the
  // right pane name on the wrong terminal. Solo: every pane is untagged, so this is `data.scope`.
  // FORK: stable, because AgentList and the space overview below are memo()'d and a fresh arrow
  // per render would hand them a new prop on every poll tick.
  const open = useCallback(
    (pane: AgentView) =>
      navigate(panePath(pane.paneId, paneScope(data.scope, pane, data.servers, data.sessions))),
    [navigate, data.scope, data.servers, data.sessions],
  );
  const drillInto = useCallback(
    (id: string) => navigate(spacePath(id, data.scope)),
    [navigate, data.scope],
  );
  // The space navigator is LEAD-LOCAL (the merge deliberately does not union peer workspaces — their
  // ids are only unique per machine), so the spaces on screen belong to the lead and their panes must
  // be looked up under the lead's host. Undefined when solo, which keys everything exactly as before.
  const navHost = leadHost(data.servers);
  // Sessions are a per-host registry, so the session switcher only ever lists this host's.
  const sessionsHere = sessionsOnHost(data.sessions ?? [], data.scope, data.servers);
  // …AND LEAD-LOCAL IS ALSO SESSION-LOCAL, which is the half the widened view would otherwise break.
  // Workspace ids collide across sessions exactly as they collide across machines, and the space
  // navigator keys by `(host, workspaceId)` with no session in it — so on a widened body another
  // session's `w1` panes would paint their blocked dot and their recency onto the AMBIENT `w1` row,
  // and drilling in would show a space with nothing blocked in it. The list widens; the navigation
  // tree does not (that is the whole shape of this feature, and the shape the crew merge already
  // has), so the tree is fed ambient panes only. Untagged panes are ambient by definition, which
  // makes this the identity filter on every un-widened body.
  const navPanes = useMemo(
    () => ambientPanes(data.agents, data.shellPanes, data.scope, data.servers, data.sessions),
    [data.agents, data.shellPanes, data.scope, data.servers, data.sessions],
  );

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* The dashboard header: wordmark + the session switcher (dashboard-only), then the shared pill
          and the Settings gear. The switcher self-hides on a single-session install. */}
      <RouteHeader
        wordmark
        width="column"
        rightLead={
          <>
            {/* FORK: the overview — every agent's last lines on one screen (routes/overview.tsx).
                A plain glyph like the gear, ahead of the switchers, because it is a place to go
                rather than a dimension to change. */}
            <button
              type="button"
              onClick={() => navigate(overviewPath(data.scope))}
              aria-label={t("overview.title")}
              className="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
            >
              <LayoutGrid className="size-5" />
            </button>
            {/* Host first, then session — outer dimension first, and the two are deliberately
                different shapes (bordered server pill vs filled layers capsule) so a glance can tell
                "change machine" from "change session on this machine". Both self-hide. */}
            <ServerSwitcher servers={data.servers} scope={data.scope} agents={data.agents} />
            <SessionSwitcher sessions={sessionsHere} scope={data.scope} viewAll={data.viewAll} />
          </>
        }
        rightTrail={<SettingsGear scope={data.scope} />}
      />

      {/* Content region below the header: a viewport-clipped internal scroller. `relative` is
          load-bearing: it makes this scroller the containing block for its absolutely-positioned
          descendants. Tailwind's `sr-only` is `position: absolute`, so every status label in the
          list would otherwise escape this scroller's clip and grow the document's own scrollbar. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* A notice BELOW the header is content, not viewport chrome: it is an inset box on the
            page gutter, not a full-bleed strip. Full-bleed it ran its left edge 16px outside the
            list it sat on top of — two left edges stacked, the loudest misalignment on the page. */}
        <ReadOnlyBanner device={data.device} />

        <main className="flex-1">
          {/* One list, every section, in triage order. It used to be split in two so "Needs you"
              could be hoisted above the spaces overview; with Spaces last there is nothing to
              straddle. */}
          <AgentList
            agents={data.agents}
            bridge={data.bridge}
            onOpen={open}
            recentDir={prefs.recentDir}
            onRecentDirChange={setRecentDir}
            recentOpen={prefs.recentOpen}
            onRecentOpenChange={setRecentOpen}
            error={data.error}
            lastSeenAt={data.lastSeenAt}
            pinned={prefs.pinned}
            onLongPress={hold}
          />
          {/* THE LAUNCH STRIP IS DELIBERATELY NOT HERE (fork, 2026-09-06). Upstream renders the
              operator's `launchers.toml` rows as one-tap buttons on the dashboard, and a tap
              CREATES A THROWAWAY SPACE running that command — which reads as a picker but behaves
              as a create, and that is what made it confusing rather than useful here.

              `launchers.toml` itself is KEPT: agent-chat.tsx still reads it for the tab strip's
              "+" hold, where the same rows do the thing their shape promises (pick what the "+"
              opens). The two consumers are independent, so removing this line removes exactly the
              dashboard strip and nothing else. To restore upstream's behaviour, put back:
                <LaunchStrip open={prefs.launchOpen} onOpenChange={setLaunchOpen} scope={data.scope} />
              plus its import and the `setLaunchOpen` binding from useDashPrefs. */}
          <SpaceOverview
            workspaces={data.workspaces}
            agents={navPanes.agents}
            shellPanes={navPanes.shellPanes}
            host={navHost}
            onOpen={drillInto}
            onNewSpace={() => setNewSpaceOpen(true)}
            creatingSpace={creatingSpace}
            open={spacesOpen}
            onOpenChange={setSpacesOpen}
          />
          {/* FORK: what the three agents have left (components/quota-card.tsx). Under Spaces and
              above the footer: it is information, not a thing to act on, so it sits below
              everything that is. Foldable like Spaces; the fold is a dash pref. */}
          {quotaOn && <QuotaCard open={prefs.quotaOpen} onOpenChange={setQuotaOpen} />}
        </main>

        {/* The footer is the dashboard's meta zone, in widening order: the crew you're part of, an
            available update / needed restart, then the build stamp (which bundle you're running,
            with a stale-cache nudge). The crew line self-hides on a solo install. */}
        <CrewFooterLink scope={data.scope} className="px-4 pt-3" />
        <UpdateBanner className="px-4 pt-3" />
        <BuildStamp className="px-4 pt-3 pb-[calc(var(--safe-bottom)_+_0.5rem)]" />
      </div>

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. Stays outside the scroller so it never scrolls away.

          `dock="bottom"` because this screen has no composer for a toast to collide with; the pane
          screen docks its own to the top for the opposite reason. The positioning — the portal, the
          z-rung, the safe-area inset — belongs to ToastViewport and is stated there once, which is
          what stopped it being three hand-rolled copies of the same four utilities. DESIGN.md §1. */}
      <ToastViewport>
        <StatusArea />
      </ToastViewport>

      {/* FORK: pin / un-pin / reorder, from a long press on a row. */}
      <PinSheet
        open={held !== null}
        pane={held}
        pinned={prefs.pinned}
        known={knownIds}
        onClose={() => setHeld(null)}
        onOpen={open}
      />

      <NewSpaceSheet
        open={newSpaceOpen}
        onClose={() => setNewSpaceOpen(false)}
        onCreate={newSpace}
        repos={worktreeRepos}
        dirShortcuts={dirShortcuts}
        scope={data.scope}
        onOpenWorktree={(workspaceId, path) => void showWorktree(workspaceId, path)}
        onCreateWorktree={(workspaceId, branch) => void newWorktree(workspaceId, branch)}
      />
    </div>
  );
}
