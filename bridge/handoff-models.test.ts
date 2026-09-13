import { describe, expect, test } from "bun:test";
import { parseHandoffModels } from "./handoff-models.ts";

describe("Codex handoff catalog", () => {
  const model = { slug: "codex-test", display_name: "Test model", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high" };
  test("reads supported efforts and default from the host catalog, deduplicated", () => {
    expect(parseHandoffModels({ models: [model, model] })).toEqual([
      { id: "codex-test", label: "Test model", efforts: ["low", "high"], defaultEffort: "high" },
    ]);
  });
  test("rejects hidden, malformed and shell-like ids; unavailable catalog is empty", () => {
    expect(parseHandoffModels({ models: [null, { ...model, visibility: "hide" }, { ...model, slug: "x;touch /tmp/x" }, { ...model, supported_reasoning_levels: [] }] })).toEqual([]);
    expect(parseHandoffModels(null)).toEqual([]);
  });
  test("an invalid default falls back to a supported effort, excluding malformed entries", () => {
    expect(parseHandoffModels({ models: [{ ...model, default_reasoning_level: "ultra", supported_reasoning_levels: [{ effort: "high" }, { effort: "high" }, { effort: "$(oops)" }, null] }] })[0]?.defaultEffort).toBe("high");
    expect(parseHandoffModels({ models: [{ ...model, supported_reasoning_levels: [{ effort: "$(oops)" }] }] })).toEqual([]);
  });
});
