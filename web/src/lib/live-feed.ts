// The live feed's client half: one EventSource on `GET /api/events`, and the health flag the cadence
// and the pane loader read.
//
// WHAT A POKE IS. The bridge writes a line whenever the herd or the followed pane moves. The page
// answers by running the loaders it always ran — the snapshot and the pane read — so a poke is a
// reason to fetch, never a body (ARCHITECTURE.md's poll-as-truth stays intact: a missed poke costs
// one safety-net interval, `use-polling.ts` keeps that slow poll going underneath).
//
// WHY IT LIVES BESIDE THE POLLER AND NOT INSIDE IT. `use-polling.ts` owns WHEN to fetch; this owns
// the wire. Whether the stream is up is a fact the pane loader needs too (a page whose stream is down
// long-polls instead), and a loader cannot read a hook — so the flag is a module store with a
// `useSyncExternalStore` view, the same shape `lib/poll-intent.ts` has.

import { useSyncExternalStore } from "react";

import { asJsonString, parseJsonObject } from "./json";
import { normalizeScope, type Scope } from "./scope";

/**
 * One line off the stream. Mirrors `bridge/events.ts` → `PokeEvent`.
 *
 * `etag` names the VERSION the poke is about. It stays inside poll-as-truth — a version is still
 * *when*, not what — and it is what lets the page skip a fetch it can prove would answer 304.
 * Optional on both kinds: an older bridge sends none, and the snapshot's stamp only matches where
 * nothing rewrites the body on its way out (see the bridge's own note). A poke with no stamp, or one
 * the page cannot match, is the poke that always shipped.
 */
export type Poke = { kind: "snapshot"; etag?: string } | { kind: "pane"; paneId: string; etag?: string };

export interface LiveFeedHandlers {
  onPoke: (poke: Poke) => void;
  /** The stream opened (true) or dropped (false). Fires on each transition, never twice in a row. */
  onHealth: (healthy: boolean) => void;
}

export interface LiveFeed {
  close(): void;
}

// ── The health store ──────────────────────────────────────────────────────────

let healthy = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Live read — safe from a loader or a timer. */
export function isLiveFeedHealthy(): boolean {
  return healthy;
}

/** The hook view, for the poller. */
export function useLiveFeedHealthy(): boolean {
  return useSyncExternalStore(subscribeHealth, isLiveFeedHealthy, () => false);
}

function subscribeHealth(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setHealthy(next: boolean): void {
  if (healthy === next) return;
  healthy = next;
  emit();
}

/** Tests only. */
export function __resetLiveFeed(): void {
  setHealthy(false);
}

// ── The stream ────────────────────────────────────────────────────────────────

/**
 * Whether a stream can be opened for this scope at all. A member host's panes are read through the
 * lead's forward, and the bridge serves no stream for them (it answers 404) — so the page does not
 * ask, rather than opening a connection that errors and reconnects every three seconds.
 */
export function liveFeedAvailable(scope?: Scope): boolean {
  if (globalThis.EventSource === undefined) return false;
  return normalizeScope(scope).host === undefined;
}

/**
 * The stream's URL for a scope and, optionally, the panes the page is following at a window.
 *
 * ONE pane is the pane screen; SEVERAL is the Overview grid, which names every visible card so its
 * tails ride this stream instead of a timer of their own (lib/overview.ts). The bridge takes a
 * repeated `?pane=` (`watchedPanes` in bridge/server.ts) and caps the set; `lines` is the window all
 * of them are read at, which is the window the page will fetch them at.
 */
export function liveFeedUrl(
  scope?: Scope,
  panes?: string | readonly string[] | null,
  lines?: number,
): string {
  const params = new URLSearchParams();
  const { session } = normalizeScope(scope);
  if (session) params.set("session", session);
  // One pane may be named as the bare id (the pane screen's call site, unchanged) or as a set.
  const list = (Array.isArray(panes) ? panes : panes ? [panes] : []).filter((id) => id !== "");
  for (const id of list) params.append("pane", id);
  if (list.length > 0 && lines) params.set("lines", String(lines));
  const q = params.toString();
  return q ? `/api/events?${q}` : "/api/events";
}

/** Parse one `data:` payload. Anything that is not one of the two shapes is dropped. */
export function parsePoke(data: string): Poke | null {
  const parsed = parseJsonObject(data);
  if (!parsed) return null;
  const kind = asJsonString(parsed.kind);
  // Assigned, never conditionally spread: a frame without a stamp must produce a poke with NO `etag`
  // key, so "the bridge said nothing" and "the bridge said empty" cannot be confused downstream.
  const etag = asJsonString(parsed.etag);
  if (kind === "snapshot") {
    const poke: Poke = { kind: "snapshot" };
    if (etag) poke.etag = etag;
    return poke;
  }
  if (kind === "pane") {
    const paneId = asJsonString(parsed.paneId);
    if (paneId !== undefined && paneId !== "") {
      const poke: Poke = { kind: "pane", paneId };
      if (etag) poke.etag = etag;
      return poke;
    }
  }
  return null;
}

/**
 * Open the stream. The browser owns reconnection (EventSource retries on its own, at the `retry:`
 * the bridge sent); this only reports each open/drop to the caller and marks the shared flag.
 *
 * A refused stream — the identity proxy's session expired, a bridge too old to serve the route — is
 * an `error` with `readyState === CLOSED`, which EventSource does NOT retry. The caller sees
 * `onHealth(false)` and the poller carries on at its own cadence, which is what happened before the
 * stream existed.
 */
export function openLiveFeed(url: string, handlers: LiveFeedHandlers): LiveFeed {
  const source = new EventSource(url);
  let up = false;
  const flip = (next: boolean) => {
    if (up === next) return;
    up = next;
    setHealthy(next);
    handlers.onHealth(next);
  };
  source.addEventListener("open", () => flip(true));
  source.addEventListener("error", () => flip(false));
  source.addEventListener("poke", (event) => {
    // SAFETY: a named event on an EventSource is always dispatched as a MessageEvent whose `data`
    // is the frame's text (the platform's own contract for `event:` lines); the listener API types
    // it as the base Event only because the name is a free string.
    const poke = parsePoke((event as MessageEvent<string>).data);
    if (poke) handlers.onPoke(poke);
  });
  return {
    close() {
      source.close();
      flip(false);
    },
  };
}
