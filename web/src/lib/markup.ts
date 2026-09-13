// FORK: the drawing model behind the annotate sheet — marks, the undo stack, and the routine that
// flattens them onto a screenshot small enough to upload.
//
// It is a MODULE and not part of the component for the usual reason: the component owns a canvas,
// which jsdom does not have, and the decisions worth pinning — what an arrowhead's geometry is,
// which scale a picture has to come down to before it fits — are arithmetic. Everything here that
// touches a canvas takes one as an argument; everything that decides takes numbers.
//
// The mark kinds, the highlighter's alpha, the arrowhead's angle, the text halo and the downscale
// ladder are Orca's (research notes §A.5), ported rather than re-invented: they are the result of
// someone having already drawn on a lot of screenshots, and there is nothing to improve by guessing
// differently. What is NOT ported is the clipboard — Orca copies the flattened image and the human
// pastes it. Here it goes into the existing upload chain and seeds a draft, because a phone has no
// ⌘V worth speaking of.

/** The six tools. `pen` and `highlight` carry a path; the rest carry two points. */
export type MarkKind = "pen" | "highlight" | "arrow" | "rect" | "ellipse" | "text";

export interface Point {
  x: number;
  y: number;
}

export interface Mark {
  kind: MarkKind;
  color: string;
  /** Stroke width in CSS pixels at scale 1. The highlighter multiplies this — see {@link HIGHLIGHT}. */
  width: number;
  /** `pen`/`highlight`: every sampled point. Everything else: exactly [start, end]. */
  points: Point[];
  /** `text` only. */
  text?: string;
}

/** The highlighter: translucent and fat, so it reads as a marker rather than a coloured pen. */
export const HIGHLIGHT = { alpha: 0.35, widthFactor: 4 } as const;

/** The arrowhead's half-angle, in radians, and how its length follows the stroke width. */
export const ARROW = { halfAngle: 0.45, headFactor: 3.5, minHead: 10 } as const;

/** The scales tried, in order, until the encoded picture fits the budget. */
export const DOWNSCALE_LADDER: readonly number[] = [1, 0.85, 0.7, 0.55, 0.4, 0.3];

// ── The undo stack ────────────────────────────────────────────────────────────────────────────
//
// `{ marks, past, future }`, and every mutation is a new object: React state, so the component
// re-renders on identity. `past` holds whole mark lists rather than a diff — a markup session is
// a dozen strokes, and a list of lists of a dozen items is not a memory question.

export interface Markup {
  marks: readonly Mark[];
  past: readonly (readonly Mark[])[];
  future: readonly (readonly Mark[])[];
}

export const EMPTY_MARKUP: Markup = { marks: [], past: [], future: [] };

/** Commit a mark. Redo is dropped, which is what every editor does on a new edit. */
export function addMark(markup: Markup, mark: Mark): Markup {
  return { marks: [...markup.marks, mark], past: [...markup.past, markup.marks], future: [] };
}

/**
 * Commit several marks as ONE undoable step.
 *
 * The element pin needs it: a pin is a box around what was tapped plus its number, and undoing a
 * mis-tap has to take both away — a half-pin left on the picture is worse than either half.
 */
export function addMarks(markup: Markup, marks: readonly Mark[]): Markup {
  if (marks.length === 0) return markup;
  return { marks: [...markup.marks, ...marks], past: [...markup.past, markup.marks], future: [] };
}

export function undoMarkup(markup: Markup): Markup {
  const previous = markup.past.at(-1);
  if (previous === undefined) return markup;
  return { marks: previous, past: markup.past.slice(0, -1), future: [markup.marks, ...markup.future] };
}

export function redoMarkup(markup: Markup): Markup {
  const next = markup.future[0];
  if (next === undefined) return markup;
  return { marks: next, past: [...markup.past, markup.marks], future: markup.future.slice(1) };
}

/** Clear is an UNDOABLE step, not a reset: a mis-tapped clear must not cost the whole drawing. */
export function clearMarkup(markup: Markup): Markup {
  if (markup.marks.length === 0) return markup;
  return { marks: [], past: [...markup.past, markup.marks], future: [] };
}

export const canUndo = (markup: Markup): boolean => markup.past.length > 0;
export const canRedo = (markup: Markup): boolean => markup.future.length > 0;

// ── Geometry ──────────────────────────────────────────────────────────────────────────────────

