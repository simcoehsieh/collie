import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Highlighter,
  Loader2,
  MousePointerClick,
  Pen,
  Redo2,
  Square,
  Type,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { RightSheet } from "@/components/ui/right-sheet";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { buzz } from "@/lib/haptics";
import { t, type MessageKey } from "@/lib/i18n";
import {
  EMPTY_MARKUP,
  addMark,
  addMarks,
  canRedo,
  canUndo,
  clearMarkup,
  composeMarkup,
  dataUrlToFile,
  extensionForMime,
  paintMark,
  redoMarkup,
  undoMarkup,
  type Markup,
  type Point,
  type Mark,
  type MarkKind,
} from "@/lib/markup";
import type { Scope } from "@/lib/scope";
import type { ProbeResponse, ShotResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: annotate-and-ask. Take a picture of a page running on the Mac, draw on it with a finger,
// tap an element to find out what it is, and hand the result to the agent in this pane as an
// attachment plus a seeded draft.
//
// ── WHY THE PICKER RUNS ON THE MAC AND NOT IN THIS BROWSER ──────────────────────────────────────
// Every desktop tool of this mark (Orca's design mode, Replit's, Lovable's) injects a picker into
// an iframe it controls. Meow's browser is a phone it does not control: the page would have to be
// framed with `allow-same-origin`, which is the thing this app has already refused for the document
// panel. So the browser that does the picking is the headless one on the Mac, driven by the
// operator's own command (bridge/shot.ts), and this file only ever paints what came back. Two
// things fall out of that and both are improvements: the shot is rendered at the PHONE's viewport
// (`setDeviceMetricsOverride`, which an iframe on a 390px screen cannot honestly do), and it works
// for pages no CSP would let into a frame at all.
//
// ── WHAT IS NEW HERE AND WHAT IS NOT ────────────────────────────────────────────────────────────
// The drawing is new (`lib/markup.ts`). The SENDING is not: "Attach & ask" flattens the canvas,
// hands the file to `api.uploadFile()` — the existing chain, unchanged — and seeds the pane's draft
// with `saveDraft`. It NEVER sends. A URL is something any app on the phone can open and a draft
// that typed itself into a terminal and pressed Enter would let a stray link drive an agent; the
// same argument `routes/detail.tsx` makes for `?send=`. The operator taps Send.

/** The viewports offered. The phone's own is the default — the answer the operator usually wants. */
const VIEWPORTS = [
  { key: "phone", width: 390, height: 844 },
  { key: "tablet", width: 768, height: 1024 },
  { key: "desktop", width: 1280, height: 800 },
] as const;

type ViewportKey = (typeof VIEWPORTS)[number]["key"];

/** The pens. Four is a phone's worth of choice; a colour wheel is a desktop affordance. */
const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#ffffff", "#111111"] as const;

type Tool = MarkKind | "inspect";

/** One tapped element: its number, where it was tapped, and what came back. */
interface Pin {
  n: number;
  at: Point;
  probe: ProbeResponse;
  note: string;
}

/**
 * The structured hand-off the notes worktree will consume.
 *
 * It is emitted BESIDE the text draft rather than instead of it, and the prop is optional, so this
 * sheet works today with nothing wired to it. When the notes store lands, the integrator points
 * `onElementNote` at it and the anchor becomes a `{kind:"element"}` note; nothing here changes.
 */
export interface ElementNote {
  selector: string;
  url: string;
  note: string;
  /** The uploaded screenshot's host path — the same string the draft quotes. */
  screenshotPath: string;
  probe: ProbeResponse;
}

/** Headroom under the host's cap: multipart adds a boundary and part headers on the way out. */
const UPLOAD_HEADROOM = 96 * 1024;

// ── The canvas ────────────────────────────────────────────────────────────────────────────────

interface MarkupCanvasProps {
  /** The picture being drawn on, already decoded. */
  image: HTMLImageElement | null;
  /** Its natural size — the coordinate space every mark is stored in. */
  width: number;
  height: number;
  markup: Markup;
  onCommit: (mark: Mark) => void;
  tool: Tool;
  color: string;
  strokeWidth: number;
  /** The text the text tool will place. Empty disables it, so a blank caption is impossible. */
  caption: string;
  /** Inspect mode's tap, in image coordinates. */
  onInspect: (at: Point) => void;
  busy: boolean;
  className?: string;
}

/**
 * One canvas, painted at `devicePixelRatio`, driven by Pointer Events.
 *
 * `touch-action: none` and nothing else: this must NOT re-open the long-press selection fight the
 * fork already patched (`userSelect` / `touch-callout` — see FORK.md). A canvas has no text to
 * select and no link to preview, so suppressing the browser's own panning on it costs nothing, and
 * doing it with `touch-action` rather than `preventDefault` on a non-passive listener keeps the
 * suppression scoped to this element instead of to the document.
 */
function MarkupCanvas({
  image,
  width,
  height,
  markup,
  onCommit,
  tool,
  color,
  strokeWidth,
  caption,
  onInspect,
  busy,
  className,
}: MarkupCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<Mark | null>(null);
  const drawing = useRef(false);

  // The pointer's position in the SHOT's coordinate space. Everything — a stroke, a pin, the probe's
  // x/y — is stored there rather than in screen pixels, so the picture can be displayed at any size
  // and the same drawing still lands on the same button.
  const toImage = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return { x: 0, y: 0 };
      return {
        x: ((e.clientX - rect.left) / rect.width) * width,
        y: ((e.clientY - rect.top) / rect.height) * height,
      };
    },
    [width, height],
  );

  // Repaint whenever anything visible changes. One pass, base first, committed marks next, the
  // in-flight stroke last — so the stroke under the finger is always on top of what is finished.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = window.devicePixelRatio || 1;
    // Backed at DPR, displayed at CSS size. Without this a 1px stroke on a DPR-3 phone is drawn
    // into a third of a device pixel and reads as furry rather than sharp.
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (image !== null) ctx.drawImage(image, 0, 0, width, height);
    for (const mark of markup.marks) paintMark(ctx, mark);
    if (draft !== null) paintMark(ctx, draft);
  }, [image, width, height, markup, draft]);

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (busy) return;
    const at = toImage(e);
    if (tool === "inspect") {
      onInspect(at);
      return;
    }
    if (tool === "text") {
      if (caption.trim() === "") return;
      onCommit({ kind: "text", color, width: strokeWidth, points: [at], text: caption.trim() });
      buzz();
      return;
    }
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({ kind: tool, color, width: strokeWidth, points: [at] });
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const at = toImage(e);
    setDraft((prev) => {
      if (prev === null) return prev;
      // A freehand line keeps every sample; a mark only ever has two points, so the second is
      // REPLACED rather than appended — otherwise dragging a rectangle grows an unbounded list.
      const points = prev.kind === "pen" || prev.kind === "highlight"
        ? [...prev.points, at]
        : [prev.points[0]!, at];
      return { ...prev, points };
    });
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    setDraft((prev) => {
      if (prev !== null) onCommit(prev);
      return null;
    });
    buzz();
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="annotate-canvas"
      // See the component's header: this one property, and no listener that fights the document.
      style={{ touchAction: "none", aspectRatio: `${width} / ${height}` }}
      className={cn("w-full rounded-xl border border-rule bg-muted/30", className)}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
    />
  );
}

