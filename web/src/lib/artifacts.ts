import { useEffect, useSyncExternalStore } from "react";

import { fetchArtifacts } from "./api";
import { scopeKey, type Scope } from "./scope";
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
// POLL-AS-TRUTH, STILL: the poke is a hint to read now. A reader that mounts after a poke reads on
// mount; a poke that never arrives costs a refresh on the next mount or `reload()`. Nothing here
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
  const before = snapshots.get(key) ?? EMPTY;
  if (before.phase !== "ready") store(key, { ...before, phase: "loading" });
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
    }
  })();
  inFlight.set(key, run);
  return run;
}

/**
 * The bridge said the library changed. Every scope that has been read is read again; returns
 * whether anyone was listening (the poller consumes the poke either way — see use-polling.ts).
 */
export function deliverArtifactPoke(): boolean {
  if (snapshots.size === 0) return false;
  for (const [key, scope] of scopes) {
    if (snapshots.has(key)) void loadArtifacts(scope);
  }
  return true;
}

export interface UseArtifacts {
  readonly artifacts: readonly ArtifactView[];
  readonly phase: ArtifactsPhase;
  readonly reload: () => void;
}

/** The library for a scope, read on first mount and kept current by pokes. */
export function useArtifacts(scope?: Scope): UseArtifacts {
  const key = keyOf(scope);
  const snap = useSyncExternalStore(subscribe, () => artifactsSnapshot(scope), () => EMPTY);
  useEffect(() => {
    if ((snapshots.get(key) ?? EMPTY).phase === "idle") void loadArtifacts(scope);
    // `scope` is interned (lib/scope.ts), so it is the key's own identity here.
  }, [key, scope]);
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
  for (const artifact of ordered) {
    let owner: string | null = null;
    for (const s of starts) {
      if (s.ms <= artifact.createdMs) owner = s.uuid;
      else break;
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
  snapshots.clear();
  scopes.clear();
  inFlight.clear();
  emit();
}
