// The live feed's client half: one streamed `fetch` of `GET /api/events`, read as Server-Sent
// Events, and the health flag the cadence and the pane loader read.
//
// WHY NOT `EventSource`. Since upstream 1.18 every `/api` read needs the pairing token in an
// `Authorization` header (ADR 0086, lib/pairing.ts `authHeader`), and an EventSource cannot send a
// header. The stream was refused with a 403, EventSource does not retry a refusal, and the page fell
// back to slow polling without a word. A fetch carries the same headers every other read carries
// (lib/api.ts `doReq`), so the stream is read here by hand: `event:` / `data:` / `retry:` lines, and
// the reconnect the browser used to own.
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

import { XHR_HEADER, XHR_HEADER_VALUE } from "./api";
import { mounted } from "./base-path";
import { asJsonString, parseJsonObject } from "./json";
import { authHeader } from "./pairing";
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
export type Poke =
  | { kind: "snapshot"; etag?: string }
  | { kind: "pane"; paneId: string; etag?: string }
  // FORK: the artifacts library changed (bridge/artifacts.ts). No stamp: the list is small and is
  // simply refetched by whoever is showing it (lib/artifacts.ts).
  | { kind: "artifacts" };

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
  supportOverride = null;
}

/**
 * Tests only: whether this platform may open the stream. `null` goes back to the default.
 *
 * Under Vitest the default is OFF. jsdom has a `fetch` (MSW's), so without this every component test
 * that mounts the poller would open a stream nobody serves; with EventSource the same default came
 * for free, because jsdom has none. A test of the stream turns it on.
 */
export function __setLiveFeedSupported(on: boolean | null): void {
  supportOverride = on;
}

let supportOverride: boolean | null = null;

function streamingSupported(): boolean {
  if (supportOverride !== null) return supportOverride;
  if (import.meta.env.MODE === "test") return false;
  // Read off `globalThis`, as `EventSource` was: lib.dom types all four as always present, and an old
  // WebView or an embedded browser may still lack one.
  return (
    globalThis.fetch !== undefined &&
    globalThis.ReadableStream !== undefined &&
    globalThis.AbortController !== undefined &&
    globalThis.TextDecoder !== undefined
  );
}

// ── The stream ────────────────────────────────────────────────────────────────

/**
 * Whether a stream can be opened for this scope at all. A member host's panes are read through the
 * lead's forward, and the bridge serves no stream for them (it answers 404) — so the page does not
 * ask, rather than opening a connection that errors and reconnects every three seconds.
 */
export function liveFeedAvailable(scope?: Scope): boolean {
  if (!streamingSupported()) return false;
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
  if (kind === "artifacts") return { kind: "artifacts" };
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

/** The wait before reconnecting when the bridge has not said (`retry:`); the bridge sends 3000. */
export const LIVE_FEED_RETRY_MS = 3000;
/** The longest wait between two attempts, however many failed in a row. */
export const LIVE_FEED_RETRY_MAX_MS = 60_000;

/**
 * Read a Server-Sent Events body to its end, handing each dispatched event to `onEvent` and each
 * `retry:` to `onRetry`. Comments (`: ping`) and `id:` are dropped; an event cut off by the end of
 * the body is not dispatched (the SSE rule). A line or a frame may arrive split across chunks.
 *
 * Exported for the unit test.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (type: string, data: string) => void,
  onRetry: (ms: number) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let type = "";
  let data: string[] = [];
  const line = (text: string) => {
    if (text === "") {
      if (data.length > 0) onEvent(type === "" ? "message" : type, data.join("\n"));
      type = "";
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
    else if (field === "retry" && /^\d+$/.test(value)) onRetry(Number(value));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const at = buffer.search(/\r|\n/);
      if (at === -1) break;
      // A CR that ends the chunk may be the first half of a CRLF: wait for the next chunk.
      if (buffer[at] === "\r" && at === buffer.length - 1) break;
      const width = buffer.startsWith("\r\n", at) ? 2 : 1;
      line(buffer.slice(0, at));
      buffer = buffer.slice(at + width);
    }
  }
}

/**
 * Open the stream, and keep it open until `close()`.
 *
 * It is `fetch` with the pairing token and the XHR header (see the file header), so this owns the
 * reconnect the browser used to: after the stream ends, fails, or is refused, the next attempt waits
 * the bridge's `retry:` ({@link LIVE_FEED_RETRY_MS} until it says), doubled for each attempt in a row
 * that did not open, up to {@link LIVE_FEED_RETRY_MAX_MS}. A refusal — the pairing gate's 403, the
 * identity proxy's sign-in, a bridge too old to serve the route — is the stream being down, and it is
 * retried on that backoff rather than given up on: EventSource gave up, which is how a token problem
 * turned into slow polling for the rest of the page's life.
 *
 * The caller sees each open and drop once (`onHealth`), and the poller carries on at its own cadence
 * while the stream is down, which is what happened before the stream existed.
 */
export function openLiveFeed(url: string, handlers: LiveFeedHandlers): LiveFeed {
  let closed = false;
  let up = false;
  let failures = 0;
  let retryMs = LIVE_FEED_RETRY_MS;
  let attempt: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flip = (next: boolean) => {
    if (up === next) return;
    up = next;
    setHealthy(next);
    handlers.onHealth(next);
  };
  const onEvent = (type: string, data: string) => {
    if (type !== "poke") return;
    const poke = parsePoke(data);
    if (poke) handlers.onPoke(poke);
  };
  const connect = async () => {
    timer = null;
    const ctl = new AbortController();
    attempt = ctl;
    try {
      const res = await fetch(mounted(url), {
        signal: ctl.signal,
        cache: "no-store",
        // As lib/api.ts `apiFetch`: a proxy's sign-in redirect is a refusal, not a page to follow.
        redirect: "manual",
        headers: { accept: "text/event-stream", [XHR_HEADER]: XHR_HEADER_VALUE, ...authHeader() },
      });
      if (!res.ok || res.body === null) {
        void res.body?.cancel().catch(() => {});
      } else {
        flip(true);
        failures = 0;
        await readEventStream(res.body, onEvent, (ms) => {
          retryMs = ms;
        });
      }
    } catch {
      // A transport failure, or the abort `close()` sent: both end this attempt, below.
    }
    if (closed || attempt !== ctl) return;
    attempt = null;
    flip(false);
    failures += 1;
    timer = setTimeout(() => void connect(), Math.min(retryMs * 2 ** (failures - 1), LIVE_FEED_RETRY_MAX_MS));
  };
  void connect();
  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      attempt?.abort();
      attempt = null;
      flip(false);
    },
  };
}
