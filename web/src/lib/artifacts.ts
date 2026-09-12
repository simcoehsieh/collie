import { useEffect, useSyncExternalStore } from "react";

import { fetchArtifacts } from "./api";
import { scopeKey, type Scope } from "./scope";
import { isLocked, useLocked } from "./idle";
import type { ArtifactView, TranscriptEntry } from "./types";

// FORK — the artifacts library, as the phone holds it (bridge/artifacts.ts has the store itself).
//
// ONE MODULE STORE, KEYED BY SCOPE. The library is one list per bridge and three screens show
// slices of it — the thread (this pane's, under the turns that made them), the pane's sheet, the
// /artifacts route — so it is fetched once per scope and every reader takes its slice from the
// same snapshot. That is also what makes a poke cheap: `deliverArtifactPoke` refetches each loaded
// scope once, and every card on screen updates from that one read (lib/overview.ts's argument for
// the tails, applied to a list instead of a pane).
//
// POLL-AS-TRUTH, STILL: the poke is a hint to read now. Active readers check freshness every 30 seconds and on
// foreground/reconnect. Hidden, idle-locked and unmounted libraries make no background reads. Nothing here
// trusts a poke's body, because a poke has none.

export type ArtifactsPhase = "idle" | "loading" | "ready" | "failed";

export interface ArtifactsSnapshot {
  readonly phase: ArtifactsPhase;
  readonly artifacts: readonly ArtifactView[];
  /** When `ready` was last reached, for a reader that wants to know how stale it is looking. */
  readonly readAt: number;
}

const EMPTY: ArtifactsSnapshot = { phase: "idle", artifacts: [], readAt: 0 };

const snapshots = new Map<string, ArtifactsSnapshot>();
const scopes = new Map<string, Scope | undefined>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const readers = new Map<string, number>();
const dirty = new Set<string>();
export const ARTIFACT_REFRESH_MS = 30_000;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function canRefresh(): boolean {
  return document.visibilityState !== "hidden" && navigator.onLine !== false && !isLocked();
}

function refreshActive(): void {
  if (!canRefresh()) return;
  for (const key of readers.keys()) {
    const snap = snapshots.get(key) ?? EMPTY;
    if (dirty.has(key) || snap.phase !== "ready" || Date.now() - snap.readAt >= ARTIFACT_REFRESH_MS) {
      void loadArtifacts(scopes.get(key));
    }
  }
}

function retain(scope?: Scope): () => void {
  const key = keyOf(scope);
  scopes.set(key, scope);
  readers.set(key, (readers.get(key) ?? 0) + 1);
  if (refreshTimer === undefined) {
    refreshTimer = setInterval(refreshActive, ARTIFACT_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshActive);
    window.addEventListener("online", refreshActive);
  }
  refreshActive();
  return () => {
    const count = (readers.get(key) ?? 1) - 1;
    if (count > 0) readers.set(key, count);
    else readers.delete(key);
    if (readers.size === 0) stopRefreshing();
  };
}

function stopRefreshing(): void {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
  document.removeEventListener("visibilitychange", refreshActive);
  window.removeEventListener("online", refreshActive);
}

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function keyOf(scope?: Scope): string {
  return scopeKey(scope);
}

export function artifactsSnapshot(scope?: Scope): ArtifactsSnapshot {
  return snapshots.get(keyOf(scope)) ?? EMPTY;
}

function store(key: string, next: ArtifactsSnapshot): void {
  snapshots.set(key, next);
  emit();
}

/** Read the library for a scope now. One read per scope at a time; a second caller shares it. */
export function loadArtifacts(scope?: Scope): Promise<void> {
  const key = keyOf(scope);
  const running = inFlight.get(key);
  if (running) return running;
  scopes.set(key, scope);
  dirty.delete(key);
  const before = snapshots.get(key) ?? EMPTY;
  store(key, { ...before, phase: "loading" });
  const run = (async () => {
    try {
      const res = await fetchArtifacts({}, scope);
      store(key, { phase: "ready", artifacts: res.artifacts, readAt: Date.now() });
    } catch {
      const current = snapshots.get(key) ?? EMPTY;
      // A failed refresh keeps what it had: a stale list beats an empty one, and `phase` says which.
      store(key, { phase: "failed", artifacts: current.artifacts, readAt: current.readAt });
    } finally {
      inFlight.delete(key);
      // An invalidation during the read may describe bytes newer than its response. Coalesce all
      // such pokes into one follow-up; an unmounted/hidden reader catches up on return instead.
      if (dirty.has(key) && readers.has(key) && canRefresh()) void loadArtifacts(scope);
    }
  })();
  inFlight.set(key, run);
  return run;
}

