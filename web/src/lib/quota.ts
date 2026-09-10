import { useCallback, useEffect, useSyncExternalStore } from "react";

import { fetchQuota } from "@/lib/api";
import type { QuotaResponse } from "@/lib/types";

// FORK: the data half of the dashboard's usage section — what the three agents have left.
//
// The same show-first-fetch-second shape lib/overview.ts has, for the same reason: the bridge's
// command takes two seconds, and a section that waited for it on every visit to the dashboard would
// make the dashboard slower than it was. A module cache paints on the way in; one read lands a beat
// later; a steady beat keeps it fresh while the page is looked at and stops while it is not. The
// bridge serves a body up to a minute old and answers 304 to its tag, so the beat here is cheap —
// most ticks are an empty 304 — and the CLI itself runs at most once a minute regardless of how
// many phones ask.

/** How often the section re-reads while visible. The bridge's own TTL is 60 s; five minutes here. */
export const QUOTA_REFRESH_MS = 5 * 60_000;

// ── The store ─────────────────────────────────────────────────────────────
let last: QuotaResponse | null = null;
let error: string | null = null;
let refreshing = false;
let inflight: Promise<void> | null = null;
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

/** The last body read, if any — what paints before the first read lands. */
export function quotaData(): QuotaResponse | null {
  return last;
}
/** The last read's failure, in the bridge's words, or null after a success. */
export function quotaError(): string | null {
  return error;
}
/** Whether a read is in flight — the refresh glyph spins on it. */
export function quotaRefreshing(): boolean {
  return refreshing;
}

/** One read. Never throws; a failed read leaves the last body in place and records the reason. */
export function readQuota(refresh = false, signal?: AbortSignal): Promise<void> {
  // A forced refresh must not be swallowed by a passive read already in flight — but two of
  // anything at once is still one request, so a second caller waits for the first.
  if (inflight !== null && !refresh) return inflight;
  refreshing = true;
  bump();
  const op = (async () => {
    try {
      const body = await fetchQuota(refresh, signal);
      if (body !== last) {
        last = body;
        error = null;
      } else if (error !== null) {
        error = null;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "unavailable";
    } finally {
      refreshing = false;
      inflight = null;
      bump();
    }
  })();
  inflight = op;
  return op;
}

/** Test seam. */
export function __resetQuota(): void {
  last = null;
  error = null;
  refreshing = false;
  inflight = null;
  version = 0;
}

/** What the section reads: the body (or none yet), the last failure, and the refresh control. */
export interface QuotaView {
  data: QuotaResponse | null;
  error: string | null;
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Keep the section fresh while mounted: one read on the way in (the cache paints first), then a
 * {@link QUOTA_REFRESH_MS} beat while the tab is visible. Subscribes to the store so the caller
 * re-renders when a read lands.
 */
export function useQuota(): QuotaView {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    const controller = new AbortController();
    void readQuota(false, controller.signal);
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void readQuota(false, controller.signal), QUOTA_REFRESH_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        void readQuota(false, controller.signal);
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const refresh = useCallback(() => void readQuota(true), []);
  return { data: last, error, refreshing, refresh };
}

// ── Pure helpers, exported for the tests and the card ──────────────────────

/** How full a bar is, as the tone the card paints it in. */
export type UsageTone = "ok" | "warn" | "high";

export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 80) return "high";
  if (usedPercent >= 50) return "warn";
  return "ok";
}

/** Seconds until `resetAt`, floored at zero; null when the provider named no time. */
export function secondsUntil(resetAt: string | null, now: number): number | null {
  if (resetAt === null) return null;
  const at = Date.parse(resetAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - now) / 1000));
}

/** The three parts of a countdown — the card picks the two that matter and the locale spells them. */
export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
}

export function countdownParts(seconds: number): Countdown {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return { days, hours, minutes };
}
