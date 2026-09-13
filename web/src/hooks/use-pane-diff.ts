import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import type { Scope } from "@/lib/scope";
import type { AgentStatus, DiffFileView } from "@/lib/types";

// FORK. The pane's work-tree summary, for the two surfaces outside the Changes sheet that want it:
// the header's "3 files · +82 −11" chip, and the mirror's file chips.
//
// ── IT IS OFF THE POLL PATH, DELIBERATELY ───────────────────────────────────────────────────────
// The mirror revalidates at 1 Hz; `git status` over a large tree does not belong on that cadence,
// and neither does a 175 ms round trip through Cloudflare. So this reads ONCE per pane and then
// only when the agent's STATUS changes — which is exactly when a tree stops moving (a run finishes,
// a prompt appears) and therefore the only moment a new answer exists. `use-latest-reply.ts` makes
// the same trade for the same reason: a settle-triggered read, never a polled one.
//
// The route is ETag-validated and `lib/api.ts` keeps the body it names, so a re-read of an unchanged
// tree is a 304 and no download — which is what makes the status trigger cheap enough to be
// unconditional rather than gated on anything cleverer.
//
// ── EVERY FAILURE IS SILENCE ────────────────────────────────────────────────────────────────────
// A pane that is not a work tree answers 404, a pane outside the allowed roots answers 403, and a
// bridge older than the route answers 404 as well. All three mean the same thing to a caller here —
// there is no summary — and none of them is worth a word on screen: the chip simply is not drawn,
// and the diff sheet is still one tap away in the pane menu to say why. The sheet owns the
// explaining; this hook owns the chip.

/** What the header chip draws and the mirror's chips look paths up in. */
export interface PaneDiffSummary {
  files: readonly DiffFileView[];
  fileCount: number;
  additions: number;
  deletions: number;
}

/** The frozen empty file list, so "this pane has no changes" is one identity across polls. */
const NO_FILES: readonly DiffFileView[] = Object.freeze<DiffFileView[]>([]);

/** The empty summary, as one frozen identity so "nothing to show" never re-renders a memo'd child. */
const NONE: PaneDiffSummary = Object.freeze({
  files: NO_FILES,
  fileCount: 0,
  additions: 0,
  deletions: 0,
});

/** What this hook hands back: the summary, plus the one moment a status change cannot catch. */
export interface PaneDiffHandle {
  summary: PaneDiffSummary;
  refresh: () => void;
}

/** The file list, totalled. Binary files count as files and contribute no lines, which is honest. */
function summarise(files: readonly DiffFileView[]): PaneDiffSummary {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files, fileCount: files.length, additions, deletions };
}

/**
 * The pane's changed-file summary, refreshed when the pane changes and when its agent settles.
 *
 * `enabled` is the caller's gate — it is false while the pane view has nothing to show (a gone pane)
 * so a dead pane costs no request at all. `refresh` is for the one moment a status change cannot
 * catch: the operator closed the Changes sheet, where they may have been looking at a tree the
 * agent moved without changing state.
 */
export function usePaneDiff(
  paneId: string,
  status: AgentStatus | undefined,
  scope?: Scope,
  enabled = true,
): PaneDiffHandle {
  const [summary, setSummary] = useState<PaneDiffSummary>(NONE);
  const inFlight = useRef<AbortController | null>(null);

  const read = useCallback(() => {
    if (!enabled) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    void (async () => {
      try {
        const data = await api.fetchPaneDiff(paneId, { mode: "stat" }, scope, controller.signal);
        if (controller.signal.aborted || data.mode !== "stat") return;
        setSummary(summarise(data.files));
      } catch {
        // Not a work tree, outside the roots, or a bridge that predates the route — see the header.
        if (!controller.signal.aborted) setSummary(NONE);
      }
    })();
  }, [paneId, scope, enabled]);

  // A new pane starts from nothing rather than from the previous pane's numbers: `DetailRoute` keys
  // the view by pane id, but a scope change does not remount, and a chip carrying the last pane's
  // counts for one frame is a chip that has lied.
  useEffect(() => {
    setSummary(NONE);
  }, [paneId, scope]);

  useEffect(() => {
    read();
    return () => inFlight.current?.abort();
  }, [read, status]);

  return { summary, refresh: read };
}
