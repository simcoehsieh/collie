import { awayFacts, endsWithQuestion, factsAreEmpty, isAway, AWAY_THRESHOLD_MS } from "./away";
import type { TranscriptEntry } from "./types";

// The "while you were away" rollup. Everything it says is a COUNT of something already in hand —
// there is no summary here and there must never be one, because a rollup you cannot check is the
// wrong thing to put on the one screen whose job is to be trusted after an absence.

const SEEN = 1_757_000_000_000;
const at = (offsetMs: number) => new Date(SEEN + offsetMs).toISOString();

const assistant = (offsetMs: number, text: string): TranscriptEntry => ({
  uuid: `a${offsetMs}`,
  ts: at(offsetMs),
  role: "assistant",
  parts: [{ kind: "text", text }],
});

const tooling = (offsetMs: number, ...names: string[]): TranscriptEntry => ({
  uuid: `t${offsetMs}`,
  ts: at(offsetMs),
  role: "assistant",
  parts: names.map((name) => ({ kind: "tool" as const, name, summary: "" })),
});

const user = (offsetMs: number, text: string): TranscriptEntry => ({
  uuid: `u${offsetMs}`,
  ts: at(offsetMs),
  role: "user",
  parts: [{ kind: "text", text }],
});

describe("isAway", () => {
  it("an hour is the bar, and a pane never seen is not 'away'", () => {
    expect(isAway(SEEN, SEEN + AWAY_THRESHOLD_MS + 1)).toBe(true);
    expect(isAway(SEEN, SEEN + AWAY_THRESHOLD_MS - 1)).toBe(false);
    expect(isAway(undefined, SEEN)).toBe(false);
    expect(isAway(0, SEEN)).toBe(false);
  });
});

describe("awayFacts", () => {
  it("counts only what happened after the watermark", () => {
    const facts = awayFacts([assistant(-5000, "before"), assistant(5000, "after")], SEEN);
    expect(facts.agentTurns).toBe(1);
  });

  it("separates the agent's turns from yours", () => {
    const facts = awayFacts([assistant(1000, "one"), user(2000, "go on"), assistant(3000, "two")], SEEN);
    expect(facts.agentTurns).toBe(2);
    expect(facts.userTurns).toBe(1);
  });

  it("mixes tool calls by ACP kind, busiest first", () => {
    const facts = awayFacts(
      [tooling(1000, "Read", "Read", "Read"), tooling(2000, "Edit", "Bash"), tooling(3000, "Edit")],
      SEEN,
    );
    expect(facts.toolCalls).toBe(6);
    expect(facts.tools).toEqual([
      { kind: "read", count: 3 },
      { kind: "edit", count: 2 },
      { kind: "execute", count: 1 },
    ]);
  });

  it("orders a tie by kind name, so two renders cannot swap the row", () => {
    const facts = awayFacts([tooling(1000, "Bash", "Read")], SEEN);
    expect(facts.tools.map((t) => t.kind)).toEqual(["execute", "read"]);
  });

  it("finds the NEWEST standing question, not the first", () => {
    const facts = awayFacts(
      [assistant(1000, "Should I rebase?"), assistant(2000, "Or merge?")],
      SEEN,
    );
    expect(facts.lastQuestionAt).toBe(SEEN + 2000);
  });

  it("reports no question when the agent only made statements", () => {
    expect(awayFacts([assistant(1000, "Done.")], SEEN).lastQuestionAt).toBeNull();
  });

  it("counts an unstamped row that sits inside the window", () => {
    const unstamped: TranscriptEntry = { uuid: "x", ts: "", role: "assistant", parts: [{ kind: "text", text: "…" }] };
    const facts = awayFacts([assistant(-5000, "before"), unstamped, assistant(5000, "after")], SEEN);
    expect(facts.agentTurns).toBe(2);
  });

  it("is empty for an empty transcript, which is what stops the card rendering '0 turns'", () => {
    const facts = awayFacts([], SEEN);
    expect(factsAreEmpty(facts)).toBe(true);
    expect(factsAreEmpty(awayFacts([assistant(1000, "hi")], SEEN))).toBe(false);
  });
});

describe("endsWithQuestion", () => {
  it("reads the LAST line, because that is where an agent asks", () => {
    expect(endsWithQuestion(assistant(0, "Is this right?\nHere is the diff."))).toBe(false);
    expect(endsWithQuestion(assistant(0, "Here is the diff.\nIs this right?"))).toBe(true);
  });

  it("accepts a full-width question mark", () => {
    expect(endsWithQuestion(assistant(0, "要我繼續嗎？"))).toBe(true);
  });

  it("a user's question is not the agent asking you something", () => {
    expect(endsWithQuestion(user(0, "can you rebase?"))).toBe(false);
  });

  it("a turn with no prose asks nothing", () => {
    expect(endsWithQuestion(tooling(0, "Bash"))).toBe(false);
  });
});