// ── The toolbar ───────────────────────────────────────────────────────────────────────────────

const TOOLS: { key: Tool; icon: typeof Pen; label: MessageKey }[] = [
  { key: "pen", icon: Pen, label: "annotate.tool.pen" },
  { key: "highlight", icon: Highlighter, label: "annotate.tool.highlight" },
  { key: "arrow", icon: ArrowUpRight, label: "annotate.tool.arrow" },
  { key: "rect", icon: Square, label: "annotate.tool.rect" },
  { key: "ellipse", icon: Circle, label: "annotate.tool.ellipse" },
  { key: "text", icon: Type, label: "annotate.tool.text" },
];

interface ToolbarProps {
  tool: Tool;
  setTool: (tool: Tool) => void;
  color: string;
  setColor: (color: string) => void;
  markup: Markup;
  setMarkup: (next: Markup) => void;
  /** Inspect is only offered where there is something to inspect — never on a composer attachment. */
  offerInspect: boolean;
}

function Toolbar({ tool, setTool, color, setColor, markup, setMarkup, offerInspect }: ToolbarProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {TOOLS.map(({ key, icon: Icon, label }) => (
          <Button
            key={key}
            variant={tool === key ? "default" : "outline"}
            size="icon"
            className="size-9"
            aria-label={t(label)}
            aria-pressed={tool === key}
            onClick={() => setTool(key)}
          >
            <Icon className="size-4" />
          </Button>
        ))}
        {offerInspect && (
          <Button
            variant={tool === "inspect" ? "default" : "outline"}
            size="icon"
            className="size-9"
            aria-label={t("annotate.tool.inspect")}
            aria-pressed={tool === "inspect"}
            onClick={() => setTool("inspect")}
          >
            <MousePointerClick className="size-4" />
          </Button>
        )}
        <span className="mx-1 h-5 w-px bg-rule" />
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          aria-label={t("annotate.undo")}
          disabled={!canUndo(markup)}
          onClick={() => setMarkup(undoMarkup(markup))}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          aria-label={t("annotate.redo")}
          disabled={!canRedo(markup)}
          onClick={() => setMarkup(redoMarkup(markup))}
        >
          <Redo2 className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          aria-label={t("annotate.clear")}
          disabled={markup.marks.length === 0}
          onClick={() => setMarkup(clearMarkup(markup))}
        >
          <Eraser className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-1.5" role="group" aria-label={t("annotate.color.label")}>
        {COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={swatch}
            aria-pressed={color === swatch}
            onClick={() => setColor(swatch)}
            className={cn(
              "size-7 rounded-full border-2",
              color === swatch ? "border-primary" : "border-rule",
            )}
            style={{ backgroundColor: swatch }}
          />
        ))}
      </div>
    </div>
  );
}

