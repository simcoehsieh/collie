import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { binaryChoice, promptAtTail } from "./prompt-approve";

// Driven by the same byte-faithful pane captures the Claude grammar is gated on
// (web/src/fixtures/panes/*.txt), so "is this yes/no" is decided over the dialogs production sees.

const PANES_DIR = join(__dirname, "..", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(PANES_DIR, `${name}.txt`), "utf8");

describe("promptAtTail", () => {
  test("lifts the dialog through the pane's own grammar, and nothing for an agent without one", () => {
    expect(promptAtTail(fixture("claude--permission-bash"), "claude")?.family).toBe("permission");
    expect(promptAtTail(fixture("claude--permission-bash"), undefined)).toBeNull();
    expect(promptAtTail(fixture("claude--permission-bash"), "opencode")).toBeNull();
    expect(promptAtTail(fixture("claude--fresh-idle"), "claude")).toBeNull();
  });
});

describe("binaryChoice", () => {
  test("a permission prompt: the plain Yes, not 'don't ask again', and the No", () => {
    const choice = binaryChoice(promptAtTail(fixture("claude--permission-bash"), "claude")!)!;
    expect(choice.yes.label).toBe("Yes");
    expect(choice.no.label).toBe("No");
    // The keystroke plan is the option's own — the same keys the pane view's button sends.
    expect(choice.yes.keys).toEqual(["1"]);
    expect(choice.no.keys).toEqual(["3"]);
  });

  test("a plan approval: the manual Yes over auto mode", () => {
    const choice = binaryChoice(promptAtTail(fixture("claude--plan-approval"), "claude")!)!;
    expect(choice.yes.label).toMatch(/^Yes, manually/);
    expect(choice.no.label).toMatch(/^No/);
  });

  test("a plan approval whose feedback row has focus is not answerable blind", () => {
    const prompt = promptAtTail(fixture("claude--plan-approval--feedback-focused"), "claude")!;
    expect(prompt.feedback?.focused).toBe(true);
    expect(binaryChoice(prompt)).toBeNull();
  });

  test("an AskUserQuestion pick is not yes/no", () => {
    expect(binaryChoice(promptAtTail(fixture("claude--select-menu"), "claude")!)).toBeNull();
  });

  test("a dialog with a Yes but no No, or the reverse, is not yes/no either", () => {
    const base = promptAtTail(fixture("claude--permission-bash"), "claude")!;
    const onlyYes = { ...base, options: base.options.filter((o) => !o.label.startsWith("No")) };
    const onlyNo = { ...base, options: base.options.filter((o) => !o.label.startsWith("Yes")) };
    expect(binaryChoice(onlyYes)).toBeNull();
    expect(binaryChoice(onlyNo)).toBeNull();
  });

  test("with only a sticky Yes on the menu, that Yes is still the Yes", () => {
    const base = promptAtTail(fixture("claude--permission-bash"), "claude")!;
    const sticky = { ...base, options: base.options.filter((o) => o.label !== "Yes") };
    expect(binaryChoice(sticky)?.yes.label).toMatch(/don.t ask again/);
  });
});