/** Every coordinate and the stroke width multiplied by `factor`. Pure — the downscale's whole job. */
export function scaleMark(mark: Mark, factor: number): Mark {
  return {
    ...mark,
    width: mark.width * factor,
    points: mark.points.map((p) => ({ x: p.x * factor, y: p.y * factor })),
  };
}

/**
 * The two wing points of an arrowhead at `to`, coming from `from`.
 *
 * The head grows with the stroke so a thick arrow does not end in a pinprick, and it has a floor so
 * a hairline arrow still ends in something you can see on a phone.
 */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(ARROW.minHead, width * ARROW.headFactor);
  const wing = (sign: number): Point => ({
    x: to.x - head * Math.cos(angle + sign * ARROW.halfAngle),
    y: to.y - head * Math.sin(angle + sign * ARROW.halfAngle),
  });
  return [wing(1), wing(-1)];
}

/**
 * Black or white, whichever a halo behind this text has to be to stay legible.
 *
 * The text tool draws the stroke first and the fill on top, so light text gets a dark outline and
 * dark text a light one — which is what makes a caption survive landing on a photograph.
 */
export function haloFor(color: string): string {
  const hex = color.trim().replace("#", "");
  if (!/^[0-9a-f]{3,8}$/i.test(hex)) return "rgba(0,0,0,0.85)";
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Rec. 601 luma: the cheap perceptual brightness, and the one every contrast helper uses.
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)";
}

// ── Size, without re-encoding ─────────────────────────────────────────────────────────────────

/**
 * How many bytes a `data:` URL's payload actually is — computed from the base64 length rather than
 * by decoding it.
 *
 * This is the whole reason the downscale ladder is cheap: the alternative is `toBlob` at every rung
 * and a decode of each, on a phone, between the operator's tap and the picture appearing.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** The MIME a `data:` URL claims — how a browser that refused WebP is noticed. */
export function dataUrlMime(dataUrl: string): string {
  const match = /^data:([^;,]+)/u.exec(dataUrl);
  return match?.[1] ?? "";
}

/**
 * The first rung of {@link DOWNSCALE_LADDER} whose render fits `maxBytes`, or the smallest rung if
 * none of them do.
 *
 * `render` is a seam, which is what lets this be tested without a canvas — and it is also honest
 * about the cost: each rung is one real encode, and the ladder is short for that reason.
 */
export async function fitToBudget(
  render: (scale: number) => Promise<string>,
  maxBytes: number,
): Promise<{ dataUrl: string; scale: number; bytes: number }> {
  let last = { dataUrl: "", scale: 1, bytes: 0 };
  for (const scale of DOWNSCALE_LADDER) {
    const dataUrl = await render(scale);
    const bytes = dataUrlBytes(dataUrl);
    last = { dataUrl, scale, bytes };
    if (bytes <= maxBytes) return last;
  }
  // Every rung was too big. The smallest one is returned anyway: the caller (the composer) already
  // knows the host's cap and will refuse it with a sentence, which is better than this silently
  // handing back nothing.
  return last;
}

// ── Painting ──────────────────────────────────────────────────────────────────────────────────

