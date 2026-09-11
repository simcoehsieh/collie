// The phone's live feed: a per-session pane-read cache that also WATCHES the panes somebody is
// looking at, and the fan-out that turns "something moved" into one line on an open SSE stream.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
// Every read the phone makes crosses a tunnel and an identity proxy — measured at ~175 ms a round
// trip on a warm connection, against 1–2 ms for the bridge itself. Polling a followed mirror at
// 1 Hz therefore spends the whole second on the wire and none of it on the answer, and it still
// shows a change up to a second late. The multiplexer, meanwhile, sits on a local socket and
// publishes NO event for pane output (HERDR_API.md: `pane.output_matched` needs a pattern; there is
// no "content changed"), so the only thing that can notice a mirror move promptly is something
// reading it locally, often.
//
// So the bridge reads it. A pane a client has declared interest in is re-read every `watchMs` over
// the local socket, the result is kept, and the moment its bytes differ from the last read the
// interested streams are told `{kind:"pane", paneId}`. The phone then fetches — one request, through
// the same route it always used, answered from this cache with NO second multiplexer read — and the
// fetch is a `304` whenever the poke was for a change it already holds.
//
// ── WHAT IT IS NOT ─────────────────────────────────────────────────────────────
// Not state. ARCHITECTURE.md chose poll-as-truth: the snapshot and the pane read stay the only two
// places the phone learns anything, and a line on the stream is a POKE to run them, never a body. A
// missed poke costs one safety-net interval (the client keeps a slow poll going underneath), never
// correctness. That is the same promise `EventPoker` makes to the engine, one hop further out.
//
// Not a subscription to the multiplexer. Herdr's own stream still reaches `EventPoker`, and the
// poker's debounced poke is forwarded here as `{kind:"snapshot"}`; this module adds the one thing
// that stream cannot carry, and nothing else.

import type { PaneReadResponse } from "./types.ts";

/** What one pane read produced, held together with the ETag that names those exact bytes. */
export interface PaneReadEntry {
  readonly paneId: string;
  readonly lines: number;
  /** The serialised {@link PaneReadResponse} — hashed for the ETag, and what the route sends. */
  readonly body: string;
  readonly data: PaneReadResponse;
  readonly etag: string;
  /** When it was read (ms on the injected clock). */
  readonly at: number;
}

/** A read that failed: the multiplexer's detail, for the 502 the route has always answered. */
export interface PaneReadFailure {
  readonly ok: false;
  readonly detail: string;
}

export type PaneReadResult = { ok: true; entry: PaneReadEntry } | PaneReadFailure;

/**
 * The one read this module knows how to do: `(paneId, lines)` → the serialised body and its ETag,
 * or the failure. Injected so the class is exercised with a fake under `bun test` and the real
 * multiplexer call stays where every other one is (server.ts).
 */
export type PaneReader = (
  paneId: string,
  lines: number,
) => Promise<{ ok: true; body: string; data: PaneReadResponse; etag: string } | PaneReadFailure>;

export interface PaneReadsOptions {
  /** How long an unwatched read stays fresh. Two polls landing inside it share one read. */
  ttlMs?: number;
  /** How often a WATCHED pane is re-read over the local socket. */
  watchMs?: number;
  now?: () => number;
}

/** Cache TTL for a read nobody is watching: long enough to coalesce a second tab's poll, short
 *  enough that a plain poller never sees a screen older than its own interval. */
export const PANE_READ_TTL_MS = 250;
/** The local re-read cadence for a watched pane. Each read is ~1 ms on the socket; 400 ms is the
 *  point past which a followed mirror stops reading as live. */
export const PANE_WATCH_MS = 400;

type ChangeListener = (paneId: string, entry: PaneReadEntry) => void;

function keyOf(paneId: string, lines: number): string {
  return `${paneId}\u0000${lines}`;
}

/**
 * A per-session pane-read cache with watch-and-notify.
 *
 * Three things share one table: the route's own reads (cached for {@link PANE_READ_TTL_MS},
 * concurrent duplicates coalesced onto one in-flight promise), the watcher's reads (every
 * {@link PANE_WATCH_MS} for any `(pane, lines)` with a live interest count), and the long-poll's wait
 * (a promise that settles when the entry's ETag moves). Because the watcher writes into the same
 * table the route reads from, a poked client's fetch is answered from memory.
 */
