/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

import {
  decidePush,
  enforcesUserVisible,
  notificationPath,
  type NotifData,
  type PushPayload,
} from "./lib/push-decision";
import { openNotificationTarget, type OpenOutcome } from "./lib/notification-open";
import { FONT_URLS, NAVIGATION_NETWORK_ONLY } from "./lib/sw-routes";
import {
  RESUBSCRIBED_MESSAGE,
  VAPID_KEY_MESSAGE,
  XHR_HEADER_NAME,
  XHR_HEADER_VALUE,
  resubscribeBody,
  serverKeyFor,
} from "./lib/push-heal";
import { scopeSearch } from "./lib/scope";

// Custom service worker (vite-plugin-pwa `injectManifest`). It does everything the old generated
// Workbox SW did — precache the app shell + SPA-fallback navigations — PLUS the two handlers a
// generated SW can't give us: `push` (render the bridge's notification) and `notificationclick`
// (deep-link to the agent). Without a `push` listener the browser, forced to show *something* for a
// `userVisibleOnly` subscription, falls back to a generic "site updated in the background" — which
// was exactly the bug this file fixes.
//
// In module scope a `declare const self` shadows the global, giving us the service-worker type (the
// documented vite-plugin-pwa pattern). `__WB_MANIFEST` is the injection point workbox-build fills in
// at build time — it must appear verbatim, exactly once, or the build fails.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

// ── App-shell caching (parity with the previous generateSW config) ──────────────────────────────
precacheAndRoute(self.__WB_MANIFEST);
// SPA fallback so deep links (/pane/:id) resolve offline too. The denylist is the set of paths this
// SW must never answer from the precache — the API, and the `/auth/` namespace reserved for a
// fronting proxy's sign-in page. Without that second entry an installed PWA, which has no address
// bar, has no reachable path to the proxy at all: every navigation, including a reload, is answered
// by the cached app shell. See lib/sw-routes for the contract.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [...NAVIGATION_NETWORK_ONLY],
  }),
);

// The bundled Nerd Font faces are out of the precache on purpose — `unicode-range` keeps them lazy,
// and ~1.1 MB is not something to charge an install for (vite.config.ts, index.css). Cache-first on
// first use gives them back offline. Hand-rolled rather than workbox-strategies: the SW bundle stays
// at one dependency. Entries are never revised — the version is in the filename, so a regenerated
// subset is a different URL and old entries are swept on activate, not overwritten.
//
// The cost, stated plainly: a device that installs the PWA and goes offline without ever painting a
// Nerd Font glyph shows tofu until it is online once. Precaching would fix that by charging EVERY
// install ~1.1 MB, including the installs that never need a glyph — the wrong way round.
const FONT_CACHE = "collie-fonts";

// WHAT MAY BE STORED. This cache is permanent, so a wrong entry is permanent too — the same shape as
// the 401ing proxy that once froze an installed SW, one layer down. A fronting proxy with an expired
// session answers a subresource with 302 → 200 sign-in HTML, and `response.ok` is true for that: the
// login page would be cached AS the font, tofu forever with no recovery but clearing site data. So a
// response must be an unredirected 200 that actually claims to be a font. (Bare `.ok` also admits
// 206, which `cache.put` rejects outright.)
const storable = (r: Response) =>
  r.status === 200 && !r.redirected && (r.headers.get("content-type") ?? "").includes("font");

registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/fonts/"),
  async ({ request }) => {
    const cache = await caches.open(FONT_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    // Writing is best-effort and off the response path: a full quota or a storage error costs the
    // glyphs on the next load, never this one.
    if (storable(response)) void cache.put(request, response.clone()).catch(() => null);
    return response;
  },
);

// A font version bump changes the filename, so the superseded entry would otherwise sit in storage
// forever. Sweep anything the current build doesn't name — the precache manifest is workbox's job,
// this cache is ours.
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(FONT_CACHE);
      const live = new Set<string>(FONT_URLS);
      for (const req of await cache.keys()) {
        if (!live.has(new URL(req.url).pathname)) await cache.delete(req);
      }
    })(),
  );
});

