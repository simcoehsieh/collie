import { useCallback, useEffect, useState } from "react";

import { fetchPane } from "@/lib/api";
import { hasBlockGrammar } from "@/lib/harness";
import type { PromptModel } from "@/lib/harness/prompt-model";
import { binaryChoice, promptAtTail, type BinaryChoice } from "@/lib/prompt-approve";
import { submitPromptOption, type PromptActionResult } from "@/lib/prompt-action";
import { internScope, paneScopeKey, type Scope } from "@/lib/scope";
import type { AgentView } from "@/lib/types";

// FORK: what a blocked row on the dashboard knows about the dialog waiting in its pane — enough to
// offer Yes and No without navigating to it. Answering a permission prompt used to be four taps
// (open the row, wait for the mirror, find the button, tap it, come back); on a machine with four
// always-on listener panes those four taps are most of what the phone is for.
//
// The peek is ONE pane read per blocked transition, shared across every render of that row through
// a module cache keyed by the pane's address and the transition's timestamp. The answer goes
// through `submitPromptOption` — the very function the pane view's own button calls — so the read
// is guarded, re-derived through the pane's grammar and bound to the region the bridge verifies;
// this hook adds no second way to type into a terminal.

/** Lines to read for the peek: the dialog and its subject, not the scrollback. */
export const PEEK_LINES = 80;

/** How many peeks to remember. Blocked panes are few; this only bounds a long session. */
const CACHE_MAX = 32;

export interface PromptPeek {
  /** Herdr's revision of the read the dialog was derived from — what the race guard checks. */
  revision: number;
  prompt: PromptModel;
  choice: BinaryChoice;
}

const cache = new Map<string, Promise<PromptPeek | null>>();

/** The scope a pane's own address names — the pane's host and session, or the ambient defaults. */
function scopeOf(agent: AgentView): Scope {
  return internScope({ host: agent.host, session: agent.session });
}

function peekKey(agent: AgentView): string {
  return `${paneScopeKey(scopeOf(agent), agent.paneId)}@${agent.lastActiveAt ?? 0}`;
}

/** Read the pane once and lift a yes/no dialog off its tail; null when there is none. Memoised per
 *  (pane address, transition), so a list of rows costs one read per blocked pane, not one per render. */
export function peekPrompt(agent: AgentView): Promise<PromptPeek | null> {
  const key = peekKey(agent);
  const hit = cache.get(key);
  if (hit) return hit;
  const run = (async (): Promise<PromptPeek | null> => {
    try {
      const read = await fetchPane(agent.paneId, PEEK_LINES, scopeOf(agent));
      const prompt = promptAtTail(read.text, agent.agent);
      const choice = prompt === null ? null : binaryChoice(prompt);
      return prompt !== null && choice !== null ? { revision: read.revision, prompt, choice } : null;
    } catch {
      return null;
    }
  })();
  cache.set(key, run);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return run;
}

/** Forget a pane's peek — after an answer, or after the guard said the dialog moved on. */
export function forgetPeek(agent: AgentView): void {
  cache.delete(peekKey(agent));
}

/** Test seam. */
export function __resetPeekCache(): void {
  cache.clear();
}

/** Whether a row should look: the pane is waiting on input AND its agent has a grammar to read. */
export function canPeek(agent: AgentView): boolean {
  return agent.status === "blocked" && agent.kind !== "shell" && hasBlockGrammar(agent.agent);
}

export interface PromptPeekControl {
  /** The yes/no dialog waiting in the pane, or null (none, not yet read, or not a yes/no). */
  peek: PromptPeek | null;
  /** Which button was sent for this dialog, once one was — the strip stays up, disabled, until the
   *  pane leaves `blocked` on the next poll, so the ✓ and the word "Sent" are not yanked away. */
  answered: "yes" | "no" | null;
  /** Answer it. Resolves to the guarded action's result; `changed` means the dialog moved on — the
   *  peek is dropped and the pane read again, so the row offers whatever is there now. */
  answer: (which: "yes" | "no") => Promise<PromptActionResult>;
}

export function usePromptPeek(agent: AgentView): PromptPeekControl {
  const [peek, setPeek] = useState<PromptPeek | null>(null);
  const [answered, setAnswered] = useState<"yes" | "no" | null>(null);
  const eligible = canPeek(agent);
  const key = eligible ? peekKey(agent) : null;

  useEffect(() => {
    // A new transition (or none) is a new dialog: nothing has been answered on it yet.
    setAnswered(null);
    if (key === null) {
      setPeek(null);
      return;
    }
    let alive = true;
    void (async () => {
      const p = await peekPrompt(agent);
      if (alive) setPeek(p);
    })();
    return () => {
      alive = false;
    };
    // `key` is the whole identity of a peek (address + transition). `agent` changes reference on
    // every poll, but the cache answers the same key with the same promise, so the re-run costs a
    // lookup and settles on the object already in state.
  }, [key, agent]);

  const answer = useCallback(
    async (which: "yes" | "no"): Promise<PromptActionResult> => {
      if (peek === null) return { status: "changed" };
      const option = which === "yes" ? peek.choice.yes : peek.choice.no;
      const result = await submitPromptOption({
        paneId: agent.paneId,
        scope: scopeOf(agent),
        requestedLines: PEEK_LINES,
        detectedRevision: peek.revision,
        agent: agent.agent,
        prompt: peek.prompt,
        option,
      });
      if (result.status === "sent") {
        setAnswered(which);
      } else if (result.status === "changed") {
        // The dialog moved on under the peek: read again and offer what is there now, if anything.
        forgetPeek(agent);
        setPeek(await peekPrompt(agent));
      }
      return result;
    },
    [agent, peek],
  );

  return { peek, answered, answer };
}
