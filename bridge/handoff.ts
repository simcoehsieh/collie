import type { ArtifactRecord } from "./artifacts.ts";
import type { TranscriptEntry } from "./journal/types.ts";
import type { CreateResponse, CreatedPane } from "./types.ts";

// FORK — HANDING A CONVERSATION TO ANOTHER AGENT.
//
// A session cannot move between harnesses: Claude Code's log and Codex's log are different formats
// and neither CLI imports the other's. What CAN move is the context, written down. A handoff is a
// markdown document the bridge assembles from what it already knows about a pane — the newest
// assistant turn (the previous agent's own summary, when the phone asked it for one first), the
// pane's recent turns, the artifacts it made, and what the operator wants done next — kept as an
// artifact of that pane, and then the next harness is launched in the same directory with ONE
// instruction: read that file and continue.
//
// PURE. The route in server.ts does the reading (journal, artifact store) and the launching; this
// module answers three table-testable questions: which harness a launcher row starts and how it takes
// an opening prompt, what the document says, and what one shell line starts it.

export const HANDOFF_TAG = "handoff";

/**
 * POST /api/pane/:id/handoff — the pane the new agent runs in (navigate straight into it) and the
 * document it was handed, as the artifact it now is. The failure arm is `launch`'s own.
 */
export type HandoffResponse =
  | { ok: true; pane: CreatedPane; artifact: ArtifactRecord }
  | Extract<CreateResponse, { ok: false }>;

/** The user turns a handoff document does not repeat: the phone's own "please summarise" prompt
 *  (web/src/lib/handoff.ts writes it, and opens it with this sentinel). */
export const HANDOFF_SENTINEL = "[collie handoff]";

/** How many of the pane's newest turns the document carries, and how much of each. */
export const HANDOFF_RECENT_TURNS = 12;
export const HANDOFF_TURN_CHARS = 1200;
/** The previous agent's own words are the point of the document, so they get a far larger budget. */
export const HANDOFF_LATEST_CHARS = 16_000;
export const HANDOFF_INSTRUCTION_CHARS = 4000;

/** The harnesses a handoff can start, by how each takes an opening prompt on its command line. */
export type HandoffHarness = "claude" | "codex" | "agy";

/**
 * The harness a launcher row starts, read off the first token of its command (`claude`,
 * `~/bin/codex --profile x`, `agy`). Null for anything else — a row this cannot hand a prompt to is
 * refused, never guessed at.
 */
export function handoffHarnessOf(command: string): HandoffHarness | null {
  const first = command.trim().split(/\s+/u)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  if (base === "claude" || base === "codex" || base === "agy") return base;
  return null;
}

