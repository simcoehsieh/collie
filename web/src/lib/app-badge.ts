import { isUnseen } from "./triage";
import type { AgentView } from "./types";

// FORK — what the app icon's badge counts, stated once so the page and the tests agree.
//
// The number on the icon is "how many panes want you": every blocked pane, plus every pane that
// finished while you were not looking (triage.ts's `isUnseen`, the same test the herd's "Done"
// section uses). Opening the pane bumps `lastSeenAt` past `lastActiveAt` on the bridge and the
// count falls on the next poll — no bookkeeping of its own, exactly as the section has none.

export function attentionCount(agents: readonly AgentView[]): number {
  let n = 0;
  for (const a of agents) if (a.status === "blocked" || isUnseen(a)) n++;
  return n;
}

/** The two calls the Badging API has, behind a seam so the hook is testable without a browser. */
export interface BadgeSink {
  set(count: number): Promise<void>;
  clear(): Promise<void>;
}

/** The browser's own, or null where the API is absent (a desktop tab, an old engine). */
export function browserBadge(): BadgeSink | null {
  if (!("setAppBadge" in navigator)) return null;
  return {
    set: (count) => navigator.setAppBadge(count),
    clear: () => navigator.clearAppBadge(),
  };
}

/** Apply a count: a positive one is shown, zero clears. Best-effort — the platform may refuse. */
export async function applyBadge(sink: BadgeSink, count: number): Promise<void> {
  try {
    if (count > 0) await sink.set(count);
    else await sink.clear();
  } catch {
    /* refused or unsupported at this moment — the herd list still shows the truth */
  }
}
