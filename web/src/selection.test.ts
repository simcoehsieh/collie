import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Reported twice from the operator's phone: a long-press on the tab strip's "+" started a full-page
// selection. Two rounds of `select-none` — on the button, then on the scroller behind it — were both
// correct and neither helped, because iOS does not give up when the pressed element is unselectable:
// it walks UP for the nearest SELECTABLE ancestor and starts the selection there. The walk stops at
// a selectable ancestor, not at an unselectable one, so the only rule that ends it is a root that is
// itself unselectable.
//
// The rule lives in CSS and jsdom applies no stylesheet, so this reads the source — the same thing
// fonts.test.ts does with the same file, for the same reason. What it pins is the SHAPE the fix
// depends on: the root is unselectable, content is exempted BY NAME, and the whole thing is scoped
// to devices with no mouse.

const CSS = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8");

/** The `@media (hover: none) and (pointer: coarse)` block, whitespace-normalised. */
function touchBlock(): string {
  const start = CSS.indexOf("@media (hover: none) and (pointer: coarse)");
  expect(start, "the touch selection block is gone from index.css").toBeGreaterThan(-1);
  // Brace-matched rather than regexed: the block contains nested rules, and a lazy `[^}]*` would
  // stop at the first inner one and quietly assert against a fragment.
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}" && --depth === 0) return CSS.slice(start, i + 1).replace(/\s+/g, " ");
  }
  throw new Error("unbalanced braces in index.css");
}

describe("touch selection", () => {
  it("makes the ROOT unselectable — an ancestor is what iOS actually walks to", () => {
    // `body`, not the app shell: the sheets portal out to document.body, so a shell-level rule would
    // leave every bottom sheet a selectable ancestor of its own controls.
    expect(touchBlock()).toContain("body { -webkit-user-select: none; user-select: none; }");
  });

  it("exempts CONTENT by name, prefixed for Safari", () => {
    // `pre`/`code` are the terminal mirror, the transcript, the markdown blocks and the updater's log
    // tail — everything an operator copies out of this app. Losing one of these names is how "I can't
    // select the terminal output on my phone" ships without a single test going red.
    const block = touchBlock();
    for (const selector of ["pre", "code", "input", "textarea", "[data-selectable]"]) {
      expect(block).toContain(selector);
    }
    expect(block).toContain("-webkit-user-select: text; user-select: text;");
  });

  it("is scoped to a device with NO MOUSE, and by capability rather than by width", () => {
    // A mouse selects deliberately, so taking selection away on the desktop would cost something
    // real for nothing. And a width guess gets a tablet and a narrow window wrong in both directions.
    expect(CSS).toContain("@media (hover: none) and (pointer: coarse)");
    expect(touchBlock()).not.toMatch(/max-width|min-width/);
  });

  it("does not disable selection outside that block", () => {
    // The one way this fix becomes a desktop regression: a `user-select: none` that escapes the
    // media query. Every occurrence in the file must be inside it.
    const inside = touchBlock();
    const all = [...CSS.matchAll(/user-select:\s*none/g)];
    const within = [...inside.matchAll(/user-select:\s*none/g)];
    expect(all).toHaveLength(within.length);
  });
});
