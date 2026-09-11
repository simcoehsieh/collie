// FORK — "WHILE YOU WERE AWAY", derived and never written.
//
// Opening a pane you last looked at eight hours ago, the first thing on screen is the END of
// something: a tool call, half an answer, a cursor. What happened in between is thirty screens up.
// This composes the answer out of facts already in hand — how many turns, what kind of work, what
// changed on disk, whether a question is still standing — so the card says something true without
// anyone summarising anything.
//
// NO LLM, AND NOT AS A COST DECISION. A rollup an agent wrote is a rollup that can be wrong in a way
// the reader cannot check, on the one screen whose whole job is to be trusted after an absence. Every
// number below is a count of something the client already holds, so the card is either right or
// visibly empty.
//
// THE WATERMARK IS THE SHARED ONE (.adr/0003): `lastSeenAt` is stamped bridge-side by the same
// `x-collie-seen` header every pane read carries, so "away" means away from EVERY device, not away
// from this browser. That is why the card can be a plain function of the snapshot rather than a
// second per-device ledger.
//
// PURE. The clock, the watermark and the turns are all arguments — no `Date.now()` in here — so the
// whole thing is table-testable.

import { toolKind, type ToolKind } from "./tool-kind";
import type { TranscriptEntry } from "./types";

/** How long a pane must have gone unopened before the card is worth its height. One hour. */
export const AWAY_THRESHOLD_MS = 60 * 60 * 1000;

/** One kind of work and how much of it happened. */
export interface ToolMix {
  kind: ToolKind;
  count: number;
}

/** What the card says. Every field is a count or a timestamp — nothing here is prose. */
export interface AwayFacts {
  /** Turns the agent took since the watermark — assistant turns only, which is the work. */
  agentTurns: number;
  /** Turns YOU took in that window. Non-zero means someone else drove the pane, or you forgot. */
  userTurns: number;
  /** Tool calls by kind, busiest first, zero counts dropped. */
  tools: ToolMix[];
  /** Total tool calls, i.e. the sum of `tools` — carried so the card never re-adds it. */
  toolCalls: number;
  /** When the agent last asked something, epoch ms, or null when it never did (or carried no stamp). */
  lastQuestionAt: number | null;
}

/** Nothing happened — also what an empty/unreadable transcript produces. */
const NOTHING: AwayFacts = {
  agentTurns: 0,
  userTurns: 0,
  tools: [],
  toolCalls: 0,
  lastQuestionAt: null,
};

/** A turn's ISO stamp as epoch ms, or null when the log carried none (some rows do not). */
function stampOf(entry: TranscriptEntry): number | null {
  if (entry.ts === "") return null;
  const ms = Date.parse(entry.ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Does this turn end in a question the operator is expected to answer?
 *
 * A blunt test on purpose — the last non-empty line ending in `?`. An agent's prose is markdown and
 * its closing line is where it asks; anything cleverer (parsing, a model) would be a guess dressed up
 * as a fact, and the card's whole premise is that it only states what it can count. A false negative
 * costs one line of the card; a false positive would claim a question that is not there, so the test
 * leans strict: the LAST line, not any line.
 */
export function endsWithQuestion(entry: TranscriptEntry): boolean {
  if (entry.role !== "assistant") return false;
  const prose = entry.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trimEnd();
  if (prose === "") return false;
  const lastLine = prose.split("\n").at(-1)?.trim() ?? "";
  return lastLine.endsWith("?") || lastLine.endsWith("？");
}

/**
 * What happened in this pane since `sinceMs`.
 *
 * Turns with NO timestamp are counted as "since" when anything after them is: a log's stamps are
 * monotonic, so an unstamped row between two stamped ones belongs to the window its neighbours do.
 * Implemented as a single backward walk that stops at the first turn provably older than the mark,
 * which is also what keeps this cheap on a thread of hundreds.
 */
export function awayFacts(entries: readonly TranscriptEntry[], sinceMs: number): AwayFacts {
  if (entries.length === 0) return NOTHING;
  const counts = new Map<ToolKind, number>();
  let agentTurns = 0;
  let userTurns = 0;
  let toolCalls = 0;
  let lastQuestionAt: number | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const at = stampOf(entry);
    if (at !== null && at <= sinceMs) break;
    if (entry.role === "assistant") agentTurns++;
    if (entry.role === "user") userTurns++;
    for (const part of entry.parts) {
      if (part.kind !== "tool") continue;
      toolCalls++;
      const kind = toolKind(part.name);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    // Walking backwards, the FIRST question found is the newest one.
    if (lastQuestionAt === null && at !== null && endsWithQuestion(entry)) lastQuestionAt = at;
  }
  const tools = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    // Count first, then the kind's own name, so two kinds with the same count never swap places
    // between renders (Map order is insertion order, which a re-fetch can change).
    .toSorted((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  return { agentTurns, userTurns, tools, toolCalls, lastQuestionAt };
}

/** Is the card worth showing at all — an absence past the threshold with something to report. */
export function isAway(lastSeenAt: number | undefined, now: number, thresholdMs = AWAY_THRESHOLD_MS): boolean {
  return lastSeenAt !== undefined && lastSeenAt > 0 && now - lastSeenAt >= thresholdMs;
}

/** True when the facts add up to nothing — the card renders nothing rather than "0 turns". */
export function factsAreEmpty(facts: AwayFacts): boolean {
  return facts.agentTurns === 0 && facts.userTurns === 0 && facts.toolCalls === 0;
}
