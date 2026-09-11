// FORK — THE STATUS-LINE CACHE, so a snapshot can carry a line without doing I/O to build itself.
//
// `localSnapshot` (bridge/server.ts) is SYNCHRONOUS and runs per `/api/snapshot` — every 1.5 s per
// connected device, over every pane. A read-through cache is what lets it ask a question whose answer
// lives on disk: `get` never touches the filesystem, it answers from the map and schedules a refresh
// when the entry has gone stale. A line therefore reaches the phone within a poll or two of being
// written, which is the right latency for a sentence a human reads.
//
// The GRAMMAR lives in `bridge/beacon/status-line.ts`, which is pure by the rule that governs
// everything under `bridge/beacon/`. This module is the stateful half, and it sits outside that
// directory for exactly the reason `beacon-io.ts` does.
//
// A beacon is a hint, never a control channel (.adr/0024): nothing in here can cause a send, a key, a
// rename or a close, and the value it produces reaches one renderer as text.

import {
  readStatusLine,
  statusLineKey,
  type StatusLineDeps,
  type StatusLineDirectory,
  type StatusLineReading,
} from "./beacon/status-line.ts";
import type { AgentSessionRef } from "./journal/types.ts";

/**
 * How long a cached answer is reused.
 *
 * Two polls. Short enough that `collie beacon status "…"` shows up while the agent is still on the
 * same thought, long enough that N panes × one device × 1.5 s is a handful of small reads a second
 * rather than one per pane per poll.
 */
export const STATUS_REFRESH_MS = 3000;

/** How many sessions' lines are held. Far above any herd; the oldest entry is the coldest pane. */
const CACHE_MAX = 64;

interface CacheEntry {
  reading: StatusLineReading | null;
  readAt: number;
}

export interface StatusLineStoreDeps {
  readonly directory: StatusLineDirectory;
  /** Injected so a test can pin the clock; production omits it. */
  readonly now?: () => number;
  readonly refreshMs?: number;
}

export class StatusLineStore {
  private readonly cache = new Map<string, CacheEntry>();

  /** Keys with a refresh in flight — so N panes in one snapshot cannot start N reads of one file. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: StatusLineStoreDeps) {}

  /**
   * The line for a session, from cache, scheduling a refresh when the entry is stale or absent.
   *
   * SYNCHRONOUS BY DESIGN and therefore one poll behind on its very first answer: a pane whose line
   * has never been read answers `null` now and carries it on the next snapshot. That is the correct
   * trade for a sentence — it is not a status, nothing gates on it, and making the snapshot await a
   * filesystem read per pane to save 1.5 s would be the expensive half of this feature.
   */
  get(session: AgentSessionRef): StatusLineReading | null {
    const key = statusLineKey(session);
    const now = (this.deps.now ?? Date.now)();
    const entry = this.cache.get(key);
    const fresh = entry !== undefined && now - entry.readAt < (this.deps.refreshMs ?? STATUS_REFRESH_MS);
    if (!fresh) void this.refresh(key, session, now);
    return entry?.reading ?? null;
  }

  /** Read one file and remember the answer. Never throws — a failure leaves the previous answer. */
  private async refresh(key: string, session: AgentSessionRef, startedAt: number): Promise<void> {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    // Two branches rather than a conditional spread: an ABSENT `now` means "use the reader's own
    // default clock", which is a different instruction from passing an explicit `undefined`.
    const readDeps: StatusLineDeps =
      this.deps.now === undefined
        ? { directory: this.deps.directory }
        : { directory: this.deps.directory, now: this.deps.now };
    try {
      const reading = await readStatusLine(session, readDeps);
      this.store(key, { reading, readAt: startedAt });
    } catch {
      // An unreadable directory is "no line", which is what an absent entry already means. Stamped
      // anyway, so a broken state dir does not turn into a read attempt per pane per poll.
      this.store(key, { reading: this.cache.get(key)?.reading ?? null, readAt: startedAt });
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Insertion-ordered eviction, touching a hit — the same shape `TranscriptStore`'s cache uses. */
  private store(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
