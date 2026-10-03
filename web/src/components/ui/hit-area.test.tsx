import { render } from "@testing-library/react";

import { HitArea, TAP_FLOOR_PX, hitInsets } from "./hit-area";

// The primitive's arithmetic. Whether a reach actually REACHES — nothing paints over it, no
// neighbour shares it, the face keeps its size — is a layout question jsdom cannot answer; that is
// measured in a browser by e2e/hit-areas.spec.ts. What is pinned here is the part a refactor could
// quietly get wrong: the border compensation and the sign of each inset.

describe("hitInsets", () => {
  it("turns a reach past the drawn edge into a negative inset on that side", () => {
    expect(hitInsets({ top: 2, right: 16, bottom: 14, left: 2 })).toEqual({ top: -2, right: -16, bottom: -14, left: -2 });
  });

  it("adds the border, because an absolute box is placed against the padding box, a border inside the edge", () => {
    expect(hitInsets({ top: 6, bottom: 6, left: 4, right: 8, border: 1 })).toEqual({
      top: -7,
      right: -9,
      bottom: -7,
      left: -5,
    });
  });

  it("reaches nowhere on a side it was told nothing about", () => {
    expect(hitInsets({ bottom: 14 })).toEqual({ top: 0, right: 0, bottom: -14, left: 0 });
  });

  // The reaches the fork's call sites state, against the drawn sizes they sit on: each lifts its face
  // to the floor on the axes it claims. (The tab row's radios meet it across by splitting the pair's
  // outer room — view-toggle.tsx — which only a browser can see; the spec measures it.)
  it.each([
    ["a 32px toolbar button, 6px up and down", 32, 6, 6],
    ["a 28px tab-row control, from the row's top to the 44px line", 28, 2, 14],
  ])("%s reaches the floor", (_why, drawn, near, far) => {
    expect(drawn + near + far).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  });
});

describe("HitArea", () => {
  it("is an inert, unannounced box placed by its insets", () => {
    const { container } = render(
      <button type="button" className="relative">
        <HitArea top={6} bottom={6} left={4} right={8} border={1} />
        go
      </button>,
    );
    const area = container.querySelector<HTMLElement>('[data-slot="hit-area"]');
    expect(area).not.toBeNull();
    expect(area).toHaveAttribute("aria-hidden", "true");
    expect(area).toHaveTextContent("");
    const style = area?.style;
    expect([style?.top, style?.right, style?.bottom, style?.left]).toEqual(["-7px", "-9px", "-7px", "-5px"]);
  });

  it("is lifted over later positioned content only when asked", () => {
    const { container, rerender } = render(<HitArea top={2} />);
    expect(container.firstElementChild).not.toHaveClass("z-[1]");
    rerender(<HitArea top={2} raised />);
    expect(container.firstElementChild).toHaveClass("z-[1]");
  });
});