/** Invalidate every known scope, but only spend network on libraries currently on screen. */
export function deliverArtifactPoke(): boolean {
  if (scopes.size === 0) return false;
  for (const key of scopes.keys()) dirty.add(key);
  refreshActive();
  return true;
}

export interface UseArtifacts {
  readonly artifacts: readonly ArtifactView[];
  readonly phase: ArtifactsPhase;
  readonly reload: () => void;
}

/** The library for a scope, read on first mount and kept current by pokes. */
export function useArtifacts(scope?: Scope): UseArtifacts {
  const locked = useLocked();
  const snap = useSyncExternalStore(subscribe, () => artifactsSnapshot(scope), () => EMPTY);
  useEffect(() => retain(scope), [scope]);
  useEffect(() => {
    if (!locked) refreshActive();
  }, [locked]);
  return { artifacts: snap.artifacts, phase: snap.phase, reload: () => void loadArtifacts(scope) };
}

/** One pane's artifacts, newest first — the ones stamped with that pane. */
export function artifactsForPane(artifacts: readonly ArtifactView[], paneId: string): ArtifactView[] {
  return artifacts.filter((a) => a.pane?.paneId === paneId);
}

/** The newest version of each slug, in the order the list already has (newest first). */
export function latestVersions(artifacts: readonly ArtifactView[]): ArtifactView[] {
  const seen = new Set<string>();
  const out: ArtifactView[] = [];
  for (const a of artifacts) {
    if (seen.has(a.slug)) continue;
    seen.add(a.slug);
    out.push(a);
  }
  return out;
}

/** Every version of one artifact, newest first. */
export function versionsOf(artifacts: readonly ArtifactView[], slug: string): ArtifactView[] {
  return artifacts.filter((a) => a.slug === slug).toSorted((a, b) => b.version - a.version);
}

/**
 * Which turn each artifact belongs under: the LAST turn that had started when the artifact was
 * registered. An agent registers mid-turn — its own turn's timestamp is earlier, the operator's next
 * message later — so "the latest turn not after the registration" is the turn that made it.
 *
 * An artifact registered before the first turn on screen has no turn here (the thread is a window;
 * the pane's sheet lists everything). One newer than every turn goes under the last: the turn is
 * still being written, and that is where it will read as "just made".
 */
export function attachArtifactsToTurns(
  entries: readonly TranscriptEntry[],
  artifacts: readonly ArtifactView[],
): Map<string, ArtifactView[]> {
  const out = new Map<string, ArtifactView[]>();
  if (entries.length === 0 || artifacts.length === 0) return out;
  const starts: { uuid: string; ms: number }[] = [];
  for (const e of entries) {
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms)) starts.push({ uuid: e.uuid, ms });
  }
  if (starts.length === 0) return out;
  const ordered = artifacts.toSorted((a, b) => a.createdMs - b.createdMs);
  let turnIndex = 0;
  let owner: string | null = null;
  for (const artifact of ordered) {
    // Both sequences are oldest-first: each turn is visited at most once, even in a long history.
    while (turnIndex < starts.length) {
      const start = starts[turnIndex];
      if (!start || start.ms > artifact.createdMs) break;
      owner = start.uuid;
      turnIndex++;
    }
    if (owner === null) continue;
    const list = out.get(owner);
    if (list) list.push(artifact);
    else out.set(owner, [artifact]);
  }
  return out;
}

/** Human size, the way the CLI prints it: `9 B`, `1.2 KB`, `2.10 MB`. */
export function artifactSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Test seam. */
export function __resetArtifacts(): void {
  stopRefreshing();
  readers.clear();
  dirty.clear();
  snapshots.clear();
  scopes.clear();
  inFlight.clear();
  emit();
}
