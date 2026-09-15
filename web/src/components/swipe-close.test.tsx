import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { REVEAL_PX, SwipeClose } from "./swipe-close";

// FORK: the dashboard row's swipe. The claims worth pinning are the ones a scrolling thumb depends
// on: a vertical drag is the LIST's and never peels a row, the gesture only ever reveals a button,
// and the button itself is the two-tap every other destructive control uses.

const touch = (node: Element, type: string, x: number, y: number) => {
  fireEvent(
    node,
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
      changedTouches: [{ clientX: x, clientY: y }],
    }),
  );
};

function mount(onConfirm = vi.fn(() => Promise.resolve(true))) {
  const view = render(
    <SwipeClose label="Close" confirmLabel="Really close?" closingLabel="Closing…" onConfirm={onConfirm}>
      <button type="button">the row</button>
    </SwipeClose>,
  );
  const surface = view.container.querySelector('[data-slot="swipe-close"]')!.lastElementChild!;
  return { ...view, surface, onConfirm };
}

const offsetOf = (surface: Element) =>
  // SAFETY: `surface` is the wrapper's own last child, an HTMLElement this file just rendered — the
  // cast is to read the inline transform the component writes there.
  Number(/translateX\((-?\d+(?:\.\d+)?)px\)/.exec((surface as HTMLElement).style.transform)?.[1] ?? "0");

describe("SwipeClose", () => {
  it("follows a leftward drag and stays open past half the reveal", () => {
    const { surface } = mount();
    touch(surface, "touchstart", 300, 400);
    touch(surface, "touchmove", 240, 402);
    expect(offsetOf(surface)).toBeLessThan(0);
    touch(surface, "touchend", 240, 402);
    expect(offsetOf(surface)).toBe(-REVEAL_PX);
  });

  it("springs back when the drag stops short", () => {
    const { surface } = mount();
    touch(surface, "touchstart", 300, 400);
    touch(surface, "touchmove", 280, 400);
    touch(surface, "touchend", 280, 400);
    expect(offsetOf(surface)).toBe(0);
  });

  it("leaves a vertical drag to the list, even when it wanders sideways", () => {
    const { surface } = mount();
    touch(surface, "touchstart", 300, 400);
    touch(surface, "touchmove", 296, 340); // the list claims it…
    touch(surface, "touchmove", 200, 330); // …and keeps it
    expect(offsetOf(surface)).toBe(0);
  });

  it("reveals a button that takes two taps, and the first one closes nothing", async () => {
    const { surface, onConfirm } = mount();
    touch(surface, "touchstart", 300, 400);
    touch(surface, "touchmove", 200, 400);
    touch(surface, "touchend", 200, 400);
    const action = screen.getByRole("button", { name: "Close" });
    fireEvent.click(action);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Really close?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Really close?" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("springs shut when the close is refused, so nothing stays armed over a live pane", async () => {
    const { surface } = mount(vi.fn(() => Promise.resolve(false)));
    touch(surface, "touchstart", 300, 400);
    touch(surface, "touchmove", 200, 400);
    touch(surface, "touchend", 200, 400);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Really close?" }));
    await waitFor(() => expect(offsetOf(surface)).toBe(0));
  });

  it("a tap on an open row shuts it instead of reaching the row beneath", async () => {
    const onRow = vi.fn();
    const view = render(
      <SwipeClose label="Close" confirmLabel="Really close?" closingLabel="Closing…" onConfirm={() => Promise.resolve(true)}>
        <button type="button" onClick={onRow}>
          the row
        </button>
      </SwipeClose>,
    );
    const surface = view.container.querySelector('[data-slot="swipe-close"]')!.lastElementChild!;
    touch(surface, "touchstart", 300, 400);
    touch(surface, "touchmove", 200, 400);
    touch(surface, "touchend", 200, 400);
    fireEvent.click(screen.getByRole("button", { name: "the row" }));
    expect(onRow).not.toHaveBeenCalled();
    await waitFor(() => expect(offsetOf(surface)).toBe(0));
  });
});
