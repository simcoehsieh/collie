import type { AgentStatus, Launcher } from "./types";

// FORK — handing a pane's conversation to another harness (bridge/handoff.ts holds the other half).
//
// The phone's part is small and stated here so it is testable without the sheet: which launcher
// rows can take a handoff, the one prompt that asks the current agent to write its own summary
// first, and the rule for "the summary is written" — the only thing the sheet waits on.

/**
 * Opens the summary ask, and is what the bridge strips from the document's recent turns
 * (bridge/handoff.ts `HANDOFF_SENTINEL` — the two strings must stay byte-identical).
 */
export const HANDOFF_SENTINEL = "[collie handoff]";

/**
 * What the current agent is asked before the handoff, when the operator wants its own account.
 * English on purpose: it is an instruction to a harness, not copy for the operator, and every
 * harness reads it. The reply becomes the "in its own words" section of the document.
 */
export const HANDOFF_SUMMARY_PROMPT =
  `${HANDOFF_SENTINEL} Another agent is about to take over this work in this directory. ` +
  "Reply with a handoff summary and nothing else: the goal, what is done, what is left (in order), " +
  "the key files and decisions, and anything that would trip up someone new. Do not run tools or change files.";

/** The harnesses a handoff can start — the bridge's list, mirrored so the row is offered only when it will work. */
export type HandoffHarness = "claude" | "codex" | "agy";

/** The harness a launcher row starts, read off its command's first token; null for anything else. */
export function handoffHarnessOf(command: string): HandoffHarness | null {
  const first = command.trim().split(/\s+/u)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  if (base === "claude" || base === "codex" || base === "agy") return base;
  return null;
}

/**
 * The rows a handoff from `currentAgent` may go to: every launcher that starts a harness this can
 * hand a prompt to, except the one already running here — "hand off to yourself" is a restart, and
 * that row is the tab strip's "+".
 */
export function handoffTargets(launchers: readonly Launcher[], currentAgent: string): Launcher[] {
  return launchers.filter((row) => {
    const harness = handoffHarnessOf(row.command);
    return harness !== null && harness !== currentAgent;
  });
}

/** What the sheet remembers while the summary is being written. */
export interface SummaryWait {
  /** Whether the pane has been seen `working` since the ask was sent. */
  readonly sawWorking: boolean;
}

export const SUMMARY_WAIT_START: SummaryWait = { sawWorking: false };

/**
 * One step of the wait: the summary is written once the pane has been seen working and is not any
 * more. A pane that never turns `working` (the poll missed a fast reply, or the ask was queued
 * behind nothing) is the sheet's timer's business, not this rule's.
 */
export interface SummaryStep {
  readonly next: SummaryWait;
  readonly settled: boolean;
}

export function summaryStep(prev: SummaryWait, status: AgentStatus | undefined): SummaryStep {
  if (status === "working") return { next: { sawWorking: true }, settled: false };
  return { next: prev, settled: prev.sawWorking };
}

/** How long the sheet waits for the pane to turn `working` before handing off with what there is. */
export const SUMMARY_START_TIMEOUT_MS = 20_000;
/** The most a summary may take before the sheet hands off regardless. */
export const SUMMARY_TOTAL_TIMEOUT_MS = 5 * 60_000;
