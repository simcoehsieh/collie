import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchHistory } from "@/lib/api";
import { paneScopeKey, type Scope } from "@/lib/scope";
import type { TranscriptEntry } from "@/lib/types";

// FORK — THE PANE'S OWN THREAD, kept live without ever joining the poll.
//
// `use-latest-reply.ts` already solved the hard half of this and solved it for ONE turn: an agent's
// TUI runs on the alternate screen, so the mirror is the viewport and the journal is the only place
// the conversation exists — but re-reading the journal is a bridge-side parse of a file that can be
// 32 MB, so it must not ride the 1.5 s poll. Its answer was to watch the MIRROR instead and fetch
// when the screen SETTLES, which a streaming reply never does. In practice that is one fetch per
// finished message, which is the same cost as opening the history route once.
//
// This generalises exactly that trigger to a WINDOW of turns, and changes nothing about the cadence:
// same settle timer, same immediate first read, same swallow-and-keep-what-we-have on failure. What
// it adds is paging — "load older" walks back with `?before=` the way the history route does — and
// the bookkeeping that lets a refresh of the newest page coexist with pages already walked.
//
// WHY A SEPARATE HOOK RATHER THAN A PARAMETER ON `useLatestReply`. That hook also owns the read-aloud
// lifecycle (TTS starts and stops on ITS reply's identity), and a window of turns has no single
// identity to hang that on. Two hooks, one trigger, and the trigger is the part that is copied
// deliberately rather than shared through a third module — it is fifteen lines, and a shared
// "settle" abstraction would make the one thing a future reader must understand (why this is not on
// the poll) live somewhere neither call site mentions.

/** Turns in the first page. A few screens of thread — enough that the scroller opens on content. */
export const PANE_TURNS = 60;

/** Turns added per "load older" tap. */
export const PANE_OLDER_PAGE = 120;

/** How long the mirror must hold still before its content counts as a finished message. */
const SETTLE_MS = 1500;

export interface PaneTranscriptState {
  /** Oldest-first, ready to render top-down. Empty until the first read lands. */
  entries: TranscriptEntry[];
  /** Older turns exist before `entries[0]`. */
  hasMore: boolean;
  /** A "load older" read is in flight. */
  loading: boolean;
  /** Walk one page further back. A no-op while loading, or with nothing older to fetch. */
  loadOlder: () => void;
  /**
   * Has ANY answer arrived for this pane yet — including "there is no transcript"?
   *
   * The empty state has to tell "nothing yet" from "nothing ever", or a pane opens on the words
   * "no conversation" for the second and a half before its first page lands.
   */
  ready: boolean;
  /** The bridge answered `available: false` — no session, no log, or the feature is off. */
  unavailable: boolean;
}

const EMPTY: TranscriptEntry[] = [];

/**
 * The pane's conversation, newest-anchored, refreshed when the mirror settles.
 *
 * Errors are swallowed exactly as `useLatestReply` swallows them: the mirror is one tap away and is
 * still right there, so a failed read must cost nothing more than the thread not moving.
 */
export function usePaneTranscript({
  paneId,
  scope,
  enabled,
  mirrorText,
}: {
  paneId: string;
  /** Which machine + session this pane lives on — the same address every other pane read carries. */
  scope?: Scope;
  /** False for a pane with no journal, or while the operator is looking at the terminal instead. */
  enabled: boolean;
  /** The mirror as displayed — its STILLNESS is the trigger; its content is not read here. */
  mirrorText: string;
}): PaneTranscriptState {
  // The newest page, and everything walked back beyond it. Kept apart because only the first is
  // re-read: a refresh replaces `base` and leaves the pages the reader already scrolled to alone.
  const [base, setBase] = useState<{ entries: TranscriptEntry[]; hasMore: boolean } | null>(null);
  const [older, setOlder] = useState<TranscriptEntry[]>([]);
  const [olderHasMore, setOlderHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [settled, setSettled] = useState(mirrorText);

  // A thread belongs to the pane it was read from. Keyed on the ADDRESS, not the pane id: the same
  // pane id on another host or session is a different pane (the rule `useLatestReply` states).
  const address = paneScopeKey(scope, paneId);
  useEffect(() => {
    setBase(null);
    setOlder([]);
    setOlderHasMore(true);
    setReady(false);
    setUnavailable(false);
  }, [address]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => setSettled(mirrorText), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [mirrorText, enabled]);

  // The newest page. The FIRST read is immediate rather than settle-delayed — opening a pane should
  // show its thread, not make you wait out a timer for output that may never change again.
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let live = true;
    void (async () => {
      try {
        const page = await fetchHistory(paneId, { limit: PANE_TURNS }, scope, abort.signal);
        if (!live) return;
        if (page.available) {
          setBase({ entries: page.entries, hasMore: page.hasMore });
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
        setReady(true);
      } catch {
        // A cancelled or failed read leaves whatever we already hold on screen.
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
    // `scope` is safe in a dependency array: scopes read off a URL are interned to one frozen
    // instance per (host, session), so its identity is as stable as the string it replaced.
  }, [paneId, scope, enabled, settled]);

  // One transcript out of the two halves. A refresh of `base` can re-deliver turns a "load older"
  // page already holds (the window moved), so the older half is filtered against the newer one —
  // `base` is the fresher read of the same rows and therefore the one that wins.
  const entries = useMemo(() => {
    if (base === null) return older.length > 0 ? older : EMPTY;
    if (older.length === 0) return base.entries;
    const held = new Set(base.entries.map((e) => e.uuid));
    return [...older.filter((e) => !held.has(e.uuid)), ...base.entries];
  }, [base, older]);

  const hasMore = older.length > 0 ? olderHasMore : (base?.hasMore ?? false);

  const loadOlder = useCallback(() => {
    const oldest = entries[0]?.uuid;
    if (loading || !hasMore || oldest === undefined) return;
    setLoading(true);
    void (async () => {
      try {
        const page = await fetchHistory(paneId, { limit: PANE_OLDER_PAGE, before: oldest }, scope);
        if (!page.available) {
          setOlderHasMore(false);
          return;
        }
        setOlder((prev) => [...page.entries, ...prev]);
        setOlderHasMore(page.hasMore);
      } catch {
        // Leave `hasMore` alone: the tap can be tried again.
      } finally {
        setLoading(false);
      }
    })();
  }, [entries, hasMore, loading, paneId, scope]);

  // `loadOlder` closes over `entries`, which changes on every refresh; the ref keeps the identity of
  // the callback handed to a scroll listener stable without re-subscribing it per poll.
  const latest = useRef(loadOlder);
  latest.current = loadOlder;
  const stableLoadOlder = useCallback(() => latest.current(), []);

  return { entries, hasMore, loading, loadOlder: stableLoadOlder, ready, unavailable };
}