// `registerType: "autoUpdate"` means a fresh build should take over without a user gesture. With
// injectManifest we own that lifecycle: skip the waiting phase on install, claim open clients on
// activate. The message handler backs lib/pwa.ts's manual "tap to update" (postMessage SKIP_WAITING).
self.addEventListener("install", () => void self.skipWaiting());
clientsClaim();
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  // SAFETY: `ExtendableMessageEvent.data` is `any` — a structured clone from an arbitrary client.
  // Only the same-origin page can reach this worker, and lib/pwa.ts / lib/push.ts are the things
  // that post to it; the optional chain means any other payload simply fails the comparisons.
  const data = event.data as { type?: string; key?: string } | null;
  if (data?.type === "SKIP_WAITING") void self.skipWaiting();
  // FORK: the page hands over the VAPID public key after every successful subscribe, so a
  // `pushsubscriptionchange` that arrives with no old subscription to read the key off can still
  // re-subscribe against the right one (see healSubscription).
  if (data?.type === VAPID_KEY_MESSAGE && data.key) event.waitUntil(storeVapidKey(String(data.key)));
});

// ── FORK: push self-healing ─────────────────────────────────────────────────────────────────────
// The push service may rotate or expire this device's endpoint without the page ever running (the
// PWA is closed most of the day). The browser then fires `pushsubscriptionchange` HERE — no page,
// no localStorage, no lib/push.ts — and if nobody answers, the phone is silently unsubscribed until
// the next time Settings is opened. So the worker re-subscribes itself against the key the old
// subscription was bound to (or the one the page stored, below), registers the new endpoint with
// the bridge naming the old one as superseded, and tells any open page so it can update the
// endpoint it remembers. Every step is best-effort: a failure leaves things exactly as the browser
// left them, which is the state the page already knows how to recover from on its next open.

/** Where the page's VAPID key is kept: the Cache API is the one durable store a worker has. */
const META_CACHE = "collie-push-meta";
const VAPID_KEY_URL = "/__collie/vapid-key";

async function storeVapidKey(key: string): Promise<void> {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(VAPID_KEY_URL, new Response(key, { headers: { "content-type": "text/plain" } }));
  } catch {
    /* storage full or blocked — the change event will still try the old subscription's key */
  }
}

async function storedVapidKey(): Promise<string | null> {
  try {
    const cache = await caches.open(META_CACHE);
    const hit = await cache.match(VAPID_KEY_URL);
    return hit ? (await hit.text()) || null : null;
  } catch {
    return null;
  }
}

/** The event's shape — not in this TS lib yet, though every engine this PWA runs on fires it. */
interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
  readonly newSubscription: PushSubscription | null;
}

self.addEventListener("pushsubscriptionchange", (event: Event) => {
  // SAFETY: the browser dispatches this event type with exactly these two fields (Push API §3.5);
  // both are read as optional below, so an engine that omits one degrades to "no old key" rather
  // than throwing.
  const change = event as PushSubscriptionChangeEvent;
  change.waitUntil(healSubscription(change));
});

