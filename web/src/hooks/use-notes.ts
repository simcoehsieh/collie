import { useMemo, useSyncExternalStore } from "react";

import { anchorKey, noteForTurn, notesFor, subscribeNotes, type Note, type NoteAnchor } from "@/lib/notes";
import { paneScopeKey, type Scope } from "@/lib/scope";

// FORK: the React bindings for lib/notes.ts. The store itself is react-free so it can be tested
// without a renderer (and so the prompt builder can be read without one); everything that needs a
// re-render goes through `useSyncExternalStore` here, the same split lib/send-queue.ts uses.

const EMPTY: Note[] = [];

/** One pane's notes, in order, re-rendering the caller whenever they change. */
export function useNotes(scope: Scope | undefined, paneId: string): Note[] {
  const key = paneScopeKey(scope, paneId);
  return useSyncExternalStore(
    subscribeNotes,
    () => notesFor(key),
    () => EMPTY,
  );
}

/**
 * The notes of this pane that have NOT gone out yet — what "Send N notes" would send, and what the
 * composer draws chips for. Derived here rather than in the store so the store keeps one list per
 * pane and callers cannot disagree about what "pending" means.
 */
export function usePendingNotes(scope: Scope | undefined, paneId: string): Note[] {
  const all = useNotes(scope, paneId);
  return useMemo(() => all.filter((n) => n.sentAt === undefined), [all]);
}

/** The note already on this anchor, or null — what an entry gesture opens the sheet in edit mode on. */
export function useNoteAt(scope: Scope | undefined, paneId: string, anchor: NoteAnchor | null): Note | null {
  const all = useNotes(scope, paneId);
  // Keyed on the anchor's IDENTITY string, not the object: callers build the anchor inline at the
  // gesture, so a fresh object arrives on every render and an object dep would recompute forever.
  const wanted = anchor === null ? null : anchorKey(anchor);
  return useMemo(
    () => (wanted === null ? null : (all.find((n) => anchorKey(n.anchor) === wanted) ?? null)),
    [all, wanted],
  );
}

/**
 * The note anchored to one transcript turn, found by the turn's own uuid.
 *
 * Addressed by turn rather than by pane because `components/transcript-view.tsx` is upstream's file
 * and the hunk in it is the thing being kept small: a turn uuid is unique across every session on
 * every machine, so the badge needs no pane address threaded through a component that has no other
 * use for one (see `noteForTurn`).
 */
export function useTurnNote(turnId: string): Note | null {
  return useSyncExternalStore(
    subscribeNotes,
    () => noteForTurn(turnId),
    () => null,
  );
}