// ── The element card ──────────────────────────────────────────────────────────────────────────

function ElementCard({ pin, onNote }: { pin: Pin; onNote: (note: string) => void }) {
  const p = pin.probe;
  return (
    <div className="rounded-xl border border-rule bg-card p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
          {pin.n}
        </span>
        <code className="min-w-0 truncate font-mono text-[11px]">{p.selector}</code>
      </div>
      <dl className="space-y-0.5 text-muted-foreground">
        <div className="flex gap-1.5">
          <dt className="shrink-0">{t("annotate.card.tag")}</dt>
          <dd className="min-w-0 truncate font-mono">{p.tag}</dd>
        </div>
        {p.reactComponents && (
          <div className="flex gap-1.5">
            <dt className="shrink-0">{t("annotate.card.component")}</dt>
            <dd className="min-w-0 truncate font-mono">{p.reactComponents}</dd>
          </div>
        )}
        {p.sourceFile && (
          <div className="flex gap-1.5">
            <dt className="shrink-0">{t("annotate.card.source")}</dt>
            <dd className="min-w-0 truncate font-mono">{p.sourceFile}</dd>
          </div>
        )}
        {p.text && (
          <div className="flex gap-1.5">
            <dt className="shrink-0">{t("annotate.card.text")}</dt>
            <dd className="min-w-0 truncate">{p.text}</dd>
          </div>
        )}
      </dl>
      <ChatInput
        className="mt-2"
        value={pin.note}
        onChange={(e) => onNote(e.target.value)}
        placeholder={t("annotate.note.placeholder")}
        aria-label={t("annotate.note.label")}
        rows={2}
      />
    </div>
  );
}

// ── The sheet ─────────────────────────────────────────────────────────────────────────────────