async function healSubscription(event: PushSubscriptionChangeEvent): Promise<void> {
  const old = event.oldSubscription;
  try {
    // Some engines mint the replacement themselves and hand it over; then there is nothing to
    // subscribe, only something to register.
    let next = event.newSubscription;
    if (!next) {
      const key = serverKeyFor(old?.options.applicationServerKey, await storedVapidKey());
      if (key === null) return; // the wrong key would subscribe to silence — do nothing
      next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const body = resubscribeBody(next.toJSON(), old?.endpoint);
    const res = await fetch("/api/subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", [XHR_HEADER_NAME]: XHR_HEADER_VALUE },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // A WindowClient's postMessage takes no target origin — the client IS same-origin by
    // construction (a worker only ever controls its own origin's windows); the lint rule below is
    // written for `window.postMessage`, which does.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    for (const c of windows) c.postMessage({ type: RESUBSCRIBED_MESSAGE, endpoint: body.endpoint });
  } catch {
    /* best-effort — see the note above */
  }
}

// ── Web Push ────────────────────────────────────────────────────────────────────────────────────
// The branching (suppress vs show vs clear, tag/title/renotify) lives in lib/push-decision so it's
// unit-tested; here we only parse the event, read client visibility, and run the side effect.
// Two different assets on purpose. `icon` is the large art: the mark on its tile, WITHOUT the
// maskable safe-zone padding, so it fills the notification slot instead of floating in a frame.
// `badge` is the small status-bar glyph: Android derives its SHAPE FROM THE ALPHA CHANNEL and tints
// the result, so it must be a monochrome silhouette on transparency. The maskable home-screen tile
// (`/web-app-manifest-192x192.png`) must never be used for either — it is opaque with no alpha, so
// Android stamps it on the icon's corner as a solid grey block.
const ICON = "/notification-icon-192x192.png";
const BADGE = "/badge-96x96.png";

self.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(handlePush(event));
});

async function anyVisibleClient(): Promise<boolean> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((c) => c.visibilityState === "visible");
}

/**
 * Whether this device's push service revokes a subscription that answers a push with no
 * notification — read off the live subscription's endpoint, because it is the push service that
 * decides, not the browser the page happens to render in.
 *
 * A throw or a missing subscription resolves to `true` (show), which is the direction that fails
 * safe: see `enforcesUserVisible`.
 */
async function mustShowNotification(): Promise<boolean> {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    return enforcesUserVisible(sub?.endpoint);
  } catch {
    return true;
  }
}

async function handlePush(event: PushEvent): Promise<void> {
  let payload: PushPayload = {};
  try {
    // SAFETY: `PushMessageData.json()` is typed `any` — it is the bridge's own push body, which
    // bridge/push.ts builds as a `PushPayload`. A body that isn't JSON at all throws into the catch
    // below; every field read downstream is optional, so a JSON body of another shape degrades to
    // the plain-text fallback rather than crashing the worker.
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    // Non-JSON / empty push — fall back to a plain-text body so we never silently drop it.
    payload = { body: event.data?.text() };
  }

  // Both reads in one round trip: WebKit revokes a subscription whose handler fails to post a
  // notification "in a timely manner", so the two questions that decide whether to post are asked
  // together rather than one after the other.
  const [visible, mustShow] = await Promise.all([anyVisibleClient(), mustShowNotification()]);
  const decision = decidePush(payload, visible, mustShow);
  if (decision.kind === "suppress") return; // a visible Collie tab already surfaces it in-app
  if (decision.kind === "clear") {
    // Retraction: close the slot and show nothing. Only reached on a push service that tolerates a
    // silent push (Chrome's budget); Apple's does not, and `decidePush` turns this into a quiet
    // replacement there instead — showNotification on the same tag closes the stale one for us.
    const stale = await self.registration.getNotifications({ tag: decision.tag });
    for (const n of stale) n.close();
    return;
  }
  // `renotify` and `actions` aren't in this TS lib's NotificationOptions yet, though both are
  // honoured by browsers that support them (renotify needs a tag; actions are shown on long-press
  // where the platform has no room for buttons).
  const options: NotificationOptions & { renotify?: boolean; actions?: { action: string; title: string }[] } = {
    body: decision.body,
    data: {
      paneId: decision.paneId,
      session: decision.session,
      host: decision.host,
      target: decision.target,
      agent: decision.agent,
      approve: decision.approve,
    } satisfies NotifData,
    icon: ICON,
    badge: BADGE,
    tag: decision.tag,
    renotify: decision.renotify,
  };
  if (decision.actions) options.actions = decision.actions;
  await self.registration.showNotification(decision.title, options);
}

