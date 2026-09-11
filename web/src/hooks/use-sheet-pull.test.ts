import {
  DOWN_PX,
  FLING_PX_PER_MS,
  isPullDown,
  isPullUp,
  maxPullForAnchor,
  OPEN_PX,
  SLOP,
  shouldOpen,
  UP_PX,
} from "./use-sheet-pull";

// Pure decision table only  -  the touch-tracking half of the hook is exercised through
// agent-chat.test.tsx, which drives the real handle.
describe("shouldOpen", () => {
  it("stays closed on a short, slow pull", () => {
    expect(shouldOpen(40, 0.1)).toBe(false);
  });

  it("opens once the pull reaches OPEN_PX, regardless of speed", () => {
    expect(shouldOpen(OPEN_PX, 0)).toBe(true);
  });

  it("opens on a short pull that is a fast fling", () => {
    expect(shouldOpen(SLOP + 1, FLING_PX_PER_MS)).toBe(true);
  });

  it("never opens on a downward (zero-pull) release", () => {
    expect(shouldOpen(0, 5)).toBe(false);
  });

  it("a fling under SLOP still doesn't open  -  that's noise, not a drag", () => {
    expect(shouldOpen(SLOP, 10)).toBe(false);
  });
});

// The anchor clamp: how far a peek's TOP edge (anchor + pull) may still travel before it would
// overshoot the sheet's own max-height. Given an explicit sheetMax so the test doesn't depend on
// jsdom's innerHeight.
describe("maxPullForAnchor", () => {
  it("gives back the full ceiling when the handle sits at the viewport bottom", () => {
    expect(maxPullForAnchor(0, 600)).toBe(600);
  });

  it("subtracts what the anchor already spent", () => {
    expect(maxPullForAnchor(100, 600)).toBe(500);
  });

  it("never goes negative — an anchor past the ceiling clamps to 0, not a negative pull", () => {
    expect(maxPullForAnchor(900, 600)).toBe(0);
  });
});

// FORK: a downward pull folds the dock (components/agent-chat.tsx). `dy` is positive UP, as in
// the hook, so a downward pull is negative.
describe("isPullDown", () => {
  it("is a fold once the finger has travelled DOWN_PX down", () => {
    expect(isPullDown(-DOWN_PX)).toBe(true);
  });
  it("is not a fold short of it, nor for any upward travel", () => {
    expect(isPullDown(-(DOWN_PX - 1))).toBe(false);
    expect(isPullDown(SLOP + 1)).toBe(false);
    expect(isPullDown(OPEN_PX)).toBe(false);
  });
  it("sits well past the tap slop, so a resting thumb never folds anything", () => {
    expect(DOWN_PX).toBeGreaterThan(SLOP * 4);
  });
});

// FORK: the mirror of the above — an upward pull is how cinema mode is left (components/
// agent-chat.tsx wires `onPullUp` only while it is on, so this threshold never shadows the pane
// switcher on a screen that still wants one).
describe("isPullUp", () => {
  it("is a bring-it-back once the finger has travelled UP_PX up", () => {
    expect(isPullUp(UP_PX)).toBe(true);
  });
  it("is not one short of it, nor for any downward travel", () => {
    expect(isPullUp(UP_PX - 1)).toBe(false);
    expect(isPullUp(-(SLOP + 1))).toBe(false);
    expect(isPullUp(-OPEN_PX)).toBe(false);
  });
  it("is the SAME distance as the fold, so the way back is never harder than the way out", () => {
    expect(UP_PX).toBe(DOWN_PX);
  });
  it("trips well before the sheet would open, which is why wiring it claims the gesture", () => {
    expect(UP_PX).toBeLessThan(OPEN_PX);
  });
});
