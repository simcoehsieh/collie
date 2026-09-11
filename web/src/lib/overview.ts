import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { fetchHistory, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { hasDocument } from "@/lib/env";
import { newestReply, replyProse } from "@/lib/latest-reply";
import { useLiveFeedHealthy } from "@/lib/live-feed";
import { authHeader } from "@/lib/pairing";
import { normalizeScope, paneScopeKey, scopeSearch, type Scope } from "@/lib/scope";
import type { AgentView, PaneReadResponse } from "@/lib/types";

// FORK: the data half of the Overview screen — every agent pane's last few lines, side by side.
//
// ── WHY THIS IS A HOOK OVER THE ROOT SNAPSHOT AND NOT A ROUTE LOADER ─────────────────────────
// The obvious shape is a loader like `paneLoader`, re-run by the root poll. It would need the herd
// to know which panes to read, and a child loader cannot see its parent's data: it would have to
// call `fetchSnapshot` itself, which is a second snapshot request on every tick beside the root's
// own. The route already renders under `RootLayout`, whose snapshot is the herd; the hook reads it
// off `useRootData()` and fetches only the tails. The show-first-fetch-second shape the loaders
// have is kept — a module cache paints on the way in, the reads land a beat later.
//
// ── WHY THE READ DOES NOT GO THROUGH `fetchPane` ───────────────────────────────────────────────
// `fetchPane` sends `x-collie-seen`, and the bridge takes that header as the operator LOOKING at
// the pane: it stamps `lastSeenAt`, which is what moves a finished agent out of "Ready · unseen"
// (lib/triage.ts). An overview that read four panes through it would clear four alerts by being
// opened. So this reads the same route without the header — `marksPaneSeen` in bridge/server.ts
// answers false for a plain GET that does not carry it — and the ETag cache here is its own,
// because sharing `fetchPane`'s would make the next real open of the pane a 304 against a body
// this screen fetched at eight lines.

// ── FORK (2026-09-11): THE CARDS RIDE THE LIVE FEED ──────────────────────────────────────────
// This screen used to run a 3 s timer entirely outside `use-polling.ts`, so `LIVE_FEED_MS`'s 30 s
// relaxation never reached it: 20 requests a minute PER CARD, through an identity proxy, from a
// screen that is by design a glance. At six panes that measured 123 req/min.
//
// Now it declares which panes it is showing (`setWatchedTailPanes`), the ONE stream the page already
// has names them (`use-polling.ts` reads the store, `/api/events?pane=…&pane=…`), and a card is
// re-read when the bridge says THAT card moved. The 3 s timer stays as the fallback for a stream
// that is down, and a slow safety net runs under a healthy one for a poke that never arrived.
//
// ONE STREAM, NOT ONE PER CARD. `openLiveFeed` writes a single shared health flag, so a second
// EventSource would make that flag flap between two connections' fortunes — and the connection is
// the expensive thing here, not the subscription.

/** Lines asked of the bridge per pane. A few more than are shown, so a trailing blank or a
 *  status row does not leave the card short. */
export const TAIL_LINES = 12;
/** Lines shown per card. */
export const TAIL_SHOWN = 6;
/** How often the tails are re-read while the screen is visible and the stream is DOWN — the
 *  mirror's own idle gap, because four small reads at that rate cost less than one pane poll at the
 *  fast one. */
export const TAIL_REFRESH_MS = 3000;
/** The beat under a HEALTHY stream: a safety net for a poke that never arrived, nothing more. Ten
 *  times the gap above, for `LIVE_FEED_MS`'s reason — the bridge now says when a card moved, so the
 *  timer only has to bound the cost of a dropped line. */
export const TAIL_SAFETY_MS = 30_000;
/** Turns asked of the journal for a resting pane's reply — the newest spoken turn may sit behind a
 *  run of tool calls, so ask for a few (hooks/use-latest-reply.ts uses the same number). */
const REPLY_TURNS = 8;

export interface PaneTail {
  lines: string[];
  /** When this tail was read. */
  at: number;
  /**
   * FORK: the agent's newest prose turn, when this pane is RESTING and its journal had one.
   *
   * The raw tail is the right thing for a pane that is working — it is what is happening. It is the
   * wrong thing for a pane that has finished: an agent's TUI runs on the alternate screen, so the
   * last six rows of a done pane are its input box and its status line, not what it said. That is
   * the same gap `use-latest-reply` closes on the pane screen, and it is closed here the same way —
   * off the journal, and only once the mirror has stopped moving.
   */
  reply?: string[];
}

/** The route, carrying the scope like every other path helper (lib/nav.ts). */
export function overviewPath(scope?: Scope): string {
  return `/overview${scopeSearch(scope)}`;
}

/**
 * The plain-text tail of a mirror: ANSI stripped, trailing blank rows dropped, the last
 * {@link TAIL_SHOWN} rows kept. Exported for the test.
 */
export function tailOf(text: string, shown: number = TAIL_SHOWN): string[] {
  const plain = parseAnsi(text)
    .map((seg) => seg.text)
    .join("");
  const rows = plain.split("\n").map((row) => row.replace(/\s+$/u, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.slice(-shown);
}

// ── The store ─────────────────────────────────────────────────────────────
const tails = new Map<string, PaneTail>();
const etags = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const fn of listeners) fn();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function snapshot(): number {
  return version;
}

/** The last tail read for a pane, if any — what paints before the first read lands. */
export function tailFor(scope: Scope | undefined, paneId: string): PaneTail | undefined {
  return tails.get(paneScopeKey(scope, paneId));
}

// The API takes `host` / `session` query params (lib/api.ts `withScope`); the route helper above
// takes the short route ones (`h` / `s`). The five lines are repeated here rather than exported
// from api.ts so this module owns no line in that file.
function apiUrl(paneId: string, scope: Scope | undefined): string {
  const { host, session } = normalizeScope(scope);
  let out = `/api/pane/${encodeURIComponent(paneId)}?lines=${TAIL_LINES}`;
  if (host) out += `&host=${encodeURIComponent(host)}`;
  if (session) out += `&session=${encodeURIComponent(session)}`;
  return out;
}

/**
 * One read. Never throws: a failed read leaves the previous tail in place.
 *
 * `resting` says this pane's status is one the operator reads for WHAT IT SAID rather than for what
 * it is doing (done, blocked, idle — see `restingPane`). For those, an UNCHANGED read is the settle
 * signal: the mirror held still across a whole gap, so the newest journal turn is fetched once and
 * kept. That is `use-latest-reply`'s discipline, with a 304 standing in for its timer — cheaper, and
 * exactly as conservative, because a streaming reply never produces one. A read that MOVED throws
 * the held reply away: the screen changing is the agent (or the operator) doing the next thing.
 */
export async function readTail(
  paneId: string,
  scope: Scope | undefined,
  signal?: AbortSignal,
  resting = false,
): Promise<void> {
  const key = paneScopeKey(scope, paneId);
  const headers = new Headers({ [XHR_HEADER]: XHR_HEADER_VALUE, ...authHeader() });
  const etag = etags.get(key);
  if (etag) headers.set("if-none-match", etag);
  try {
    const res = await fetch(apiUrl(paneId, scope), { headers, redirect: "manual", signal });
    if (res.status === 304) {
      await settleReply(key, paneId, scope, signal, resting);
      return;
    }
    if (!res.ok) return;
    // SAFETY: a 200 on `/api/pane/:id` is the bridge's own `PaneReadResponse` by contract — the
    // same contract `fetchPane` rests on.
    const body = (await res.json()) as PaneReadResponse;
    const tag = res.headers.get("etag");
    if (tag) etags.set(key, tag);
    // No `reply` key: the mirror moved, so whatever was quoted describes a screen that is gone.
    tails.set(key, { lines: tailOf(body.text), at: Date.now() });
    bump();
  } catch {
    // Network / abort — the card keeps what it had.
  }
}

/**
 * The newest prose turn for a pane whose mirror has settled, read once and then left alone.
 *
 * Guarded three ways, in this order, because this is the only read on the screen that touches a
 * file: the pane must be resting, it must already have a tail to attach the reply to, and it must
 * not have one already. `fetchHistory` validates on its own ETag (lib/api.ts), so even the repeat
 * that a re-mount causes costs a 304 rather than a page of turns.
 */
async function settleReply(
  key: string,
  paneId: string,
  scope: Scope | undefined,
  signal: AbortSignal | undefined,
  resting: boolean,
): Promise<void> {
  if (!resting) return;
  const held = tails.get(key);
  if (held === undefined || held.reply !== undefined) return;
  try {
    const page = await fetchHistory(paneId, { limit: REPLY_TURNS }, scope, signal);
    if (!page.available) return;
    const newest = newestReply(page.entries);
    if (newest === null) return;
    const lines = replyLines(replyProse(newest));
    if (lines.length === 0) return;
    // Re-read rather than closing over `held`: a tail read may have landed while this was in flight,
    // and a reply must never be attached to a screen that has since moved on.
    const now = tails.get(key);
    if (now === undefined || now.reply !== undefined) return;
    tails.set(key, { ...now, reply: lines });
    bump();
  } catch {
    // An enhancement over the tail, and the tail is still right there — see use-latest-reply.
  }
}

/** The first {@link TAIL_SHOWN} non-empty lines of a reply, which is what a card has room for. */
export function replyLines(prose: string, shown: number = TAIL_SHOWN): string[] {
  return prose
    .split("\n")
    .map((row) => row.replace(/\s+$/u, ""))
    .filter((row, i, rows) => row !== "" || (i > 0 && rows[i - 1] !== ""))
    .slice(0, shown);
}

/**
 * Whether a pane is one the operator reads for WHAT IT SAID rather than for what it is doing.
 *
 * Exactly `done` and `idle` — an agent that has finished and is sitting at its input box, where the
 * bottom six rows are that box and its status line and are identical across every finished agent.
 * Three exclusions, each for its own reason:
 *   - `working`: a card quoting the last reply mid-answer would show the PREVIOUS message under a
 *     spinner, which is worse than showing nothing;
 *   - `blocked`: what a blocked pane needs the operator to read is the question on its screen — the
 *     permission dialog IS the content, and the journal's last spoken turn is what came before it;
 *   - a shell: no journal, and its mirror is the content by definition.
 */
export function restingPane(pane: AgentView): boolean {
  if (pane.kind === "shell") return false;
  return pane.status === "done" || pane.status === "idle";
}

/** Test seam. */
export function __resetTails(): void {
  tails.clear();
  etags.clear();
  watchedPanes = [];
  watchedScope = undefined;
  version = 0;
  emitWatched();
}

// ── The pane set this screen wants the page's ONE stream to name ──────────────────────────────

let watchedPanes: readonly string[] = [];
let watchedScope: Scope | undefined;
const watchedListeners = new Set<() => void>();

function emitWatched(): void {
  for (const fn of watchedListeners) fn();
}

function subscribeWatched(cb: () => void): () => void {
  watchedListeners.add(cb);
  return () => {
    watchedListeners.delete(cb);
  };
}

/** Live read — safe from `use-polling.ts`'s effect. Empty everywhere but the Overview screen. */
export function watchedTailPanes(): readonly string[] {
  return watchedPanes;
}

/** The hook view, so the poller re-opens its stream when the grid's panes change. */
export function useWatchedTailPanes(): readonly string[] {
  return useSyncExternalStore(subscribeWatched, watchedTailPanes, watchedTailPanes);
}

/**
 * A pane poke off the page's stream, offered to this screen first.
 *
 * Returns whether it was CLAIMED. A poke for a card on this grid is answered by re-reading that one
 * card — not by revalidating every loader on the page, which is what the poller would otherwise do
 * for a pane nothing on screen is showing. A poke whose stamp matches what this screen already holds
 * is claimed and ignored, which is the same skip `alreadyHeld` makes for the pane route.
 */
export function deliverTailPoke(paneId: string, etag?: string): boolean {
  const key = paneScopeKey(watchedScope, paneId);
  if (!watchedPanes.includes(paneId)) return false;
  if (etag !== undefined && etags.get(key) === etag) return true;
  void readTail(paneId, watchedScope, undefined, restingSet.has(paneId));
  return true;
}

/** Which of the watched panes are resting, so a poke-driven read knows whether to chase a reply. */
let restingSet = new Set<string>();

/**
 * Keep the tails of `agents` fresh while mounted.
 *
 * One parallel read on the way in, another every time the herd snapshot changes (`ts`), and in
 * between: a POKE per card off the page's own live feed, with a timer underneath. The timer is the
 * old {@link TAIL_REFRESH_MS} beat — scaled by `slow` (Low power) — while the stream is down, and a
 * {@link TAIL_SAFETY_MS} safety net while it is up. Both are skipped while the tab is hidden.
 *
 * Returns a version counter so the caller re-renders on a landed read; the tails themselves are read
 * with {@link tailFor}.
 */
export function useOverviewTails(
  agents: readonly AgentView[],
  scope: Scope | undefined,
  ts: number,
  slow = false,
): number {
  const v = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The ids as one string, so a poll that re-lists the same herd in a fresh array is not a reason
  // to re-subscribe.
  const ids = useMemo(() => agents.map((a) => a.paneId).join(" "), [agents]);
  // Which of them are RESTING, likewise as one string — a status flip is a reason to re-read, and it
  // is what decides whether a card chases its reply.
  const resting = useMemo(() => agents.filter(restingPane).map((a) => a.paneId).join(" "), [agents]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // A healthy stream is what retires the 3 s timer. Read as a hook, not off the module, so the
  // effect re-runs on the transition in both directions.
  const streamHealthy = useLiveFeedHealthy();

  useEffect(() => {
    if (ids === "") return;
    const list = ids.split(" ");
    // Publish the set the page's ONE stream should name, and the scope its pokes are about. Cleared
    // on unmount, so leaving this screen takes the pane subscriptions with it.
    setWatchedTails(list, resting === "" ? [] : resting.split(" "), scopeRef.current);
    let abort = new AbortController();
    const readAll = () => {
      if (hasDocument() && document.hidden) return;
      abort.abort();
      abort = new AbortController();
      void Promise.all(
        list.map((id) => readTail(id, scopeRef.current, abort.signal, restingSet.has(id))),
      );
    };
    readAll();
    const timer = window.setInterval(
      readAll,
      streamHealthy ? TAIL_SAFETY_MS : slow ? TAIL_REFRESH_MS * 3 : TAIL_REFRESH_MS,
    );
    const onVisible = () => {
      if (!document.hidden) readAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      abort.abort();
      setWatchedTails([], [], undefined);
    };
    // `ts` is here on purpose: a snapshot that moved is a herd whose tails may have.
  }, [ids, resting, ts, slow, streamHealthy]);

  return v;
}

function setWatchedTails(
  panes: readonly string[],
  resting: readonly string[],
  scope: Scope | undefined,
): void {
  watchedScope = scope;
  restingSet = new Set(resting);
  // Compared before publishing: `use-polling.ts` re-opens its stream on this value, and a fresh
  // array carrying the same ids would tear a working connection down on every poll.
  if (panes.length === watchedPanes.length && panes.every((id, i) => watchedPanes[i] === id)) return;
  watchedPanes = panes;
  emitWatched();
}
