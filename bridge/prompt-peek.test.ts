import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { peekBinaryPrompt } from "./prompt-peek.ts";
import { verifyExpectedPrompt } from "./prompt-binding.ts";

// The detector is driven by the same fixture corpus the web grammar is verified against
// (web/src/fixtures/panes/*.txt), so the two can only disagree about a screen one of them has seen.

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "..", "web", "src", "fixtures", "panes", `${name}.txt`), "utf8");

describe("peekBinaryPrompt", () => {
  test("a permission prompt is yes/no, and the plain Yes wins over 'don't ask again'", () => {
    const bash = peekBinaryPrompt(fixture("claude--permission-bash"))!;
    expect(bash.yes).toEqual(["1"]);
    expect(bash.no).toEqual(["3"]);
    expect(peekBinaryPrompt(fixture("claude--permission-edit"))).toMatchObject({ yes: ["1"], no: ["3"] });
  });

  test("the region binds the keys to THIS dialog: it verifies against the screen it came from and against nothing else", () => {
    const text = fixture("claude--permission-bash");
    const { region } = peekBinaryPrompt(text)!;
    // The subject above the question rode along (budget permitting), so a same-shaped successor
    // prompt about a different command does not pass as this one.
    expect(region).toContain("mkfifo fixture-fifo");
    expect(region).toContain("Do you want to proceed?");
    expect(region.endsWith("ctrl+e to explain")).toBe(true);
    expect(Buffer.byteLength(region, "utf8")).toBeLessThanOrEqual(1500);
    expect(verifyExpectedPrompt(text, region)).toEqual({ ok: true });
    expect(verifyExpectedPrompt(fixture("claude--permission-edit"), region).ok).toBe(false);
    expect(verifyExpectedPrompt(`${text}\n${"later output\n".repeat(8)}`, region).ok).toBe(false);
  });

  test("a plan approval is yes/no, the manual Yes wins over auto mode, and the digit stands alone", () => {
    expect(peekBinaryPrompt(fixture("claude--plan-approval"))).toMatchObject({ yes: ["2"], no: ["3"] });
  });

  test("a 'select' footer confirms on Enter after the digit", () => {
    const text = ["Continue?", "❯ 1. Yes", "  2. No", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
    expect(peekBinaryPrompt(text)).toMatchObject({ yes: ["1", "Enter"], no: ["2", "Enter"] });
  });

  test("a subject too long for the budget is trimmed from the top, never from the menu", () => {
    const subject = Array.from({ length: 12 }, (_, i) => `line ${i} ${"x".repeat(200)}`).join("\n");
    const text = `${subject}\nProceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel`;
    const { region } = peekBinaryPrompt(text)!;
    expect(Buffer.byteLength(region, "utf8")).toBeLessThanOrEqual(1500);
    expect(region.startsWith("Proceed?") || region.startsWith("line ")).toBe(true);
    expect(region).toContain("1. Yes");
    expect(verifyExpectedPrompt(text, region)).toEqual({ ok: true });
  });

  test("an AskUserQuestion pick is not a yes/no", () => {
    expect(peekBinaryPrompt(fixture("claude--select-menu"))).toBeNull();
  });

  test("an idle or working pane has no menu at all", () => {
    expect(peekBinaryPrompt(fixture("claude--fresh-idle"))).toBeNull();
    expect(peekBinaryPrompt(fixture("claude--done"))).toBeNull();
    expect(peekBinaryPrompt("")).toBeNull();
  });

  test("a menu the agent has scrolled past is not at the tail", () => {
    const scrolled = `${fixture("claude--permission-bash")}\n${"more output\n".repeat(8)}`;
    expect(peekBinaryPrompt(scrolled)).toBeNull();
  });

  test("a body's own numbered list above the menu does not extend it", () => {
    const text = [
      "Plan:",
      "1. Read the file",
      "2. Edit the file",
      "3. Run the tests",
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "",
      "Esc to cancel",
    ].join("\n");
    expect(peekBinaryPrompt(text)).toMatchObject({ yes: ["1"], no: ["2"] });
  });

  test("a menu whose numbering does not start at 1 is not a menu", () => {
    expect(peekBinaryPrompt("2. Yes\n3. No\nEsc")).toBeNull();
  });
});
