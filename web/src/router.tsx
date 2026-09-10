import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { createBrowserRouter, replace } from "react-router";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { SpaceRoute } from "@/routes/space";
import { DetailRoute } from "@/routes/detail";
import { OverviewRoute } from "@/routes/overview";
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
// The fallback is a route-sized nothing, not a spinner. A chunk arrives in well under a second on
// the second launch (the service worker precaches it), and a spinner that flashes for 80 ms reads
// as a glitch where a blank that becomes the page reads as a page opening.
function lazyRoute(load: () => Promise<{ default: ComponentType }>): ReactNode {
  const Route = lazy(load);
  return (
    <Suspense fallback={<div className="min-h-0 flex-1" aria-busy="true" />}>
      <Route />
    </Suspense>
  );
}
const settingsRoute = lazyRoute(() =>
  import("@/routes/settings").then((m) => ({ default: m.SettingsRoute })),
);
const updatesRoute = lazyRoute(() =>
  import("@/routes/updates").then((m) => ({ default: m.UpdatesRoute })),
);
const crewRoute = lazyRoute(() => import("@/routes/crew").then((m) => ({ default: m.CrewRoute })));
const historyRoute = lazyRoute(() =>
  import("@/routes/history").then((m) => ({ default: m.HistoryRoute })),
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
