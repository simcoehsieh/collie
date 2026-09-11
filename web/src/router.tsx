import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { createBrowserRouter, replace } from "react-router";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { SpaceRoute } from "@/routes/space";
import { DetailRoute } from "@/routes/detail";
import { OverviewRoute } from "@/routes/overview";
import { CrewSkeleton, HistorySkeleton, SettingsSkeleton } from "@/components/route-skeleton";
import { lastPanePath } from "@/lib/last-pane";
import {
  devicesLoader,
  historyLoader,
  crewLoader,
  rootLoader,
  paneLoader,
  PANE_ROUTE_ID,
  ROOT_ROUTE_ID,
} from "@/lib/loaders";

// We don't use view transitions. React Router persists an "applied view transitions" map to
// sessionStorage ("remix-router-transitions") and replays a phantom same-location transition on every
// revalidation for any path it once saw a `viewTransition: true` navigation from. A device that ran an
// older Collie build (which did use them) can carry a stale entry that fires
// document.startViewTransition on every poll. Clear it on boot — our code never repopulates it. The
// `:root { view-transition-name: none }` in index.css is the belt to this: even a stray transition
// then captures nothing, so there's no visible flicker regardless of this key's name.
try {
  sessionStorage.removeItem("remix-router-transitions");
} catch {
  // sessionStorage access can throw in locked-down / private contexts — ignore.
}

// FORK: the routes that are not the dashboard or a pane load on demand. The app shell used to be
// one 880 KB chunk that carried Settings, the crew census, the updater (with its four-step progress
// card and its log viewer) and the transcript reader onto the cold-start path of an installed PWA —
// screens a session opens once a week, paid for on every launch. Root, home and the pane stay
// eager: they are what a launch is FOR, and a tap on a pane row must never wait on a chunk.
//
// The fallback was a route-sized nothing, and the reason it was not a spinner still holds: a chunk
// arrives in well under a second on the second launch (the service worker precaches it), and a
// spinner that flashes for 80ms reads as a glitch.
//
// FORK: a blank is not the best answer to that, only the cheapest — it costs the operator the
// header they just tapped into and gives back a white field. The page's SHAPE is known here (these
// are four fixed screens, not arbitrary content), so the fallback draws it: the app shell's header
// stays mounted above the outlet either way, and the body arrives as the screen's own boxes, drawn
// grey. The 80ms argument is honoured by CSS rather than by dropping the idea — `SkeletonScreen`
// holds the whole thing at opacity 0 for 120ms through one `animation-delay`, so a precached chunk
// still paints nothing at all on its way in and only a genuinely slow one is ever seen. A timer in
// state would have re-rendered the tree to achieve the same thing.
function lazyRoute(
  load: () => Promise<{ default: ComponentType }>,
  fallback: ReactNode,
): ReactNode {
  const Route = lazy(load);
  return (
    <Suspense fallback={<div className="min-h-0 flex-1 overflow-hidden">{fallback}</div>}>
      <Route />
    </Suspense>
  );
}
const settingsRoute = lazyRoute(
  () => import("@/routes/settings").then((m) => ({ default: m.SettingsRoute })),
  <SettingsSkeleton />,
);
// Updates is Settings' own shape one level down — a column of cards — so it borrows that skeleton
// rather than growing a sixth one for a screen nobody waits on twice.
const updatesRoute = lazyRoute(
  () => import("@/routes/updates").then((m) => ({ default: m.UpdatesRoute })),
  <SettingsSkeleton />,
);
const crewRoute = lazyRoute(
  () => import("@/routes/crew").then((m) => ({ default: m.CrewRoute })),
  <CrewSkeleton />,
);
const historyRoute = lazyRoute(
  () => import("@/routes/history").then((m) => ({ default: m.HistoryRoute })),
  <HistorySkeleton />,
);

// Created once at module scope so the idle-lock in App can unmount/remount RouterProvider without
// losing the current location (the router instance retains it; loaders re-run fresh on remount).
export const router = createBrowserRouter([
  {
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: rootLoader,
    element: <RootLayout />,
    // Catches render-phase errors and loader throws (e.g. a missing :paneId) so a component bug
    // shows a recoverable screen instead of React Router's blank default.
    errorElement: <RootError />,
    HydrateFallback: BootSplash,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: "space/:spaceId", element: <SpaceRoute /> },
      // FORK: every agent's last lines on one screen. Eager, like the dashboard: for a herd of
      // long-lived panes it is a first screen, not a once-a-week one.
      { path: "overview", element: <OverviewRoute /> },
      // FORK: the pane this device opened last (lib/last-pane.ts) — the target an iOS Shortcut or
      // the share sheet can name without knowing a pane id. `replace`, so Back does not return to
      // a redirect. Nothing remembered falls back to the dashboard.
      {
        path: "pane/last",
        loader: ({ request }) => replace(lastPanePath(new URL(request.url).search) ?? "/"),
      },
      // Settings carries the paired-device registry, so it gets its own loader — a revoke or a pair
      // is then the app's standard mutation shape (api call → revalidate), with no second data path.
      { path: "settings", loader: devicesLoader, element: settingsRoute },
      // The Updates page, a sibling of settings and crew. No loader of its own: everything on it is
      // either the snapshot (root loader) or the card's own read of /api/update/check. It is
      // deliberately ON the poll loop for `crew`'s stated reason — a run in progress and a member
      // going quiet are exactly what this page exists to show without a reload.
      { path: "settings/updates", element: updatesRoute },
      // The crew census, likewise on its own loader — and deliberately ON the poll loop: the payload
      // is one small object per machine, and the whole point of the page is that a member going
      // quiet shows up here without the operator reloading. (History opts out; this one wants in.)
      { path: "crew", loader: crewLoader, element: crewRoute },
      // The path was `crew` until 1.7.0 (M24 renamed the word a person reads). The service worker
      // caches the app shell, so a client sitting on /crew when the new bundle arrives, a bookmark
      // and an installed PWA's start URL all still ask for the old spelling. `replace` rather than
      // a push, so Back does not bounce the operator between the two names. The query string rides
      // along, because the scope (`?h=`) is what makes "back" return to the right machine.
      {
        path: "pack",
        loader: ({ request }) => replace(`/crew${new URL(request.url).search}`),
      },
      // Named, so RootLayout can ask for THIS route's data by id (react-router hands back undefined
      // whenever it isn't the active route) — see the "last seen" note there.
      { id: PANE_ROUTE_ID, path: "pane/:paneId", loader: paneLoader, element: <DetailRoute /> },
      {
        path: "pane/:paneId/history",
        loader: historyLoader,
        element: historyRoute,
        // Opt OUT of the poll loop. revalidate() re-runs every active loader, and a transcript can be
        // hundreds of turns — re-pulling it every 1.5s would be pure waste, and it would fight the
        // view's own "load older" paging by resetting the page under it. History is fetched on
        // navigation; the view pages back through it with direct api calls.
        shouldRevalidate: () => false,
      },
    ],
  },
]);