/** POSIX single-quoting: the only escape is closing, backslash-quoting, and reopening. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Whether the line carries an ASCII control character — a newline would submit a second line. */
export function hasControlChar(line: string): boolean {
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The one line the next agent starts with. Deliberately carries NO operator text: the instruction
 * lives in the document, so the shell line is the same shape every time and never has to quote a
 * sentence — only a path, which {@link shellQuote} handles.
 */
export function handoffPrompt(documentPath: string, fromAgent: string): string {
  return (
    `Read ${documentPath} first. It is the handoff from the previous agent (${fromAgent}) ` +
    `in this directory. Then continue with its section "What to do next".`
  );
}

/**
 * The shell line that starts `row.command` with the prompt as its opening message: a positional
 * argument for Claude Code and Codex, `-i` (`--prompt-interactive`) for agy. Null when the row's
 * command is not a harness this knows how to hand a prompt to.
 */
export function handoffCommandLine(rowCommand: string, prompt: string, options?: { model: string; effort: string }): string | null {
  const harness = handoffHarnessOf(rowCommand);
  if (harness === null) return null;
  const flag = harness === "agy" ? " -i " : " ";
  if (options && (harness !== "codex" || rowCommand.trim().split(/\s+/u).length !== 1)) return null;
  const flags = options ? ` --model ${shellQuote(options.model)} -c ${shellQuote(`model_reasoning_effort=${JSON.stringify(options.effort)}`)}` : "";
  return `${rowCommand.trim()}${flags}${flag}${shellQuote(prompt)}`;
}

/** What the document is assembled from, beyond the transcript. */
export interface HandoffFacts {
  readonly fromAgent: string;
  readonly toLabel: string;
  readonly workspaceLabel: string;
  readonly cwd: string;
  readonly paneId: string;
  readonly whenMs: number;
  readonly instruction: string;
  readonly artifacts: readonly { readonly title: string; readonly path: string; readonly id: string }[];
}

/** The prose of one turn — text parts only; thinking is not what the agent said. */
function proseOf(entry: TranscriptEntry): string {
  return entry.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}\n[… ${String(text.length - max)} more characters]` : text;
}

/** Is this the phone's own "write a handoff" prompt? Never repeated into the document. */
function isHandoffAsk(entry: TranscriptEntry): boolean {
  return entry.role === "user" && proseOf(entry).startsWith(HANDOFF_SENTINEL);
}

/**
 * The newest assistant turn's prose, whole — the previous agent's own account when the phone asked
 * for one, and simply its last reply when it did not. Null when there is none to quote.
 */
export function latestAssistantProse(entries: readonly TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined || entry.role !== "assistant") continue;
    const prose = proseOf(entry);
    if (prose !== "") return prose;
  }
  return null;
}

/**
 * The newest turns as a short transcript, oldest first: speech in full (clamped), tool calls as
 * one-liners, the handoff ask itself left out. The last assistant turn is left out too when it is
 * the one already quoted whole above it.
 */
export function recentTurnsMarkdown(
  entries: readonly TranscriptEntry[],
  fromAgent: string,
  max = HANDOFF_RECENT_TURNS,
  quotedLatest = true,
): string {
  const kept = entries.filter((e) => (e.role === "user" || e.role === "assistant") && !isHandoffAsk(e));
  let end = kept.length;
  if (quotedLatest) {
    for (let i = kept.length - 1; i >= 0; i--) {
      const entry = kept[i];
      if (entry !== undefined && entry.role === "assistant" && proseOf(entry) !== "") {
        end = i;
        break;
      }
    }
  }
  const window = kept.slice(Math.max(0, end - max), end);
  const blocks: string[] = [];
  for (const entry of window) {
    const who = entry.role === "user" ? "operator" : fromAgent;
    const lines: string[] = [];
    const prose = proseOf(entry);
    if (prose !== "") lines.push(clamp(prose, HANDOFF_TURN_CHARS));
    for (const part of entry.parts) {
      if (part.kind === "tool") lines.push(`· ${part.name}: ${part.summary}`);
      if (part.kind === "todo") {
        for (const item of part.items) lines.push(`· [${item.status === "completed" ? "x" : " "}] ${item.text}`);
      }
    }
    if (lines.length === 0) continue;
    blocks.push(`**${who}:**\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/** The whole document. Headings are fixed so the next agent's opening instruction can name one. */
export function buildHandoffDocument(facts: HandoffFacts, entries: readonly TranscriptEntry[]): string {
  const latest = latestAssistantProse(entries);
  const instruction = facts.instruction.trim();
  const out: string[] = [];
  out.push(`# Handoff — ${facts.fromAgent} → ${facts.toLabel}`, "");
  out.push(`- From: **${facts.fromAgent}** in **${facts.workspaceLabel}** (\`${facts.cwd}\`), pane ${facts.paneId}`);
  out.push(`- Written: ${new Date(facts.whenMs).toISOString()}`);
  out.push(`- Next agent: ${facts.toLabel}`, "");
  out.push("## What to do next", "");
  out.push(
    instruction === ""
      ? "_No instruction was given. Continue where the previous agent stopped._"
      : clamp(instruction, HANDOFF_INSTRUCTION_CHARS),
    "",
  );
  out.push(`## Where ${facts.fromAgent} left off, in its own words`, "");
  out.push(
    latest === null
      ? "_The previous agent left no summary; the recent turns below are all there is._"
      : clamp(latest, HANDOFF_LATEST_CHARS),
    "",
  );
  out.push("## Artifacts this pane made", "");
  if (facts.artifacts.length === 0) out.push("_None._", "");
  else {
    for (const a of facts.artifacts) out.push(`- ${a.title} — \`${a.path}\` (artifact ${a.id})`);
    out.push("");
  }
  const recent = recentTurnsMarkdown(entries, facts.fromAgent, HANDOFF_RECENT_TURNS, latest !== null);
  out.push("## Recent turns, oldest first", "");
  out.push(recent === "" ? "_Nothing on record._" : recent, "");
  return out.join("\n");
}
