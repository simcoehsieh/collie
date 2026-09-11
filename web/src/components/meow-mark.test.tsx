import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { collieMark, markIsLive, markPaper } from "@/test/collie-mark";

import { MeowMark } from "./meow-mark";

// FORK. <MeowMark/> stands in for <CollieMark/> and keeps the three things every host's test reads
// off the DOM (src/test/collie-mark.ts): the one `svg:has(> style)`, the `cm-live` class while
// loading, and the `--cm-paper` / `--cm-a1` custom properties. These cases pin that contract, not
// the drawing.
//
// The mark gained three more states than `loading` (idle / blocked / done, C-3), so two of the pins
// below were widened rather than replaced: `cm-live` still means working and ONLY working, and
// "every animation is switched on by `cm-live`" became "by a state class" — the invariant that
// matters is that the RESTING drawing runs nothing, and that is still asserted exactly.
describe("MeowMark", () => {
  it("is the one svg with a stylesheet, still at rest, live only while loading", () => {
    const { container, rerender } = render(<MeowMark />);
    expect(collieMark(container)).not.toBeNull();
    expect(markIsLive(container)).toBe(false);
    rerender(<MeowMark loading />);
    expect(markIsLive(container)).toBe(true);
    rerender(<MeowMark />);
    expect(markIsLive(container)).toBe(false);
  });

  it("treats `loading` as an alias of working, and lets it outrank the herd", () => {
    const { container, rerender } = render(<MeowMark state="working" />);
    expect(markIsLive(container)).toBe(true);
    // A connection that is not answering wins over anything the herd has to say.
    rerender(<MeowMark state="blocked" loading />);
    expect(markIsLive(container)).toBe(true);
    expect(collieMark(container)?.classList.contains("cm-blocked")).toBe(false);
  });

  it("wears one state class per state, and none at rest", () => {
    const { container, rerender } = render(<MeowMark state="idle" />);
    expect(collieMark(container)?.getAttribute("class")).toBeNull();
    rerender(<MeowMark state="blocked" />);
    expect(collieMark(container)?.getAttribute("class")).toBe("cm-blocked");
    rerender(<MeowMark state="done" />);
    expect(collieMark(container)?.getAttribute("class")).toBe("cm-done");
  });

  it("colours the cursor per state — the half reduced motion keeps", () => {
    const { container, rerender } = render(<MeowMark state="blocked" />);
    // The MARK half of the palette, not the text half: this is a ~3px filled rect at header size.
    expect(collieMark(container)?.style.getPropertyValue("--cm-a1")).toBe(
      "var(--status-blocked-mark)",
    );
    rerender(<MeowMark state="done" />);
    expect(collieMark(container)?.style.getPropertyValue("--cm-a1")).toBe("currentColor");
  });

  it("paints its knockouts with the paper it was given, and the ground by default", () => {
    const { container, rerender } = render(<MeowMark />);
    expect(markPaper(container)).toBe("var(--background)");
    rerender(<MeowMark paper="var(--card)" />);
    expect(markPaper(container)).toBe("var(--card)");
  });

  it("colours the cursor with the accent while loading — the half reduced motion still gets", () => {
    const { container, rerender } = render(<MeowMark />);
    expect(collieMark(container)?.style.getPropertyValue("--cm-a1")).toBe("currentColor");
    rerender(<MeowMark loading />);
    expect(collieMark(container)?.style.getPropertyValue("--cm-a1")).toBe("var(--primary)");
  });

  it("is decorative without a title and an image with one", () => {
    const { container, rerender } = render(<MeowMark />);
    expect(collieMark(container)?.getAttribute("role")).toBe("presentation");
    rerender(<MeowMark title="Meow" />);
    expect(collieMark(container)?.getAttribute("role")).toBe("img");
    expect(collieMark(container)?.getAttribute("aria-label")).toBe("Meow");
  });

  it("keeps the host's classes beside its own, and sizes to the pixel it was asked for", () => {
    const { container } = render(<MeowMark size={40} loading className="opacity-40 grayscale" />);
    const svg = collieMark(container)!;
    expect(svg.getAttribute("class")).toBe("cm-live opacity-40 grayscale");
    expect(svg.getAttribute("width")).toBe("40");
    expect(svg.getAttribute("height")).toBe("40");
  });

  it("names every animation with the cm- prefix the home button's round ramps by, and starts none at rest", () => {
    // collie-home.tsx collects `getAnimations({subtree:true})` and keeps only names starting with
    // `cm-`; an animation named otherwise would be invisible to the round and the spin a no-op.
    const { container } = render(<MeowMark loading />);
    const css = collieMark(container)?.querySelector("style")?.textContent ?? "";
    const names = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.startsWith("cm-")).toBe(true);
    // …and every one of them is actually used, so a keyframe can never be left behind by the state
    // that drove it.
    const animated = [...css.matchAll(/animation:\s*([\w-]+)/g)]
      .map((m) => m[1])
      .filter((name) => name !== "none"); // the reduced-motion rule switches them off by name
    expect(new Set(animated)).toEqual(new Set(names));
    // …and every `animation` declaration is behind a STATE class. This was spelled `cm-live` when
    // that was the only state; the thing it pins is unchanged — the resting drawing runs nothing —
    // and this is the spelling that survives a fourth state being added. The second assertion is
    // the same rule from the other side: a bare `.mm-*` rule carrying an animation would move the
    // drawing at rest.
    for (const rule of css.split("}").filter((r) => r.includes("animation:"))) {
      if (rule.includes("animation:none")) continue;
      expect(rule).toMatch(/\.cm-(live|blocked|done)\s/);
    }
    expect(css).not.toMatch(/(^|\})\.mm-[\w-]+\{[^}]*animation:/);
  });
});
