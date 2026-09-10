import { asJsonString, parseJsonObject } from "@/lib/json";
import { panePath } from "@/lib/nav";
import { normalizeScope, type Scope } from "@/lib/scope";

// FORK: the pane the operator opened most recently, so `/pane/last` can land there.
//
// The route exists for the phone's own automation: an iOS Shortcut (or the manifest's share
// target) can open a URL but cannot know a pane id, and "the one I had open" is the pane those
// almost always mean. A per-DEVICE fact — it is about what this phone was looking at — so it lives
// in localStorage beside the drafts and never touches the bridge.

const KEY = "collie:last-pane:v1";

interface LastPane {
  paneId: string;
  host?: string;
  session?: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // locked-down / SSR contexts throw on the accessor itself
  }
}

/** Record that `paneId` (under `scope`) is the pane on screen. Called by the pane route. */
export function rememberLastPane(paneId: string, scope?: Scope): void {
  const store = storage();
  if (!store || paneId === "") return;
  const { host, session } = normalizeScope(scope);
  const entry: LastPane = { paneId };
  if (host) entry.host = host;
  if (session) entry.session = session;
  try {
    store.setItem(KEY, JSON.stringify(entry));
  } catch {
    // Quota / private mode — a forgotten last pane costs one redirect to the dashboard.
  }
}

/** The stored pane, or null when this device has never opened one (or storage is gone). */
export function lastPane(): { paneId: string; scope: Scope } | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    if (raw === null) return null;
    const entry = parseJsonObject(raw);
    if (!entry) return null;
    const paneId = asJsonString(entry.paneId);
    if (paneId === undefined || paneId === "") return null;
    const scope: Scope = {};
    const host = asJsonString(entry.host);
    const session = asJsonString(entry.session);
    if (host !== undefined) scope.host = host;
    if (session !== undefined) scope.session = session;
    return { paneId, scope };
  } catch {
    return null;
  }
}

/**
 * Where `/pane/last?…` should go: the remembered pane's path, with the caller's own query string
 * (a `?send=` from a Shortcut) carried across so the composer is seeded on arrival. Null when
 * nothing is remembered — the caller falls back to the dashboard.
 */
export function lastPanePath(search: string): string | null {
  const last = lastPane();
  if (last === null) return null;
  const base = panePath(last.paneId, last.scope);
  const extra = new URLSearchParams(search);
  // `h` / `s` in the incoming query would be the caller's guess at the scope; the remembered pane
  // knows its own, so only the seed rides across.
  const send = extra.get("send");
  if (send === null || send === "") return base;
  return `${base}${base.includes("?") ? "&" : "?"}send=${encodeURIComponent(send)}`;
}

/** Test seam. */
export function __clearLastPane(): void {
  storage()?.removeItem(KEY);
}
