import { describe, expect, test } from "bun:test";

import { firstProseLine, replyFirstLine, replyLine, REPLY_PEEK_CHARS } from "./reply-peek.ts";
import type { TranscriptEntry } from "./journal/types.ts";

// The grammar half of the `done` push body. What is pinned here is what the operator sees on a lock
// screen: the first line that says SOMETHING, never a fence, a heading marker or a bullet glyph.

const say = (text: string): TranscriptEntry => ({
  uuid: "a",
  ts: "2026-09-11T09:00:00.000Z",
  role: "assistant",
  parts: [{ kind: "text", text }],
});

describe("firstProseLine", () => {
  test("takes the first line that has words in it", () => {
    expect(firstProseLine("All 114 tests pass.\nDetails below.")).toBe("All 114 tests pass.");
  });

  test("skips a fence, a rule and a heading's furniture", () => {
    expect(firstProseLine("```\n---\n## Summary\nThe migration applied cleanly.")).toBe("Summary");
  });

  test("strips a bullet and an ordered marker but keeps the words", () => {
    expect(firstProseLine("- Ran the suite\n- Pushed")).toBe("Ran the suite");
    expect(firstProseLine("1. Ran the suite")).toBe("Ran the suite");
  });

  test("drops emphasis runs rather than shipping asterisks to a lock screen", () => {
    expect(firstProseLine("**Blocked:** the migration needs a password")).toBe(
      "Blocked: the migration needs a password",
    );
  });

  test("collapses wrapped whitespace into one line", () => {
    expect(firstProseLine("  Done   after\ttwo tries")).toBe("Done after two tries");
  });

  test("answers empty for text with nothing to say", () => {
    expect(firstProseLine("")).toBe("");
    expect(firstProseLine("```\n***\n")).toBe("");
  });

  test("keeps a non-Latin line, which the letter test must not exclude", () => {
    expect(firstProseLine("## 完成\n測試全過")).toBe("完成");
  });
});

describe("replyFirstLine", () => {
  test("reads the NEWEST assistant turn, not the first", () => {
    expect(replyFirstLine([say("older"), say("newer")])).toBe("newer");
  });

  test("walks back past a turn that is only tool traffic", () => {
    const toolOnly: TranscriptEntry = {
      uuid: "t",
      ts: "",
      role: "assistant",
      parts: [{ kind: "tool", name: "Bash", summary: "git log" }],
    };
    expect(replyFirstLine([say("the answer"), toolOnly])).toBe("the answer");
  });

  test("ignores thinking — it is not what the agent said to you", () => {
    const thought: TranscriptEntry = {
      uuid: "k",
      ts: "",
      role: "assistant",
      parts: [{ kind: "thinking", text: "hmm, the cache is stale" }],
    };
    expect(replyFirstLine([say("done"), thought])).toBe("done");
  });

  test("ignores a user turn, however recent", () => {
    const asked: TranscriptEntry = {
      uuid: "u",
      ts: "",
      role: "user",
      parts: [{ kind: "text", text: "run the suite" }],
    };
    expect(replyFirstLine([say("on it"), asked])).toBe("on it");
  });

  test("null when there is nothing to say, so the body stays what it was", () => {
    expect(replyFirstLine([])).toBeNull();
    expect(replyFirstLine([say("```\n```")])).toBeNull();
  });

  test("clamps to the lock screen's budget and marks the cut", () => {
    const line = replyFirstLine([say("x".repeat(400))]);
    expect(line).toHaveLength(REPLY_PEEK_CHARS + 1); // the ellipsis
    expect(line?.endsWith("…")).toBe(true);
  });

  test("a line at the budget is not marked", () => {
    const exact = "y".repeat(REPLY_PEEK_CHARS);
    expect(replyFirstLine([say(exact)])).toBe(exact);
  });
});

describe("replyLine — the line and the turn it came from", () => {
  test("names the newest assistant turn's own id beside its line", () => {
    const entries: TranscriptEntry[] = [
      { uuid: "u1", ts: "", role: "user", parts: [{ kind: "text", text: "go" }] },
      { uuid: "a1", ts: "", role: "assistant", parts: [{ kind: "text", text: "First." }] },
      { uuid: "a2", ts: "", role: "assistant", parts: [{ kind: "text", text: "Deployed, all green." }] },
    ];
    expect(replyLine(entries)).toEqual({ text: "Deployed, all green.", turn: "a2" });
    expect(replyFirstLine(entries)).toBe("Deployed, all green.");
    expect(replyLine([entries[0]!])).toBeNull();
  });
});
