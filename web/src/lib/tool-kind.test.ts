import { toolKind, toolStatus } from "./tool-kind";
import type { TranscriptPart } from "./types";

// The ACP vocabulary. What is pinned here is the ORDER of the substring rules — they overlap on
// purpose, and every pair below is one that got the wrong icon before the order was fixed.

describe("toolKind — the harness vocabularies we have actually read out of logs", () => {
  it("maps Claude Code's set", () => {
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("Edit")).toBe("edit");
    expect(toolKind("Write")).toBe("edit");
    expect(toolKind("Bash")).toBe("execute");
    expect(toolKind("Grep")).toBe("search");
    expect(toolKind("Glob")).toBe("search");
    expect(toolKind("WebFetch")).toBe("fetch");
    expect(toolKind("TodoWrite")).toBe("think");
    expect(toolKind("Task")).toBe("think");
  });

  it("maps Codex's set", () => {
    expect(toolKind("shell")).toBe("execute");
    expect(toolKind("apply_patch")).toBe("edit");
    expect(toolKind("update_plan")).toBe("think");
    expect(toolKind("view_image")).toBe("read");
  });

  it("is case-insensitive, because two harnesses spell the same verb differently", () => {
    expect(toolKind("READ")).toBe("read");
    expect(toolKind("bash")).toBe("execute");
  });
});

describe("toolKind — the substring fallback, whose ORDER is the correctness story", () => {
  it("a delete is not an edit", () => {
    expect(toolKind("delete_file")).toBe("delete");
    expect(toolKind("remove_directory")).toBe("delete");
  });

  it("a rename is not an edit", () => {
    expect(toolKind("rename_symbol")).toBe("move");
    expect(toolKind("move_file")).toBe("move");
  });

  it("a search that reads files is a search", () => {
    expect(toolKind("search_files")).toBe("search");
    expect(toolKind("find_references")).toBe("search");
  });

  it("an unheard-of tool is honestly `other`, never a guessed kind", () => {
    expect(toolKind("kubectl_apply_manifest")).toBe("edit"); // "apply" really is an edit verb
    expect(toolKind("xyzzy")).toBe("other");
    expect(toolKind("")).toBe("other");
  });

  it("an MCP tool is judged by its TOOL half — the server name is somebody's brand", () => {
    expect(toolKind("mcp__github__search_issues")).toBe("search");
    expect(toolKind("mcp__notionApi__API-retrieve-a-page")).toBe("read");
  });

  it("a prototype key arriving as a tool name resolves to a kind, not to a function", () => {
    expect(toolKind("toString")).toBe("other");
    expect(toolKind("constructor")).toBe("other");
    expect(toolKind("__proto__")).toBe("other");
  });
});

describe("toolStatus", () => {
  const call = (result?: { text: string; isError?: boolean }): Extract<TranscriptPart, { kind: "tool" }> =>
    result === undefined
      ? { kind: "tool", name: "Bash", summary: "ls" }
      : { kind: "tool", name: "Bash", summary: "ls", result };

  it("an answered call is completed", () => {
    expect(toolStatus(call({ text: "ok" }), false)).toBe("completed");
    expect(toolStatus(call({ text: "ok" }), true)).toBe("completed");
  });

  it("an errored call is failed, whatever the pane is doing", () => {
    expect(toolStatus(call({ text: "boom", isError: true }), false)).toBe("failed");
  });

  // The one derivation: a journal row says what happened, never what is happening, so the pane's own
  // state is what tells a call awaiting its answer from one that never got one.
  it("an unanswered call is in_progress only while the pane is working", () => {
    expect(toolStatus(call(), true)).toBe("in_progress");
    expect(toolStatus(call(), false)).toBe("pending");
  });
});