export class PaneReads {
  private readonly cache = new Map<string, PaneReadEntry>();
  private readonly inflight = new Map<string, Promise<PaneReadResult>>();
  private readonly interest = new Map<string, number>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly ttlMs: number;
  private readonly watchMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly reader: PaneReader,
    opts: PaneReadsOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? PANE_READ_TTL_MS;
    this.watchMs = opts.watchMs ?? PANE_WATCH_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The cached entry, if any — fresh or not. */
  peek(paneId: string, lines: number): PaneReadEntry | undefined {
    return this.cache.get(keyOf(paneId, lines));
  }

  /**
   * Read a pane, from the cache when the last read is fresh enough, else from the multiplexer —
   * with every concurrent caller for the same `(pane, lines)` sharing the one read in flight.
   *
   * A watched pane's freshness window is the watch cadence with slack, because the watcher is what
   * keeps it fresh: a client fetching on a poke must be answered from the read that caused the poke.
   */
  read(paneId: string, lines: number): Promise<PaneReadResult> {
    const key = keyOf(paneId, lines);
    const cached = this.cache.get(key);
    const window = this.interest.has(key) ? this.watchMs * 1.5 : this.ttlMs;
    if (cached && this.now() - cached.at < window) return Promise.resolve({ ok: true, entry: cached });
    return this.refresh(paneId, lines);
  }