/** Stroke one mark onto a context already scaled to the output size. */
export function paintMark(ctx: CanvasRenderingContext2D, mark: Mark): void {
  const [a, b] = [mark.points[0], mark.points.at(-1)];
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  ctx.lineWidth = mark.width;
  if (mark.kind === "highlight") {
    ctx.globalAlpha = HIGHLIGHT.alpha;
    ctx.lineWidth = mark.width * HIGHLIGHT.widthFactor;
  }
  switch (mark.kind) {
    case "pen":
    case "highlight": {
      if (mark.points.length === 0) break;
      ctx.beginPath();
      ctx.moveTo(mark.points[0]!.x, mark.points[0]!.y);
      for (const p of mark.points.slice(1)) ctx.lineTo(p.x, p.y);
      // A single tap is a dot, not nothing: without this a careful stab at a 4px icon draws no mark.
      if (mark.points.length === 1) ctx.lineTo(mark.points[0]!.x + 0.01, mark.points[0]!.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      if (!a || !b) break;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const [w1, w2] = arrowHead(a, b, mark.width);
      ctx.beginPath();
      ctx.moveTo(w1.x, w1.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(w2.x, w2.y);
      ctx.stroke();
      break;
    }
    case "rect": {
      if (!a || !b) break;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      break;
    }
    case "ellipse": {
      if (!a || !b) break;
      ctx.beginPath();
      ctx.ellipse(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2,
        Math.abs(b.y - a.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "text": {
      if (!a || !mark.text) break;
      const size = Math.max(12, mark.width * 6);
      ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "top";
      // Halo first, fill second — see haloFor.
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.strokeStyle = haloFor(mark.color);
      ctx.strokeText(mark.text, a.x, a.y);
      ctx.fillText(mark.text, a.x, a.y);
      break;
    }
  }
  ctx.restore();
}

export interface ComposeOptions {
  /** The screenshot, already decoded. */
  base: CanvasImageSource;
  /** Its natural size in CSS pixels — the coordinate space every mark is in. */
  width: number;
  height: number;
  marks: readonly Mark[];
  /** The host's own upload cap (`/api/config` → `upload.maxBytes`), minus a little headroom. */
  maxBytes: number;
  /** WebP quality. 0.85 is Orca's, and it is the number the phone research measured against. */
  quality?: number;
  /** Injected in tests; the component passes nothing and gets a real one. */
  makeCanvas?: (w: number, h: number) => HTMLCanvasElement;
}

/**
 * The base image with every stroke painted on it, encoded small enough to upload.
 *
 * WEBP, NOT PNG, and that is a phone constraint rather than a preference: a DPR-3 screenshot of a
 * full page encodes to megabytes as PNG and routinely blows the 10 MB default upload cap, while the
 * same picture as WebP at q0.85 lands in the tens to low hundreds of kilobytes. A browser that
 * cannot encode WebP silently answers PNG, which {@link dataUrlMime} notices — JPEG is then the
 * fallback, because a PNG that fails the cap is not a picture the operator can send.
 */
export async function composeMarkup(opts: ComposeOptions): Promise<{ dataUrl: string; mime: string; scale: number; bytes: number }> {
  const quality = opts.quality ?? 0.85;
  const make = opts.makeCanvas ?? ((w: number, h: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  });

  let type = "image/webp";
  const render = async (scale: number): Promise<string> => {
    const canvas = make(Math.max(1, Math.round(opts.width * scale)), Math.max(1, Math.round(opts.height * scale)));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return "";
    ctx.drawImage(opts.base, 0, 0, canvas.width, canvas.height);
    // Every mark's geometry scaled by the SAME factor the image was — which is what keeps a circle
    // around a button a circle around that button at every rung of the ladder.
    for (const mark of opts.marks) paintMark(ctx, scaleMark(mark, scale));
    const dataUrl = canvas.toDataURL(type, quality);
    if (type === "image/webp" && dataUrlMime(dataUrl) !== "image/webp") {
      // This browser refused WebP and handed back PNG. Ask for JPEG from here on rather than
      // shipping a PNG that will not fit.
      type = "image/jpeg";
      return canvas.toDataURL(type, quality);
    }
    return dataUrl;
  };

  const fitted = await fitToBudget(render, opts.maxBytes);
  return { ...fitted, mime: dataUrlMime(fitted.dataUrl) };
}

/**
 * A `data:` URL as a `File` the existing upload chain takes.
 *
 * Decoded with `atob` rather than `fetch(dataUrl)`: a fetch of a data URL is a request, and this
 * app's service worker and CSP both have opinions about requests that this does not need to have
 * an argument with.
 */
export function dataUrlToFile(dataUrl: string, name: string): File | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const mime = dataUrlMime(dataUrl);
  let binary: string;
  try {
    binary = atob(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

/** The extension the composed file should carry, so the bridge's sniff and its name agree. */
export function extensionForMime(mime: string): string {
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg") return "jpg";
  return "png";
}

/**
 * FORK: the largest backing store a canvas may take, in device pixels. iOS Safari's ceiling is
 * 16,777,216 (4096²) and a canvas past it is created empty or takes the page down with it; the
 * budget sits under that with room for the marks layer.
 */
export const MAX_CANVAS_PIXELS = 12_000_000;

/**
 * The scale a canvas of `width`×`height` CSS pixels may be backed at: the device pixel ratio, or
 * less when that would pass {@link MAX_CANVAS_PIXELS} — and below 1 for a picture that is over the
 * budget at its own size. Never zero, never above `dpr`.
 */
export function canvasScaleFor(width: number, height: number, dpr: number, budget: number = MAX_CANVAS_PIXELS): number {
  const area = Math.max(1, width) * Math.max(1, height);
  const cap = Math.sqrt(budget / area);
  return Math.max(0.05, Math.min(Math.max(dpr, 0.05), cap));
}

