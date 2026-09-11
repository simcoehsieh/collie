import { describe, expect, it } from "vitest";

import {
  ARROW,
  DOWNSCALE_LADDER,
  EMPTY_MARKUP,
  addMark,
  addMarks,
  arrowHead,
  canRedo,
  canUndo,
  clearMarkup,
  dataUrlBytes,
  dataUrlMime,
  dataUrlToFile,
  extensionForMime,
  fitToBudget,
  haloFor,
  redoMarkup,
  scaleMark,
  undoMarkup,
  type Mark,
} from "./markup";

const pen = (n = 1): Mark => ({ kind: "pen", color: "#ef4444", width: 4, points: [{ x: n, y: n }] });

describe("the undo stack", () => {
  it("commits, undoes and redoes", () => {
    const one = addMark(EMPTY_MARKUP, pen(1));
    const two = addMark(one, pen(2));
    expect(two.marks).toHaveLength(2);
    expect(canUndo(two)).toBe(true);
    const back = undoMarkup(two);
    expect(back.marks).toHaveLength(1);
    expect(canRedo(back)).toBe(true);
    expect(redoMarkup(back).marks).toHaveLength(2);
  });

  it("a new stroke drops redo, the way every editor does", () => {
    const undone = undoMarkup(addMark(addMark(EMPTY_MARKUP, pen(1)), pen(2)));
    expect(canRedo(undone)).toBe(true);
    expect(canRedo(addMark(undone, pen(3)))).toBe(false);
  });

  it("clear is undoable — a mis-tap must not cost the drawing", () => {
    const drawn = addMark(EMPTY_MARKUP, pen(1));
    const cleared = clearMarkup(drawn);
    expect(cleared.marks).toHaveLength(0);
    expect(undoMarkup(cleared).marks).toEqual(drawn.marks);
    // Clearing an empty drawing is not a step; otherwise undo would have nothing to say.
    expect(clearMarkup(EMPTY_MARKUP)).toBe(EMPTY_MARKUP);
  });

  it("a pin's box and its number are ONE step", () => {
    // The pin is two marks and undoing a mis-tap has to take both: a half-pin left on the picture
    // is worse than either half.
    const pinned = addMarks(EMPTY_MARKUP, [pen(1), pen(2)]);
    expect(pinned.marks).toHaveLength(2);
    expect(undoMarkup(pinned).marks).toHaveLength(0);
    expect(addMarks(EMPTY_MARKUP, [])).toBe(EMPTY_MARKUP);
  });

  it("nothing to undo or redo is a no-op, not a throw", () => {
    expect(undoMarkup(EMPTY_MARKUP)).toBe(EMPTY_MARKUP);
    expect(redoMarkup(EMPTY_MARKUP)).toBe(EMPTY_MARKUP);
  });
});

describe("geometry", () => {
  it("scales every coordinate and the stroke by the SAME factor", () => {
    const scaled = scaleMark({ kind: "rect", color: "#fff", width: 4, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }, 0.5);
    expect(scaled.width).toBe(2);
    expect(scaled.points).toEqual([{ x: 5, y: 10 }, { x: 15, y: 20 }]);
  });

  it("the arrowhead grows with the stroke and has a floor", () => {
    // Horizontal arrow: both wings sit one head-length back, symmetric about the shaft.
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
    expect(100 - a.x).toBeCloseTo(ARROW.minHead * Math.cos(ARROW.halfAngle), 5);
    expect(a.y).toBeCloseTo(-b.y, 5);
    // A thick stroke gets a proportionally bigger head rather than the floor.
    const [thick] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(100 - thick.x).toBeCloseTo(10 * ARROW.headFactor * Math.cos(ARROW.halfAngle), 5);
  });

  it("the text halo is the opposite of the text", () => {
    expect(haloFor("#ffffff")).toContain("0,0,0");
    expect(haloFor("#fff")).toContain("0,0,0");
    expect(haloFor("#111111")).toContain("255,255,255");
    // Not a colour this understands: the dark halo, which is the safer default on a screenshot.
    expect(haloFor("rebeccapurple")).toContain("0,0,0");
  });
});

describe("the size estimate", () => {
  it("reads the byte count off the base64 length, without decoding", () => {
    // "AQID" is three bytes; the padding cases are the two that a naive length/4*3 gets wrong.
    expect(dataUrlBytes("data:image/webp;base64,AQID")).toBe(3);
    expect(dataUrlBytes("data:image/webp;base64,AQI=")).toBe(2);
    expect(dataUrlBytes("data:image/webp;base64,AQ==")).toBe(1);
    expect(dataUrlBytes("not a data url")).toBe(0);
  });

  it("reads the type, which is how a browser that refused WebP is noticed", () => {
    expect(dataUrlMime("data:image/webp;base64,AQID")).toBe("image/webp");
    expect(dataUrlMime("data:image/png;base64,AQID")).toBe("image/png");
    expect(dataUrlMime("")).toBe("");
  });
});

describe("the downscale ladder", () => {
  // Each rung is one real encode on a phone, so the ladder is short and the order is the contract.
  const payload = (bytes: number) => `data:image/webp;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;

  it("stops at the FIRST rung that fits, and tries them in order", async () => {
    const tried: number[] = [];
    const got = await fitToBudget(async (scale) => {
      tried.push(scale);
      // Encoded size falls roughly with the area, which is the scale squared.
      return payload(Math.round(1_000_000 * scale * scale));
    }, 500_000);
    expect(tried).toEqual([1, 0.85, 0.7]);
    expect(got.scale).toBe(0.7);
    expect(got.bytes).toBeLessThanOrEqual(500_000);
  });

  it("a picture already under the budget is never downscaled", async () => {
    const tried: number[] = [];
    const got = await fitToBudget(async (scale) => {
      tried.push(scale);
      return payload(1000);
    }, 10_000);
    expect(tried).toEqual([1]);
    expect(got.scale).toBe(1);
  });

  it("when no rung fits, the smallest is handed back anyway", async () => {
    // The caller knows the host's cap and refuses it with a sentence — which is a better outcome
    // than this returning nothing and the operator losing the drawing.
    const got = await fitToBudget(async () => payload(9_000_000), 1000);
    expect(got.scale).toBe(DOWNSCALE_LADDER.at(-1));
    expect(got.bytes).toBeGreaterThan(1000);
  });

  it("the ladder is Orca's, in Orca's order", () => {
    expect([...DOWNSCALE_LADDER]).toEqual([1, 0.85, 0.7, 0.55, 0.4, 0.3]);
  });
});

describe("handing the result to the upload chain", () => {
  it("a data URL becomes a File the existing uploader takes", () => {
    const file = dataUrlToFile("data:image/webp;base64,AQID", "shot.webp");
    expect(file).not.toBeNull();
    expect(file!.type).toBe("image/webp");
    expect(file!.size).toBe(3);
    expect(file!.name).toBe("shot.webp");
  });

  it("junk is null rather than a File of garbage", () => {
    expect(dataUrlToFile("not a data url", "x.webp")).toBeNull();
    expect(dataUrlToFile("data:image/webp;base64,!!!!", "x.webp")).toBeNull();
  });

  it("the extension agrees with the type, so the bridge's byte sniff and the name match", () => {
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/png")).toBe("png");
  });
});
