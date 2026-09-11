import {
  Outlet,
  useLoaderData,
  useLocation,
  useMatches,
  useNavigation,
  useNavigationType,
  useParams,
  useRouteError,
  useRevalidator,
  useRouteLoaderData,
} from "react-router";

import { useEffect, useRef } from "react";

import { usePolling } from "@/hooks/use-polling";
import { usePollBusy } from "@/hooks/use-poll-busy";
import { useBusyWhile } from "@/lib/busy";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { HotkeysSheet } from "@/components/hotkeys-sheet";
import { UpdateRibbon } from "@/components/update-ribbon";
import { ConnectionBanner } from "@/components/connection-banner";
import { AppHeaderHost } from "@/components/app-header";
import { CrewProvider } from "@/components/crew-provider";
import { MeowMark } from "@/components/meow-mark";
import { describeThrownError } from "@/lib/api-error-message";
import { homePath } from "@/lib/nav";
import { scopeFromUrl } from "@/lib/session";
import { PANE_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/**
 * The "last seen" stamp the ONE connection surface should show — the stamp of the data actually on
 * screen, which is not always the snapshot's.
 *
 * A cold boot straight into a pane re-renders that pane's mirror from the write-through cache, and
 * the two stamps can be hours apart: the operator last opened the pane at 12:05 and left the
 * dashboard polling until 14:32. Dating that 12:05 terminal text "last seen 14:32" is the same
 * dishonesty this whole change removes, one level down — so while a stale mirror is the thing being
 * read, the mirror's own stamp wins, undated included (an undatable mirror says nothing rather than
 * borrowing a number that isn't about it).
 *
 * A stale pane with NO text is not a case: nothing old is on screen, so the herd's stamp is the
 * honest one. Live pane data likewise falls through — the pane is current, and the banner is then
 * describing whatever the snapshot is doing.
 */
export function shownLastSeenAt(home: HomeData, pane: PaneData | undefined): number | undefined {
  if (pane?.error && pane.text) return pane.lastSeenAt;
  return home.lastSeenAt;
}

/** Which direction a route arrives from — the value of `data-route-enter`, drawn by skin.css. */
export type RouteEnter = "push" | "pop" | "modal";

/**
 * FORK: THE KIND OF NAVIGATION, NOT JUST THE FACT OF ONE.
 *
 * Every route entrance used to be the same 6px rise, so pushing into a pane, popping back to the
 * dashboard and opening Settings looked identical. On a phone, direction is how you know where you
 * are; its absence is the loudest "this is a website" tell an app has.
 *
 * Three answers and no fourth:
 *   • `modal` — Settings and the Overview. Both are places you look at and come back from rather
 *     than places you go, and neither has a sibling at its own level, so a sideways slide would be
 *     claiming a hierarchy that isn't there. They rise.
 *   • `pop` — the browser's own Back (navigation type POP: the swipe gesture, the hardware key, the
 *     header's home button through `navigate(-1)`), or any move to a SHALLOWER path. Comes from the
 *     left, which is where the thing you are returning to went.
 *   • `push` — everything else, including equal depth. Equal depth matters more than it looks: a
 *     pane→pane hop must resolve to the SAME value as the navigation that opened the first pane, or
 *     the attribute changes under a wrapper React deliberately does not remount and the entrance
 *     replays on a hop that moved nothing (routes/root.tsx keys by route KIND for exactly that
 *     reason).
 *
 * Pure, and exported, because the whole of this decision is four comparisons and the wrong answer
 * is invisible in a screenshot — it only shows up as the screen sliding the wrong way.
 */
export function routeEnter(
  routeKind: string,
  navigationType: string,
  depth: number,
  previousDepth: number,
): RouteEnter {
  if (routeKind === "settings" || routeKind === "overview") return "modal";
  if (navigationType === "POP") return "pop";
  return depth < previousDepth ? "pop" : "push";
}

// The data root: owns the snapshot loader, drives polling, and fans the herd out to the child
// routes (home + pane detail) via the router's loader data. Mounted only while unlocked (the
// idle-lock in App swaps the whole RouterProvider out), so polling pauses when the app is locked.
export function RootLayout() {
  // SAFETY: this component IS the root route's element, and `rootLoader` — the loader `router.tsx`
  // pairs with it — returns `HomeData`. React Router types `useLoaderData()` as `unknown` in data
  // mode; the element does not mount until its own loader has resolved.
  const data = useLoaderData() as HomeData;
  // useParams accumulates params from matched child routes, so `paneId` is set when the
  // `/pane/:paneId` child is active. useAgentTransitions uses it to suppress a notification for the
  // pane you're already looking at.
  const { paneId } = useParams();
  const pathname = useLocation().pathname;
  const routeKind = pathname.split("/")[1] ?? "";
  // FORK: which way the next entrance slides. The depth of the path the operator is LEAVING is the
  // only thing this needs that the router does not already hand over, so it is one ref updated in an
  // effect — read during render (the value from the last committed route), written after paint.
  const depth = pathname.split("/").filter(Boolean).length;
  const previousDepth = useRef(depth);
  const enter = routeEnter(routeKind, useNavigationType(), depth, previousDepth.current);
  useEffect(() => {
    previousDepth.current = depth;
  }, [depth]);
  // The active pane's loader data, or undefined when a pane isn't the active route — the router
  // already carries both stamps, so dating the bar by what's on screen needs no store of its own.
  // SAFETY: PANE_ROUTE_ID names the route whose `loader` is paneLoader (router.tsx pairs the two),
  // so the only value that can appear under that id is the PaneData that loader returned.
  const pane = useRouteLoaderData(PANE_ROUTE_ID) as PaneData | undefined;
  // FORK: a loader that answered from cache on a navigation (`pending`) is owed its real read at
  // once — not on the next poll tick, which can be 6s away on an idle herd. One effect for every
  // loader on the poll loop, because the flag means the same thing on each of them and revalidate()
  // re-runs every active loader. Read off the matches rather than by route id, so a loader that
  // gains the flag (settings, crew) is covered without this file naming it. History is NOT here on
  // purpose: it opts out of revalidation, and its own view re-reads on the flag.
  const matches = useMatches();
  // SAFETY: a match's `data` is whatever its loader returned, typed `unknown` by React Router; every
  // loader in router.tsx returns one of the lib/loaders.ts shapes, and each of those declares
  // `pending?: boolean` with the same meaning — so reading that one optional field is the contract
  // those loaders share, and a loader without it simply answers undefined.
  const pendingRead = matches.some((m) => (m.data as { pending?: boolean } | undefined)?.pending === true);
  const { revalidate } = useRevalidator();
  useEffect(() => {
    if (pendingRead) void revalidate();
  }, [pendingRead, revalidate]);

  // The scope rides along so a "look now" on foreground lands on the machine and session the page is
  // actually showing — a refresh aimed at the lead would leave a peer's herd exactly as stale.
  const pollMs = usePolling(data, paneId, data.scope);
  // Surface the busy bar when a navigation or a poll runs slow, each against its own threshold —
  // routine fast polls/navigations stay invisible. Mounted here so the whole app shares one
  // detector inside the router context.
  usePollBusy();
  // The Collie mark's orbit turns for the whole of a route navigation — a tap the operator is
  // waiting on a loader for. NO THRESHOLD here, unlike the bar above: the bar is a strip that
  // appears, so it waits 500ms rather than flash on every fast tap, while the orbit is already on
  // screen and only changes speed and chroma. The mark carries its phase across that change
  // (lib/busy.ts states it at `useBusyWhile`), so a 120ms navigation reads as a short
  // accelerate/decelerate rather than a flicker, and delaying it would only make the fast case —
  // the common one — say nothing at all.
  useBusyWhile(useNavigation().state !== "idle");
  useAgentTransitions(data.agents, paneId ?? null);
  usePushSetup();
  // FORK: desktop shortcuts, live only with a fine pointer (hooks/use-hotkeys.ts).
  const hotkeys = useHotkeys(data);

  // A viewport-height flex column: the top banners (when shown) are in-flow rows at the top and the
  // active route fills the rest (each route root is `min-h-0 flex-1`). This is what keeps a banner
  // from covering the route's sticky header — it reserves real space instead of overlaying.
  return (
    // The crew roster is published here, at the data root, so every surface below — including sheets
    // portalled out to document.body — can answer "which machine?" without a prop chain. With no crew
    // the provider publishes the solo value and nothing downstream renders any host chrome.
    //
    // `ts` and the poll cadence ride along for tier-2 (lead↔peer) health: §10.2 presents a member
    // stale once the lead's last receipt from it is older than `3 × pollMs` (capped at 15s), and
    // the number is the one `usePolling` above RETURNS — the gap it is actually running on, not a
    // second derivation of it, so the tolerance can never be computed against a cadence we aren't
    // using. That mattered more once the cadence gained inputs beyond the snapshot (#156).
    <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={pollMs}>
      <div className="app-viewport flex flex-col overflow-hidden">
        {/* THE update band, and the only one: a release on offer, a confirm just tapped, a run in
            flight, a new bridge this bundle is behind, and peers following — one fixed-height row
            that says whichever of those is true. Mounted unconditionally so the bundle self-updater's
            controller runs (and can auto-update) for the app's lifetime; it returns null when it has
            nothing to say. */}
        <UpdateRibbon />
        {/* The app's ONE connection surface: a thin, animated bar that stays hidden while healthy, fades
            in amber "reconnecting…" only after ≥4s of sustained trouble (the flicker fix), escalates to a
            red "not connected" cause + Retry/Reload at ≥15s, and flashes green on recovery. Reads the
            same shared-clock signals as the header dog, so the two always agree. */}
        <ConnectionBanner
          bridge={data.bridge}
          error={data.error}
          authError={data.authError}
          lastSeenAt={shownLastSeenAt(data, pane)}
        />
        {/* THE ONE HEADER, and the third thing on this shelf. The two banners above it have always
            survived a navigation because they are rendered HERE rather than inside `<Outlet/>`; the
            header did not, because all six routes mounted their own copy of it, and a header inside
            the outlet unmounts and remounts on every route change. That restarted the Collie mark's
            37 CSS animations at zero each time — the operator's report — and rebuilt every gradient,
            filter and mask id in the drawing with it. It is one shell now, mounted once for the life
            of the app, and each route portals its own items into it via `<RouteHeader/>`.

            It WRAPS the outlet rather than sitting beside it, which is the structural half of the
            fix: there is no arrangement of this app in which a route mounts without a header above
            it, and `<RouteHeader/>` throws outside the host rather than quietly rendering nothing.
            `bridge` and `error` are read here, once, off the root snapshot every route was
            forwarding them from anyway — six copies of the same two fields was six chances to
            disagree with the ConnectionBanner two lines up. */}
        <AppHeaderHost bridge={data.bridge} error={data.error}>
          {/* FORK: the route's entrance. Keyed by the KIND of route (dashboard / space / pane /
              settings / crew), so a dashboard→pane tap replays the entrance in skin.css while a
              pane→pane hop — which must keep DetailRoute mounted (routes/detail.tsx) — does not
              remount anything. The wrapper mirrors the column each route already draws.
              The attribute's VALUE says which way (see `routeEnter` above): push slides in from the
              right, pop from the left, modal rises. */}
          <div key={routeKind} data-route-enter={enter} className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </AppHeaderHost>
        <HotkeysSheet open={hotkeys.helpOpen} onClose={() => hotkeys.setHelpOpen(false)} />
      </div>
    </CrewProvider>
  );
}

// Shown once, on the very first load, while the snapshot loader resolves (SPA hydration). This is the
// router's HydrateFallback, so it stays mounted until the FIRST loader run settles — and over a dead
// tailnet that initial fetch can hang well past its timeout (or forever on a WebView without
// AbortSignal.timeout). Left as-is, a PWA reopened while the host is unreachable would bloom the mark
// on "Connecting to the herd…" indefinitely, with no way to retry. So once we've been stuck here for
// CONNECTION_LOST_MS (the same wall-clock threshold as the in-app prompt — `connecting` is trivially
// true the whole time we're mounted), the splash escalates to an honest, actionable "Not connected"
// state: the mark stills, the copy says we can't reach Collie, and a Retry
// re-runs the loaders from scratch (a full reload clears most transient failures). Below the
// threshold it's unchanged.
export function BootSplash() {
  useLocale();
  const stuck = useConnectionLost(true);
  if (!stuck) {
    return (
      <div className="app-viewport flex flex-col items-center justify-center gap-3 text-muted-foreground">
        {/* The bloom: the same mark as the rest state below, but turning and at full chroma. It is
            a COLOUR as well as motion, which is the half a reduced-motion reader still gets —
            `prefers-reduced-motion` stops the orbit and cannot stop the accents. `paper` is this
            screen's ground, `bg-background`, the knockout that puts a near-side bead in front of
            the head. The "Connecting to the herd…" copy below carries the accessible meaning, so
            the mark is decorative. */}
        <MeowMark size={64} weight="header" loading paper="var(--background)" />
        <span className="text-sm">{t("error.boot.connecting")}</span>
      </div>
    );
  }
  return (
    <div className="app-viewport flex flex-col items-center justify-center gap-3 p-6 text-center">
      {/* Rest = the Collie mark still, muted (grayscale + dimmed) to read asleep
          — never the gallop's own rest frame, whose full-stretch mid-stride pose looks frozen
          mid-run. No `loading`: we have stopped trying, and a blooming mark would say otherwise.
          `paper` is this screen's ground, `bg-background`, which is the knockout colour that puts a
          near-side bead in front of the head. The "Not connected" copy below carries the accessible
          meaning, so the mark is decorative. */}
      <MeowMark size={64} weight="header" paper="var(--background)" className="opacity-40 grayscale" />
      <p className="font-medium text-foreground">{t("error.boot.title")}</p>
      <p className="max-w-xs text-sm text-muted-foreground">{t("error.boot.body")}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="text-sm underline underline-offset-4"
      >
        {t("error.boot.retry")}
      </button>
    </div>
  );
}

// Last-resort recovery screen for a render-phase error or a loader throw — a full reload re-runs the
// loaders from scratch, which clears most transient failures.
export function RootError() {
  useLocale();
  const error = useRouteError();
  // An ApiError knows the bridge's code and can therefore say the refusal in the operator's
  // language; anything else (a render-phase throw, a router error) keeps its own message.
  const message = error instanceof Error ? describeThrownError(error) : t("error.root.unknown");
  return (
    <div className="app-viewport flex flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-medium text-destructive">{t("error.root.title")}</p>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={() => {
          // Reload home, but stay on the machine and in the session you were in (read from the
          // live URL, since the router context may be the throwing one). Lead + primary → "/".
          window.location.assign(homePath(scopeFromUrl(window.location.href)));
        }}
        className="text-sm underline underline-offset-4"
      >
        {t("error.root.reload")}
      </button>
    </div>
  );
}
