// FORK — THE PLAN A HARNESS KEEPS, read out of the one tool call that carries it.
//
// Every agent worth watching keeps a checklist, and every one of them writes it through a tool: Claude
// Code's `TodoWrite` takes the WHOLE list on every call, Codex's `update_plan` does the same under
// different field names. Summarised the way any other tool call is summarised, that list collapses to
// one line of its first item — `summarizeToolInput` picks a string and stops — and the single most
// useful thing on the screen ("where is it in the job, and what is left") is thrown away at the parse.
//
// So the list is kept, as a part of its own. The adapters call in here; the view pins the LATEST one
// it holds to the top of the pane transcript. The shape is deliberately the same for both harnesses,
// because the card that renders it must not learn which agent it is looking at.
//
// PURE, like every other parse in this directory — no fs, no clock — so both grammars are
// table-testable under `bun test`.
//
// A HARNESS WITH NO SUCH TOOL IS NOT A PROBLEM. Both readers answer `null` for an input that is not
// their shape, the adapter falls through to the ordinary tool part, and the pane simply never pins a
// card. That is the whole of "skip gracefully": there is no capability, no flag and nothing to
// declare.

import type { JsonValue } from "../json.ts";
import { oneLine } from "./text.ts";
import type { TodoItem, TodoStatus } from "./types.ts";

/**
 * How many items one card may hold.
 *
 * A plan longer than this is a plan nobody reads off a phone, and the cap is what keeps a
 * pathological tool input from turning one turn into a screenful. The overflow is DROPPED rather
 * than summarised: the card counts what it shows, so a truncated tail would make its own counts lie.
 */
export const MAX_TODO_ITEMS = 40;

/** The three states both harnesses spell identically. Anything else is not a status we can render. */
const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

function asStatus(value: JsonValue | undefined): TodoStatus | null {
  return typeof value === "string" ? (STATUSES.find((s) => s === value) ?? null) : null;
}

/**
 * One list, from a tool input, given the keys this harness spells its two fields with.
 *
 * `listKey` is the array; `textKeys` are tried in order for the item's words, because the two
 * harnesses disagree about what to call them and a future third will disagree again. An item with no
 * text or no recognised status is dropped — a half-parsed row in a checklist is worse than a shorter
 * checklist, since the card's counts are read as a progress bar.
 *
 * Returns null (never an empty list) when the input is not this shape at all, so the caller can tell
 * "not a plan tool" from "a plan that is currently empty".
 */
export function readTodoList(
  input: JsonValue | undefined,
  listKey: string,
  textKeys: readonly string[],
): TodoItem[] | null {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = input[listKey];
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const status = asStatus(row.status);
    if (status === null) continue;
    let text = "";
    for (const key of textKeys) {
      const value = row[key];
      if (typeof value === "string" && value.trim() !== "") {
        text = oneLine(value);
        break;
      }
    }
    if (text === "") continue;
    items.push({ text, status });
    if (items.length >= MAX_TODO_ITEMS) break;
  }
  return items;
}

/**
 * Claude Code's `TodoWrite` input: `{ todos: [{ content, activeForm, status }] }`.
 *
 * `content` is the imperative form ("Read the adapter") and `activeForm` the progressive one
 * ("Reading the adapter"); the card shows one line per item in one voice, so `content` leads and
 * `activeForm` is only the fallback for a row that somehow carries no `content`.
 */
export function claudeTodoItems(input: JsonValue | undefined): TodoItem[] | null {
  return readTodoList(input, "todos", ["content", "activeForm"]);
}

/**
 * Codex's `update_plan` input: `{ plan: [{ step, status }], explanation? }`.
 *
 * The explanation is prose ABOUT the change and is not rendered here — the card is the list, and a
 * sentence above it would make the pinned card grow with every re-plan.
 */
export function codexPlanItems(input: JsonValue | undefined): TodoItem[] | null {
  return readTodoList(input, "plan", ["step", "content"]);
}

/** Whether a tool call by this name is Claude Code's plan writer. Exact, never a prefix match. */
export function isClaudeTodoTool(name: string): boolean {
  return name === "TodoWrite";
}

/** Whether a Codex function call by this name is its plan writer. */
export function isCodexPlanTool(name: string): boolean {
  return name === "update_plan";
}
