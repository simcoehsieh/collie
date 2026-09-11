import { describe, expect, test } from "bun:test";

import {
  HANDOFF_LATEST_CHARS,
  HANDOFF_SENTINEL,
  buildHandoffDocument,
  handoffCommandLine,
  handoffHarnessOf,
  handoffPrompt,
  hasControlChar,
  latestAssistantProse,
  recentTurnsMarkdown,
  shellQuote,
  type HandoffFacts,
} from "./handoff.ts";
import type { TranscriptEntry } from "./journal/types.ts";

// FORK — the pure half of a handoff (bridge/handoff.ts): which rows can take an opening prompt and
// how, what the shell line is, and what the document says. The route is tested in server.test.ts.

const user = (uuid: string, text: string): TranscriptEntry => ({ uuid, ts: "", role: "user", parts: [{ kind: "text", text }] });
const assistant = (uuid: string, text: string, extra: TranscriptEntry["parts"] = []): TranscriptEntry => ({
  uuid,
  ts: "",
  role: "assistant",
  parts: [{ kind: "text", text }, ...extra],
});

const facts: HandoffFacts = {
  fromAgent: "claude",
  toLabel: "codex",
  workspaceLabel: "ai-live",
  cwd: "/home/op/ai-live",
  paneId: "w4:p2",
  whenMs: Date.UTC(2026, 8, 11, 9, 30),
  instruction: "Finish the tests, then run the linter.",
  artifacts: [{ title: "Plan", path: "/state/artifacts/ab-00000001.html", id: "ab-00000001" }],
};

describe("handoffHarnessOf — the first token names the harness", () => {
  test("claude, codex and agy, bare or with a path and flags", () => {
    expect(handoffHarnessOf("claude")).toBe("claude");
    expect(handoffHarnessOf("  codex --profile fast ")).toBe("codex");
    expect(handoffHarnessOf("/opt/bin/agy")).toBe("agy");
  });
  test("anything else is null, never a guess", () => {
    expect(handoffHarnessOf("rumen-peek")).toBeNull();
    expect(handoffHarnessOf("claude-code")).toBeNull();
    expect(handoffHarnessOf("")).toBeNull();
  });
});

describe("handoffCommandLine — one shell line, the prompt single-quoted", () => {
  test("a positional prompt for claude and codex, -i for agy", () => {
    expect(handoffCommandLine("claude", "Read x first.")).toBe("claude 'Read x first.'");
    expect(handoffCommandLine("codex --profile fast", "go")).toBe("codex --profile fast 'go'");
    expect(handoffCommandLine("agy", "go")).toBe("agy -i 'go'");
  });
  test("a quote inside the prompt is closed, escaped and reopened", () => {
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
    expect(handoffCommandLine("codex", "/Users/o'brien/x.md")).toBe(String.raw`codex '/Users/o'\''brien/x.md'`);
  });
  test("a row this cannot hand a prompt to is null", () => {
    expect(handoffCommandLine("rumen-peek", "go")).toBeNull();
  });
  test("the prompt names the file, the previous agent and the section to continue from", () => {
    const prompt = handoffPrompt("/state/artifacts/h-1.md", "claude");
    expect(prompt).toContain("/state/artifacts/h-1.md");
    expect(prompt).toContain("(claude)");
    expect(prompt).toContain('"What to do next"');
    expect(hasControlChar(prompt)).toBe(false);
  });
});

describe("hasControlChar", () => {
  test("a newline or a tab is one; ordinary punctuation and non-ASCII are not", () => {
    expect(hasControlChar("codex 'a\nb'")).toBe(true);
    expect(hasControlChar("a\tb")).toBe(true);
    expect(hasControlChar("codex '接續 — it's fine'")).toBe(false);
  });
});

describe("latestAssistantProse — the newest assistant turn, whole", () => {
  test("skips tool-only turns and thinking; null when there is none", () => {
    const entries: TranscriptEntry[] = [
      user("u1", "do it"),
      assistant("a1", "First answer"),
      { uuid: "a2", ts: "", role: "assistant", parts: [{ kind: "thinking", text: "hmm" }, { kind: "tool", name: "Bash", summary: "ls" }] },
    ];
    expect(latestAssistantProse(entries)).toBe("First answer");
    expect(latestAssistantProse([user("u1", "x")])).toBeNull();
  });
});

describe("recentTurnsMarkdown — speech in full, tools as one-liners, the ask left out", () => {
  test("drops the phone's own handoff ask and the quoted latest turn", () => {
    const entries: TranscriptEntry[] = [
      user("u1", "fix the bug"),
      assistant("a1", "Fixed in foo.ts", [{ kind: "tool", name: "Edit", summary: "foo.ts" }]),
      user("u2", `${HANDOFF_SENTINEL} please summarise`),
      assistant("a2", "## Summary\nAll done."),
    ];
    const md = recentTurnsMarkdown(entries, "claude");
    expect(md).toBe("**operator:**\nfix the bug\n\n**claude:**\nFixed in foo.ts\n· Edit: foo.ts");
    // Without a quoted latest turn the summary is part of the record.
    expect(recentTurnsMarkdown(entries, "claude", 12, false)).toContain("All done.");
  });
  test("keeps only the newest N and renders a plan as a checklist", () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 20; i++) entries.push(user(`u${String(i)}`, `q${String(i)}`));
    entries.push({
      uuid: "a",
      ts: "",
      role: "assistant",
      parts: [{ kind: "todo", items: [{ text: "write", status: "completed" }, { text: "test", status: "pending" }] }],
    });
    const md = recentTurnsMarkdown(entries, "claude", 3, false);
    expect(md).not.toContain("q16");
    expect(md).toContain("q19");
    expect(md).toContain("· [x] write\n· [ ] test");
  });
});

describe("buildHandoffDocument", () => {
  test("names both agents, the directory, the instruction, the summary and the artifacts", () => {
    const entries: TranscriptEntry[] = [user("u1", "start"), assistant("a1", "Halfway: the parser is done, the tests are not.")];
    const doc = buildHandoffDocument(facts, entries);
    expect(doc.startsWith("# Handoff — claude → codex\n")).toBe(true);
    expect(doc).toContain("**claude** in **ai-live** (`/home/op/ai-live`), pane w4:p2");
    expect(doc).toContain("- Written: 2026-09-11T09:30:00.000Z");
    expect(doc).toContain("## What to do next\n\nFinish the tests, then run the linter.");
    expect(doc).toContain("## Where claude left off, in its own words\n\nHalfway: the parser is done, the tests are not.");
    expect(doc).toContain("- Plan — `/state/artifacts/ab-00000001.html` (artifact ab-00000001)");
    expect(doc).toContain("## Recent turns, oldest first\n\n**operator:**\nstart");
  });
  test("says what is missing instead of leaving a heading empty", () => {
    const doc = buildHandoffDocument({ ...facts, instruction: "  ", artifacts: [] }, []);
    expect(doc).toContain("_No instruction was given. Continue where the previous agent stopped._");
    expect(doc).toContain("_The previous agent left no summary; the recent turns below are all there is._");
    expect(doc).toContain("## Artifacts this pane made\n\n_None._");
    expect(doc).toContain("## Recent turns, oldest first\n\n_Nothing on record._");
  });
  test("clamps a runaway summary and says how much was cut", () => {
    const long = "x".repeat(HANDOFF_LATEST_CHARS + 50);
    const doc = buildHandoffDocument(facts, [assistant("a1", long)]);
    expect(doc).toContain("[… 50 more characters]");
  });
});
