// FORK — THE SESSION-FACTS CACHE: which model and effort each pane's agent is running on, so a
// snapshot can carry the pair without doing I/O to build itself.
//
// The shape is `bridge/status-lines.ts`'s, for the same reason: `localSnapshot` (bridge/server.ts) is
// SYNCHRONOUS and runs per `/api/snapshot`, so a question whose answer lives on disk has to be asked
// of a read-through cache. `get` answers from the map and schedules a refresh when the entry is stale.
//
// What differs is WHERE the answer lives — not a file Collie owns, but the tail of the agent's own
// session log, the one the journal adapters already know how to find. So a refresh is: resolve the
// log through the adapter's source, stat it, and only when it has grown since the last read, read its
// last `FACTS_TAIL_BYTES` and hand them to the adapter's pure `facts` reader. A working agent appends
// to its log constantly, which is why the stat-gate matters: without it every refresh would re-read
// the tail whether anything happened or not; with it an idle pane costs one stat per refresh.
//
// HOLD-LAST-GOOD, twice over. A tail that says nothing (a burst of tool output with no assistant row
// in the last 256 KB) keeps the previous answer rather than blanking it, because the model did not go
// anywhere; and a read that fails (the log vanished, was rotated) keeps it too. The facts are
// PRESENTATION: text on a card and on the composer's strip, nothing branches on them, and a stale
// model name for one poll is the right trade against a chip that flickers.

import type { AgentSessionRef, JournalAdapter, SessionFacts } from "./journal/types.ts";
import { tail as readTail } from "./journal/files.ts";

/**
 * How long a cached answer is reused. Longer than a status line's three seconds: a model changes
 * when the operator runs `/model`, which is minutes apart at the fastest, and each refresh is a
 * stat (plus a tail read only when the log grew).
 */
export const FACTS_REFRESH_MS = 10_000;

/**
 * How much of the log's end is read. A Claude assistant row is a few KB; a tool RESULT row can be
 * far larger (a whole file read lands in one row), so the window is sized to hold several turns
 * behind one big result rather than one turn exactly. When even that holds no assistant row the
 * store keeps its last answer, so the size is a latency, not a correctness bound.
 */
export const FACTS_TAIL_BYTES = 256 * 1024;

/** How many sessions' facts are held. Far above any herd; the oldest entry is the coldest pane. */
const CACHE_MAX = 64;

interface CacheEntry {
  facts: SessionFacts | null;
  /** When the refresh that produced (or reaffirmed) this entry started — the staleness clock. */
  readAt: number;
  /** The log as it was when `facts` was read — the gate that skips a re-read of an unchanged file. */
  seen: { size: number; mtimeMs: number } | null;
}

export interface SessionFactsStoreDeps {
  /** Injected so a test can pin the clock; production omits it. */
  readonly now?: () => number;
  readonly refreshMs?: number;
  /** Injected so a test needs no temp files; production reads the real log's tail. */
  readonly tail?: (path: string, bytes: number) => Promise<string>;
}

/**
 * One key per (harness, session): the same ref can name different logs under different adapters.
 * Neither the agent name nor the kind carries a slash, so the join cannot collide.
 */
export function sessionFactsKey(agent: string, ref: AgentSessionRef): string {
  return `${agent}/${ref.kind}/${ref.value}`;
}

export class SessionFactsStore {
  private readonly cache = new Map<string, CacheEntry>();

  /** Keys with a refresh in flight — so N panes in one snapshot cannot start N reads of one log. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: SessionFactsStoreDeps = {}) {}

  /**
   * The facts for a session, from cache, scheduling a refresh when the entry is stale or absent.
   *
   * SYNCHRONOUS BY DESIGN and therefore one poll behind on its very first answer, exactly as the
   * status-line store is: a pane whose log has never been read answers `null` now and carries the
   * pair on the next snapshot. Nothing gates on a model name.
   */
  get(adapter: JournalAdapter, ref: AgentSessionRef): SessionFacts | null {
    if (adapter.facts === undefined) return null;
    const key = sessionFactsKey(adapter.agent, ref);
    const now = (this.deps.now ?? Date.now)();
    const entry = this.cache.get(key);
    const fresh = entry !== undefined && now - entry.readAt < (this.deps.refreshMs ?? FACTS_REFRESH_MS);
    if (!fresh) void this.refresh(key, adapter, ref, now);
    return entry?.facts ?? null;
  }

  /** Resolve, stat, and read the tail only when the log changed. Never throws. */
  private async refresh(
    key: string,
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    startedAt: number,
  ): Promise<void> {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const previous = this.cache.get(key);
    const held = previous?.facts ?? null;
    try {
      const path = await adapter.source.resolve(ref);
      const meta = path === null ? null : await adapter.source.stat(path);
      if (path === null || meta === null) {
        // No log to read (yet, or any more): reaffirm what was known so the next poll does not retry
        // the resolve on every snapshot, and answer null where nothing was ever known.
        this.store(key, { facts: held, readAt: startedAt, seen: null });
        return;
      }
      const seen = previous?.seen ?? null;
      if (seen !== null && seen.size === meta.size && seen.mtimeMs === meta.mtimeMs) {
        this.store(key, { facts: held, readAt: startedAt, seen });
        return;
      }
      const text = await (this.deps.tail ?? readTail)(path, FACTS_TAIL_BYTES);
      // `facts` was checked in `get`; an adapter cannot lose the method between the two calls.
      const read = adapter.facts === undefined ? null : adapter.facts(text);
      this.store(key, { facts: read ?? held, readAt: startedAt, seen: meta });
    } catch {
      // Unreadable this time: hold the last answer and try again after the refresh window.
      this.store(key, { facts: held, readAt: startedAt, seen: previous?.seen ?? null });
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Insertion-ordered eviction, touching a hit — the same shape the status-line store uses. */
  private store(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
