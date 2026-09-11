// FORK — WHAT A TOOL CALL *DID*, in nine words that every harness shares.
//
// A tool card used to render one glyph (a wrench) for all of it, so a thread of 700 tool calls — the
// measured shape of a real session — was 700 identical rows whose only distinguishing mark was a
// name in a font small enough to need reading. Scanning that for "where did it edit something" is
// character work, which is exactly what an icon column exists to save.
//
// THE VOCABULARY IS ZED'S ACP `ToolKind`, adopted rather than invented: read · edit · delete · move ·
// search · execute · think · fetch · other. It is the one list in the wild that several agent front
// ends already map their harnesses onto, it is nine words rather than a taxonomy, and every one of
// them answers the question an operator actually asks of a row at a glance. `other` is a real member
// of the set and not a failure: a tool this table has never heard of is honestly "something else",
// and inventing a kind for it would put a wrong icon beside a right name.
//
// WHY THE TABLE IS HERE AND NOT IN THE JOURNAL ADAPTERS. The kind is PRESENTATION — it decides a
// glyph and nothing else. Keeping it client-side means adding a harness's spellings is a one-line
// change with no wire field, no bridge release and no golden to update, and it keeps the parse in
// `bridge/journal/` free of a vocabulary that only a renderer consumes. (The tool NAME is already on
// the wire; this is a pure function of it.)
//
// MATCHING IS BY EXACT NAME FIRST, THEN BY A SUBSTRING RULE, and the order matters: `Read` and
// `NotebookRead` are both reads, but `Grep` must not become a read because it happens to contain
// "re". Exact names are the harness vocabularies we have actually read out of logs; the substring
// pass is the fallback for the MCP tools an operator has installed, which are named freely
// (`mcp__github__search_issues`) and cannot be enumerated.

import type { TranscriptPart } from "./types";

/** Zed's ACP `ToolKind`, verbatim. `other` is the honest answer, never a failure. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

/**
 * Exact tool names, lower-cased, as the harnesses spell them.
 *
 * A `Map` and not an object literal, for the reason `bridge/journal/registry.ts` states about its own
 * alias table: the key ORIGINATES in an agent's own tool name, so an inherited `Object.prototype` key
 * ("toString", "constructor") arriving as one must not resolve to something that is not a kind.
 *
 * Read out of real logs rather than documentation: Claude Code's PascalCase set, Codex's snake_case
 * set, and the handful pi/opencode/grok share with either. A name absent here still gets a kind from
 * the substring pass below.
 */
const EXACT = new Map<string, ToolKind>(Object.entries({
  // ── Claude Code ──────────────────────────────────────────────────────────────
  read: "read",
  notebookread: "read",
  glob: "search",
  grep: "search",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  bash: "execute",
  bashoutput: "execute",
  killshell: "execute",
  task: "think",
  todowrite: "think",
  exitplanmode: "think",
  webfetch: "fetch",
  websearch: "search",
  // ── Codex ────────────────────────────────────────────────────────────────────
  shell: "execute",
  local_shell: "execute",
  exec_command: "execute",
  apply_patch: "edit",
  view_image: "read",
  update_plan: "think",
  web_search: "search",
  // ── pi / opencode / grok, where they differ from the two above ───────────────
  list: "read",
  ls: "read",
  view: "read",
  patch: "edit",
  str_replace_editor: "edit",
  run: "execute",
  terminal: "execute",
  think: "think",
  plan: "think",
  fetch: "fetch",
  // The unattached result an adapter emits when a call fell outside the tail-read window. It is an
  // OUTPUT with no call, so naming its kind would be naming a tool we never saw.
  result: "other",
} satisfies Record<string, ToolKind>));

/**
 * Substring rules, tried in order, against the lower-cased name.
 *
 * ORDER IS THE WHOLE CORRECTNESS STORY, because these overlap on purpose. `delete` before `edit`
 * (a delete is not an edit), `move` before `edit` (a rename is not an edit), `search` before `read`
 * (`search_files` reads files and is a search), and `read` last of the file verbs so it cannot claim
 * a name a more specific rule already described.
 */
const PATTERNS: readonly (readonly [RegExp, ToolKind])[] = [
  [/\b(delete|remove|rm|unlink|trash)\b|delete_|remove_/u, "delete"],
  [/\b(move|rename|mv)\b|move_|rename_/u, "move"],
  [/search|grep|glob|find|query|lookup|list_/u, "search"],
  [/exec|shell|bash|command|run_|terminal|process/u, "execute"],
  [/edit|write|patch|create|update|apply|insert|replace/u, "edit"],
  [/fetch|http|curl|download|browse|url/u, "fetch"],
  [/read|cat|open|view|get_|show|inspect|retrieve|load/u, "read"],
  [/think|plan|todo|reason|reflect/u, "think"],
];

/**
 * The kind of a tool call, from its name alone.
 *
 * An MCP tool arrives as `mcp__<server>__<tool>`; the server name is somebody's brand and says
 * nothing about what the call does, so only the part after the last `__` is matched. Total: every
 * string has a kind, and the kind for "no idea" is `other`.
 */
export function toolKind(name: string): ToolKind {
  const tail = name.split("__").pop() ?? name;
  const key = tail.trim().toLowerCase();
  if (key === "") return "other";
  const exact = EXACT.get(key);
  if (exact !== undefined) return exact;
  for (const [pattern, kind] of PATTERNS) if (pattern.test(key)) return kind;
  return "other";
}

/**
 * How far a tool call has got, in ACP's four words.
 *
 * DERIVED, never reported — a journal row says what happened, not what is happening, so the only
 * honest reading of "a call with no result yet" depends on whether the pane is still moving:
 *
 *  • a result that carried `isError` → `failed`
 *  • any other result → `completed`
 *  • no result, pane WORKING → `in_progress` (the harness has not flushed the answer yet)
 *  • no result, pane at rest → `pending`, which on a finished turn is the honest "this call never
 *    got an answer in the window we can see" rather than a claim that it is running
 */
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export function toolStatus(
  part: Extract<TranscriptPart, { kind: "tool" }>,
  working: boolean,
): ToolStatus {
  if (part.result === undefined) return working ? "in_progress" : "pending";
  return part.result.isError === true ? "failed" : "completed";
}
