import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { collieMark, markIsLive, markPaper } from "@/test/collie-mark";

import { MeowMark } from "./meow-mark";

// FORK. <MeowMark/> stands in for <CollieMark/> and keeps the three things every host's test reads
// off the DOM (src/test/collie-mark.ts): the one `svg:has(> style)`, the `cm-live` class while
// loading, and the `--cm-paper` / `--cm-a1` custom properties. These cases pin that contract, not
// the drawing.
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

  it("names every animation with the cm- prefix the home button's round ramps by", () => {
    // collie-home.tsx collects `getAnimations({subtree:true})` and keeps only names starting with
    // `cm-`; an animation named otherwise would be invisible to the round and the spin a no-op.
    const { container } = render(<MeowMark loading />);
    const css = collieMark(container)?.querySelector("style")?.textContent ?? "";
    const names = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.startsWith("cm-")).toBe(true);
    // …and every one of them is switched on by `cm-live` only.
    const animated = [...css.matchAll(/animation:\s*([\w-]+)/g)]
      .map((m) => m[1])
      .filter((name) => name !== "none"); // the reduced-motion rule switches them off by name
    expect(new Set(animated)).toEqual(new Set(names));
    expect(css).not.toMatch(/(^|\})\.mm-[\w-]+\{[^}]*animation:/);
  });
});