// ── FORK: answering from the notification ───────────────────────────────────────────────────────
// A Yes/No button answers the pane's dialog without opening the app. NOTHING here decides what a
// button means: the bridge looked at the dialog when it raised the alert (bridge/prompt-peek.ts)
// and put the keystrokes for Yes and for No in the payload, BOUND to the dialog's own text. The
// worker posts exactly that — keys plus `expected_prompt` — and the bridge refuses to type unless
// that text is still at the tail of a fresh read (bridge/prompt-binding.ts). So a dialog that
// changed between the push and the tap is never answered, and the tap falls back to opening the
// pane exactly as a tap on the notification body does. The worker holds no grammar: it cannot,
// because the grammar's import graph reaches the page's environment probes (lib/env.ts).

async function answerFromNotification(data: NotifData, action: "yes" | "no"): Promise<boolean> {
  const approve = data.approve;
  if (!data.paneId || data.paneId === "test" || !approve) return false;
  const keys = action === "yes" ? approve.yes : approve.no;
  if (!Array.isArray(keys) || keys.length === 0 || !approve.region) return false;
  // The URL spells the scope as `s`/`h` (lib/scope); the wire spells it `session`/`host`.
  const params = new URLSearchParams(scopeSearch({ host: data.host, session: data.session }));
  const wire = new URLSearchParams();
  const host = params.get("h");
  const session = params.get("s");
  if (host) wire.set("host", host);
  if (session) wire.set("session", session);
  const q = wire.toString();
  try {
    const send = await fetch(`/api/pane/${encodeURIComponent(data.paneId)}/keys${q ? `?${q}` : ""}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", [XHR_HEADER_NAME]: XHR_HEADER_VALUE },
      body: JSON.stringify({ keys, expected_prompt: approve.region }),
    });
    return send.ok;
  } catch {
    return false;
  }
}

// Tap a notification: an update push routes to the Updates page under Settings; everything else deep-links to the agent's
// pane on the machine and in the session it lives in (never act on it blind — the reply lives
// in-app; a cross-host blind action would be strictly worse than a same-host one). An old cached SW
// that predates `target` simply ignores it and takes the pane path, opening "/" for a pushed update
// — acceptable, and the same degradation `host` gets.
//
// The URL itself is built by lib/push-decision's notificationPath, on top of lib/scope's
// `scopeSearch`: the query this file used to hand-inline is now the app's own, so the string
// compared in openPath below is byte-identical to the one the router produces for that scope.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  // The notification is closed AFTER the open attempt, and only when it worked. Closing first is
  // what made the 1.2.0 regression silent: the notification vanished, `openWindow` was then refused
  // for want of user activation, and the tap left the user with nothing to tap again. `close()`
  // neither grants nor consumes activation, so deferring it costs nothing, and on a failure the
  // notification stays on the shade as a second chance.
  //
  // SAFETY: `Notification.data` is `any` — but it is OUR data: the only writer is `handlePush`
  // above, in this same file, which attaches a `NotifData`. Every field is optional and defaulted.
  const data = (event.notification.data as NotifData | null) ?? {};
  const action = event.action === "yes" || event.action === "no" ? event.action : null;
  event.waitUntil(
    (async () => {
      // FORK: a Yes/No button answers in place and closes the notification; a refused or failed
      // answer opens the pane instead, so the tap always lands somewhere the operator can act.
      if (action !== null && (await answerFromNotification(data, action))) {
        event.notification.close();
        return;
      }
      const outcome = await openPath(notificationPath(data));
      if (outcome !== "failed") event.notification.close();
    })(),
  );
});

// Focus an existing Collie tab (navigating it to `path`) or open a new one. `path` is
// origin-relative. The choice lives in lib/notification-open, which also documents why a window is
// opened before any discarded client is navigated (#147, and the Android regression that fix grew).
// The `matchAll` below is deliberately the ONLY awaited call between the tap and `openWindow`.
async function openPath(path: string): Promise<OpenOutcome> {
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return openNotificationTarget({
    url,
    clients: windows,
    openWindow: (target) => self.clients.openWindow(target),
  });
}
