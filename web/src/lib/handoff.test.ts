import { describe, expect, it } from "vitest";

import {
  HANDOFF_SENTINEL,
  HANDOFF_SUMMARY_PROMPT,
  SUMMARY_WAIT_START,
  handoffHarnessOf,
  handoffTargets,
  summaryStep,
} from "./handoff";
import type { Launcher } from "./types";

// FORK — the phone's half of a handoff (lib/handoff.ts): which rows may take one, the ask that
// opens with the bridge's sentinel, and the one rule the sheet waits on.

const rows: Launcher[] = [
  { command: "claude", label: "claude" },
  { command: "codex --profile fast", label: "codex" },
  { command: "/opt/bin/agy", label: "agy" },
  { command: "rumen-peek", label: "Runs & quota" },
];

describe("handoffHarnessOf / handoffTargets", () => {
  it("reads the harness off the first token and offers every other harness", () => {
    expect(handoffHarnessOf("codex --profile fast")).toBe("codex");
    expect(handoffHarnessOf("rumen-peek")).toBeNull();
    expect(handoffTargets(rows, "claude").map((r) => r.label)).toEqual(["codex", "agy"]);
    expect(handoffTargets(rows, "codex").map((r) => r.label)).toEqual(["claude", "agy"]);
    // A shell has no harness to exclude; a row that starts none is never offered.
    expect(handoffTargets(rows, "shell").map((r) => r.label)).toEqual(["claude", "codex", "agy"]);
  });
});

describe("the summary ask", () => {
  it("opens with the sentinel the bridge strips from the document", () => {
    expect(HANDOFF_SUMMARY_PROMPT.startsWith(`${HANDOFF_SENTINEL} `)).toBe(true);
    expect(HANDOFF_SENTINEL).toBe("[collie handoff]");
    // One line: it is typed into a composer and submitted with Enter.
    expect(HANDOFF_SUMMARY_PROMPT).not.toContain("\n");
  });
});

describe("summaryStep — settled once seen working and not any more", () => {
  it("does not settle before the pane has been seen working", () => {
    expect(summaryStep(SUMMARY_WAIT_START, "done")).toEqual({ next: SUMMARY_WAIT_START, settled: false });
    expect(summaryStep(SUMMARY_WAIT_START, undefined)).toEqual({ next: SUMMARY_WAIT_START, settled: false });
  });
  it("remembers working, then settles on any other status", () => {
    const working = summaryStep(SUMMARY_WAIT_START, "working");
    expect(working).toEqual({ next: { sawWorking: true }, settled: false });
    expect(summaryStep(working.next, "working").settled).toBe(false);
    expect(summaryStep(working.next, "done").settled).toBe(true);
    expect(summaryStep(working.next, "blocked").settled).toBe(true);
    expect(summaryStep(working.next, "idle").settled).toBe(true);
  });
});