  /** Drop what is held for one pane (or for all), so the next read goes to the multiplexer. */
  invalidate(paneId?: string): void {
    if (paneId === undefined) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) if (key.startsWith(`${paneId}\u0000`)) this.cache.delete(key);
  }

  /**
   * Somebody is looking at these panes at this window. Returns the ONE release for all of them.
   *
   * A SET rather than a pane, because the Overview screen watches every card at once: one stream
   * naming six panes is one subscription and one release, where six streams would be six
   * Access-validated connections through the tunnel for a screen that is, by design, a glance.
   * Single-pane callers pass `[paneId]` and get exactly the behaviour they had — the interest
   * counter is per `(pane, lines)` key either way, so two watchers of the same pane still share one
   * sweep and the second release is the one that stops it.
   */
  // NOT `Iterable<string>`: a bare string satisfies that and iterates as CHARACTERS, so a caller
  // that forgot the brackets would silently watch `w`, `1`, `:` … and be told nothing.
  watch(paneIds: readonly string[] | ReadonlySet<string>, lines: number): () => void {
    const keys = [...new Set(paneIds)].map((paneId) => keyOf(paneId, lines));
    for (const key of keys) this.interest.set(key, (this.interest.get(key) ?? 0) + 1);
    if (keys.length > 0) this.ensureLoop();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const n = (this.interest.get(key) ?? 1) - 1;
        if (n <= 0) this.interest.delete(key);
        else this.interest.set(key, n);
      }
      if (this.interest.size === 0) this.stopLoop();
    };
  }

  /** Whether anybody currently watches anything — the SSE census, for logs and tests. */
  watching(): number {
    return this.interest.size;
  }

  /** Fires when a watched pane's bytes change (never for the first read — there is nothing to differ from). */
  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Hold until the pane's ETag differs from `etag`, or `ms` elapses. Resolves the fresh entry on a
   * change and `null` on the deadline. The pane is watched for the duration, so the change is
   * noticed by the same loop that serves everyone else.
   */
  waitForChange(paneId: string, lines: number, etag: string, ms: number): Promise<PaneReadEntry | null> {
    const held = this.peek(paneId, lines);
    if (held && held.etag !== etag) return Promise.resolve(held);
    const release = this.watch([paneId], lines);
    let off: (() => void) | undefined;
    const changed = new Promise<PaneReadEntry>((resolve) => {
      off = this.onChange((id, entry) => {
        if (id === paneId && entry.lines === lines && entry.etag !== etag) resolve(entry);
      });
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([changed, expired]).finally(() => {
      clearTimeout(deadline);
      off?.();
      release();
    });
  }

  /** Stop the watch loop and forget every interest — for shutdown and tests. */
  stop(): void {
    this.interest.clear();
    this.stopLoop();
  }

  private refresh(paneId: string, lines: number): Promise<PaneReadResult> {
    const key = keyOf(paneId, lines);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.reader(paneId, lines)
      .then((r): PaneReadResult => {
        if (!r.ok) return r;
        const prev = this.cache.get(key);
        const entry: PaneReadEntry = {
          paneId,
          lines,
          body: r.body,
          data: r.data,
          etag: r.etag,
          at: this.now(),
        };
        this.cache.set(key, entry);
        if (prev && prev.etag !== entry.etag) this.announce(paneId, entry);
        return { ok: true, entry };
      })
      .catch((err): PaneReadResult => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  private announce(paneId: string, entry: PaneReadEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(paneId, entry);
      } catch (err) {
        console.warn(`[events] change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private ensureLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.watchMs);
    // The first sweep at once, not a cadence later: the client that just declared interest is about
    // to fetch, and the read it gets should be the one the watcher will compare against.
    void this.sweep();
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return; // a slow socket must not stack sweeps
    this.sweeping = true;
    try {
      const keys = [...this.interest.keys()];
      await Promise.all(
        keys.map((key) => {
          const sep = key.indexOf("\u0000");
          const paneId = key.slice(0, sep);
          const lines = Number(key.slice(sep + 1));
          return this.refresh(paneId, lines);
        }),
      );
    } finally {
      this.sweeping = false;
    }
  }
}

// ── The stream ────────────────────────────────────────────────────────────────

/**
 * One line on the wire. `snapshot` means re-run the snapshot loader; `pane` means re-read that pane.
 *
 * ── THE VERSION STAMP (`etag`) ────────────────────────────────────────────────────────────────
 * A poke says WHEN, never what — that is ADR 0008's poll-as-truth and it is not being relaxed here.
 * `etag` is still *when*: it names the version the poke is about, so a client that already holds
 * exactly those bytes can skip a fetch it knows would answer 304. It carries no content, a client
 * that ignores it is correct, and a client that trusts a stale one is one safety-net interval
 * behind at worst — the same cost a dropped poke has always had.
 *
 * OPTIONAL ON BOTH KINDS, and a reader must treat it that way: an older bridge sends none, and the
 * snapshot's stamp is the LOCAL body's fingerprint (`hubFor` in server.ts) — which is the tag the
 * route serves only where nothing rewrites the body on its way out. With `COLLIE_DEVICE_HEADER`
 * set, `?sessions=all`, or a crew merge, the served body differs and the stamps simply never match,
 * so the client fetches exactly as it did before. The PANE stamp has no such caveat: the watcher's
 * entry IS what the route answers from, byte for byte.
 */
export type PokeEvent =
  | { kind: "snapshot"; etag?: string }
  | { kind: "pane"; paneId: string; etag?: string }
  // FORK: the artifacts directory changed — a `collie artifact add` from a pane, a delete from the
  // phone. Carries no etag: the list is small and the phone simply refetches it (bridge/artifacts.ts).
  | { kind: "artifacts" };

export interface EventSubscriber {
  /** The panes this stream follows — only pokes for these are delivered. Empty is the herd-only
   *  stream (the dashboard), which still receives every snapshot poke. */
  readonly paneIds: ReadonlySet<string>;
  readonly send: (event: PokeEvent) => void;
}

/**
 * The fan-out for one session: every open stream, and the three sources that write to them.
 *
 * Sources are injected as subscribe functions rather than as the objects they hang off, so the hub
 * is testable with three plain callbacks and server.ts is the only place that knows a `poker` has
 * an `onPoke`. A pane change is forwarded only to the streams following THAT pane; a snapshot poke
 * goes to all of them.
 */
export class EventHub {
  private readonly subscribers = new Set<EventSubscriber>();

  /** Hand a subscriber every future poke; returns the unsubscribe. */
  subscribe(sub: EventSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** How many streams are open — for logs, tests and the doctor. */
  size(): number {
    return this.subscribers.size;
  }

  /** The herd moved (a status flip, a create, a close): every stream should re-run the snapshot.
   *  `etag` is the version that moved — see {@link PokeEvent}; absent when the caller has none. */
  pokeSnapshot(etag?: string): void {
    // Assigned, never conditionally spread: a poke with no stamp must put NO `etag` key on the
    // wire, so an older client's parser sees byte-for-byte the frame it always saw.
    const event: PokeEvent = { kind: "snapshot" };
    if (etag !== undefined) event.etag = etag;
    this.broadcast(event);
  }

  /** A pane's bytes moved: the streams following it should re-read it. A stream may follow SEVERAL
   *  panes (the Overview grid), so this is a set membership test rather than an equality. */
  /** FORK: every subscriber, because the library is global — a pane filter is the phone's. */
  pokeArtifacts(): void {
    this.broadcast({ kind: "artifacts" });
  }

  pokePane(paneId: string, etag?: string): void {
    const event: PokeEvent = { kind: "pane", paneId };
    if (etag !== undefined) event.etag = etag;
    for (const sub of this.subscribers) if (sub.paneIds.has(paneId)) this.deliver(sub, event);
  }

  private broadcast(event: PokeEvent): void {
    for (const sub of this.subscribers) this.deliver(sub, event);
  }

  private deliver(sub: EventSubscriber, event: PokeEvent): void {
    try {
      sub.send(event);
    } catch {
      // A stream that throws on write is one whose socket has gone; the route's own cancel handler
      // removes it, and a poke it did not receive is one the safety-net poll covers.
    }
  }
}

/** Encode one event as an SSE frame. Exported so the wire format is pinned by a test. */
export function sseFrame(event: PokeEvent): string {
  return `event: poke\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The comment frame that keeps a proxy's idle timer from closing a quiet stream. */
export const SSE_PING = ": ping\n\n";
/**
 * How often the ping goes out.
 *
 * THREE TIMERS WATCH THIS CONNECTION, NOT TWO, and the ping has to beat the shortest of them.
 * Cloudflare closes an idle proxied connection at 100 s and a browser reconnects an idle
 * EventSource on its own — both were reasoned about when this shipped at 15 s. **Bun was not.**
 * `Bun.serve`'s `idleTimeout` defaults to 10 seconds, so a 15 s ping always arrived after the
 * runtime had already dropped the socket: measured on loopback on 2026-09-11, a stream over a QUIET
 * herd died at 9.1 s and 9.8 s and came back on the client's `retry: 3000` — a 12-second cycle,
 * 386 `unexpected EOF` lines in the tunnel log, and the feed down ~25 % of wall-clock time. It
 * failed PRECISELY in the quiet case `LIVE_FEED_MS`'s 30 s relaxation exists to exploit.
 *
 * Five seconds is the fix on this side, and {@link IDLE_TIMEOUT_S} is the fix on the other: the ping
 * is made to survive a runtime default that changes, and the runtime default is made explicit rather
 * than inherited. Either alone would work today; both together mean neither a Bun upgrade nor an
 * edit to this line can re-create the defect silently. Four bytes every five seconds per open
 * stream is the whole cost.
 */
export const SSE_PING_MS = 5_000;
/**
 * The explicit `idleTimeout` for `Bun.serve` (SECONDS — that is the unit Bun takes, capped at 255).
 *
 * It lives here, beside the ping, because the two are one rule that must never drift: the ping has
 * to fire well inside this, and a constant written down in another file is one that gets edited
 * alone. `bridge/server.ts` imports it for the one `Bun.serve` call.
 *
 * 150 s clears everything the bridge legitimately holds a connection open for WITHOUT writing a
 * byte, in descending order:
 *   - a codex STT transcription, `CODEX_TIMEOUT_MS` 120 s (bridge/stt/codex.ts) — the longest, and
 *     the only one anywhere near the old 10 s default;
 *   - Cloudflare's own 100 s idle cut, so the runtime is never the layer that closes first;
 *   - an openai STT transcription, 60 s;
 *   - the long-poll pane read, `PANE_WAIT_MAX_MS` 2 s;
 *   - this file's ping, 5 s.
 * An upload is not on that list: bytes are moving for its whole life, which is what resets the timer.
 *
 * One operational consequence, and it is the reason the number is not larger: a session-scoped route
 * that WEDGES (a bridge test run holding the herdr socket — FORK.md) now hangs for 150 s instead of
 * 10 before the runtime gives up on it.
 */
export const IDLE_TIMEOUT_S = 150;