export interface AnnotateSheetProps {
  open: boolean;
  onClose: () => void;
  paneId: string;
  scope?: Scope;
  /** The URL to shoot. Empty opens the field instead, prefilled by the caller where it can. */
  initialUrl: string;
  /** Told which URL is being annotated, so a host preview surface can follow along. */
  onPreviewUrl?: (url: string) => void;
  /**
   * Seed the pane's composer. NEVER a send — see the file header.
   * The caller (`agent-chat.tsx`) hands this to `saveDraft` and closes the sheet.
   */
  onDraft: (text: string) => void;
  /** The notes worktree's hook. Optional, and nothing here depends on it — see {@link ElementNote}. */
  onElementNote?: (payload: ElementNote) => void;
  /** The host's own upload cap (`/api/config` → `upload.maxBytes`). */
  maxUploadBytes: number;
}

export function AnnotateSheet({
  open,
  onClose,
  paneId,
  scope,
  initialUrl,
  onPreviewUrl,
  onDraft,
  onElementNote,
  maxUploadBytes,
}: AnnotateSheetProps) {
  useLocale();
  const [url, setUrl] = useState(initialUrl);
  const [viewport, setViewport] = useState<ViewportKey>("phone");
  const [shot, setShot] = useState<ShotResponse | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [markup, setMarkup] = useState<Markup>(EMPTY_MARKUP);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [caption, setCaption] = useState("");
  const [pins, setPins] = useState<Pin[]>([]);
  const [busy, setBusy] = useState<null | "shooting" | "probing" | "attaching">(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Opening resets everything but the URL: a sheet that re-opens onto the previous session's
  // drawing is a sheet that attaches the wrong picture to the next question.
  useEffect(() => {
    if (!open) {
      inFlight.current?.abort();
      return;
    }
    setUrl(initialUrl);
    setShot(null);
    setImage(null);
    setMarkup(EMPTY_MARKUP);
    setPins([]);
    setError(null);
    setBusy(null);
  }, [open, initialUrl]);

  const shoot = useCallback(async () => {
    const spec = VIEWPORTS.find((v) => v.key === viewport)!;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy("shooting");
    setError(null);
    try {
      const body = await api.requestShot(
        paneId,
        // DPR 3 because this is a phone: a shot taken at 1× and displayed on a 3× screen is the
        // blur the operator opened this sheet to avoid.
        { url, width: spec.width, height: spec.height, dpr: 3 },
        scope,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const img = new Image();
      img.src = body.image;
      await img.decode().catch(() => undefined);
      if (controller.signal.aborted) return;
      setShot(body);
      setImage(img);
      setMarkup(EMPTY_MARKUP);
      setPins([]);
      onPreviewUrl?.(body.url);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(describeThrownError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }, [paneId, scope, url, viewport, onPreviewUrl]);

  const inspect = useCallback(
    async (at: Point) => {
      if (shot === null || busy !== null) return;
      const controller = new AbortController();
      inFlight.current = controller;
      setBusy("probing");
      setError(null);
      try {
        const probe = await api.requestProbe(
          paneId,
          { url: shot.url, width: shot.width, height: shot.height, dpr: shot.dpr, x: at.x, y: at.y },
          scope,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setPins((prev) => {
          const n = prev.length + 1;
          // The pin goes INTO the drawing rather than beside it, as one undoable step: the box says
          // which element, the number ties it to the card, and both belong in the picture the agent
          // is about to be handed.
          setMarkup((m) =>
            addMarks(m, [
              {
                kind: "rect",
                color,
                width: 3,
                points: [
                  { x: probe.box.x, y: probe.box.y },
                  { x: probe.box.x + probe.box.width, y: probe.box.y + probe.box.height },
                ],
              },
              {
                kind: "text",
                color,
                width: 4,
                points: [{ x: probe.box.x, y: Math.max(0, probe.box.y - 26) }],
                text: String(n),
              },
            ]),
          );
          return [...prev, { n, at, probe, note: "" }];
        });
        buzz();
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(describeThrownError(e));
      } finally {
        if (!controller.signal.aborted) setBusy(null);
      }
    },
    [paneId, scope, shot, busy, color],
  );

  async function attach() {
    if (shot === null || image === null) return;
    setBusy("attaching");
    setError(null);
    try {
      const composed = await composeMarkup({
        base: image,
        width: shot.width,
        height: shot.height,
        marks: markup.marks,
        maxBytes: Math.max(64 * 1024, maxUploadBytes - UPLOAD_HEADROOM),
      });
      const file = dataUrlToFile(composed.dataUrl, `shot.${extensionForMime(composed.mime)}`);
      if (file === null || file.size > maxUploadBytes) {
        setError(t("annotate.error.tooLarge"));
        return;
      }
      const res = await api.uploadFile(paneId, file, scope);
      if (!res.ok) {
        setError(describeApiError(res));
        return;
      }
      // ── THE UPLOAD IS SWEPT AFTER 48 HOURS (bridge/uploads.ts `UPLOAD_TTL_MS`) ─────────────────
      // The path below is the whole reference the agent gets — there is no copy anywhere else — so
      // a draft left unsent for two days quotes a file that is gone. The draft is deliberately not
      // a send (see the file header), which makes that window the one real cost of the choice.
      const pin = pins.at(-1);
      const selector = pin?.probe.selector ?? shot.url;
      const note = pins.map((p) => p.note.trim()).filter((n) => n !== "").join(" ");
      onDraft(`About \`${selector}\` (screenshot: ${res.path}): ${note}`.trimEnd());
      if (pin !== undefined) {
        onElementNote?.({
          selector: pin.probe.selector,
          url: shot.url,
          note: pin.note,
          screenshotPath: res.path,
          probe: pin.probe,
        });
      }
      onClose();
    } catch (e) {
      setError(describeThrownError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <RightSheet open={open} onClose={onClose} title={t("annotate.title")} subtitle={shot?.url ?? url}>
      <div className="flex flex-col gap-3 px-3 py-3 pb-[calc(var(--safe-bottom)_+_1rem)]">
        <div className="flex gap-2">
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("annotate.url.placeholder")}
            aria-label={t("annotate.url.label")}
            className="min-w-0 flex-1 rounded-lg border border-rule bg-background px-2.5 py-2 text-sm"
          />
          <Button onClick={() => void shoot()} disabled={busy !== null || url.trim() === ""}>
            {busy === "shooting" ? <Loader2 className="size-4 animate-spin" /> : null}
            {shot === null ? t("annotate.shoot") : t("annotate.retake")}
          </Button>
        </div>

        <div className="flex gap-1" role="group" aria-label={t("annotate.viewport.label")}>
          {VIEWPORTS.map((v) => (
            <Button
              key={v.key}
              variant={viewport === v.key ? "default" : "outline"}
              size="sm"
              aria-pressed={viewport === v.key}
              onClick={() => setViewport(v.key)}
            >
              {t(`annotate.viewport.${v.key}`)}
            </Button>
          ))}
        </div>

        {error !== null && (
          <p className="rounded-lg border border-rule bg-muted/40 px-2.5 py-2 text-xs text-status-blocked">
            {error}
          </p>
        )}

        {shot === null ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {busy === "shooting" ? t("annotate.shooting") : t("annotate.empty")}
          </p>
        ) : (
          <>
            <Toolbar
              tool={tool}
              setTool={setTool}
              color={color}
              setColor={setColor}
              markup={markup}
              setMarkup={setMarkup}
              offerInspect
            />
            {tool === "text" && (
              <input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder={t("annotate.text.placeholder")}
                aria-label={t("annotate.text.label")}
                className="rounded-lg border border-rule bg-background px-2.5 py-2 text-sm"
              />
            )}
            <p className="text-xs text-muted-foreground">
              {busy === "probing" ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  {t("annotate.inspect.probing")}
                </span>
              ) : tool === "inspect" ? (
                t("annotate.inspect.hint")
              ) : (
                t("annotate.draw.hint")
              )}
            </p>
            <MarkupCanvas
              image={image}
              width={shot.width}
              height={shot.height}
              markup={markup}
              onCommit={(mark) => setMarkup((m) => addMark(m, mark))}
              tool={tool}
              color={color}
              strokeWidth={4}
              caption={caption}
              onInspect={(at) => void inspect(at)}
              busy={busy !== null}
            />
            {pins.map((pin) => (
              <ElementCard
                key={pin.n}
                pin={pin}
                onNote={(note) => setPins((prev) => prev.map((p) => (p.n === pin.n ? { ...p, note } : p)))}
              />
            ))}
            <Button onClick={() => void attach()} disabled={busy !== null}>
              {busy === "attaching" ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("annotate.attach")}
            </Button>
          </>
        )}
      </div>
    </RightSheet>
  );
}

// ── C4: draw on an attached image ─────────────────────────────────────────────────────────────

export interface ImageMarkupSheetProps {
  open: boolean;
  onClose: () => void;
  /** The picked file, before it is uploaded. */
  file: File | null;
  /** The flattened replacement. The composer uploads THIS instead of what the picker handed it. */
  onDone: (file: File) => void;
  maxUploadBytes: number;
}

/**
 * The same canvas with no Inspect mode, for an image the operator is about to attach.
 *
 * The phone beats the desktop at exactly this one thing — a finger on glass is a better annotation
 * instrument than a mouse — and a circled screenshot of a broken layout is worth a paragraph of
 * "the button under the chart, on the right, about 4px too low".
 *
 * The canvas round trip also strips EXIF from a camera-roll pick, which is a small privacy win
 * nobody asked for and nobody has to be told about.
 */
export function ImageMarkupSheet({ open, onClose, file, onDone, maxUploadBytes }: ImageMarkupSheetProps) {
  useLocale();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [markup, setMarkup] = useState<Markup>(EMPTY_MARKUP);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || file === null) return;
    let url: string | null = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    let cancelled = false;
    void (async () => {
      // A decode that fails still leaves a usable element on most browsers; the canvas simply draws
      // nothing, which is the same outcome as a picture that has not loaded yet.
      await img.decode().catch(() => undefined);
      if (cancelled) return;
      setImage(img);
      setSize({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
      setMarkup(EMPTY_MARKUP);
      setError(null);
    })();
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
      url = null;
    };
  }, [open, file]);

  async function done() {
    if (image === null || file === null) return;
    setBusy(true);
    try {
      const composed = await composeMarkup({
        base: image,
        width: size.width,
        height: size.height,
        marks: markup.marks,
        maxBytes: Math.max(64 * 1024, maxUploadBytes - UPLOAD_HEADROOM),
      });
      const flat = dataUrlToFile(composed.dataUrl, `markup.${extensionForMime(composed.mime)}`);
      if (flat === null || flat.size > maxUploadBytes) {
        setError(t("annotate.error.tooLarge"));
        return;
      }
      onDone(flat);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <RightSheet open={open} onClose={onClose} title={t("annotate.markup.title")} subtitle={file?.name}>
      <div className="flex flex-col gap-3 px-3 py-3 pb-[calc(var(--safe-bottom)_+_1rem)]">
        {error !== null && (
          <p className="rounded-lg border border-rule bg-muted/40 px-2.5 py-2 text-xs text-status-blocked">
            {error}
          </p>
        )}
        <Toolbar
          tool={tool}
          setTool={setTool}
          color={color}
          setColor={setColor}
          markup={markup}
          setMarkup={setMarkup}
          offerInspect={false}
        />
        {tool === "text" && (
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder={t("annotate.text.placeholder")}
            aria-label={t("annotate.text.label")}
            className="rounded-lg border border-rule bg-background px-2.5 py-2 text-sm"
          />
        )}
        <MarkupCanvas
          image={image}
          width={size.width || 1}
          height={size.height || 1}
          markup={markup}
          onCommit={(mark) => setMarkup((m) => addMark(m, mark))}
          tool={tool}
          color={color}
          strokeWidth={4}
          caption={caption}
          onInspect={() => {}}
          busy={busy}
        />
        <Button onClick={() => void done()} disabled={busy || image === null}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("annotate.markup.done")}
        </Button>
      </div>
    </RightSheet>
  );
}
