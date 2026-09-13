import { describe, expect, it } from "vitest";

import { modelLabel } from "./model-label";

// FORK — one spelling for the model chip (lib/model-label.ts): the harness's id, the vendor prefix
// trimmed, the effort after an interpunct; nothing when the pane carries neither.

describe("modelLabel", () => {
  it("joins the trimmed model id and the effort with the app's interpunct", () => {
    expect(modelLabel({ model: "claude-fable-5-1", effort: "xhigh" })).toBe("fable-5-1 · xhigh");
    expect(modelLabel({ model: "gpt-6-astra", effort: "medium" })).toBe("gpt-6-astra · medium");
  });

  it("shows either half alone, and nothing for a pane with neither", () => {
    expect(modelLabel({ model: "claude-opus-5" })).toBe("opus-5");
    expect(modelLabel({ effort: "max" })).toBe("max");
    expect(modelLabel({})).toBeNull();
    expect(modelLabel({ model: "", effort: "" })).toBeNull();
  });
});
