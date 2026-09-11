import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader2, MonitorPlay, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RightSheet } from "@/components/ui/right-sheet";
import type { MirrorFont } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { isApiErrorStatus } from "@/lib/api";
import { buzz } from "@/lib/haptics";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { PaneFileResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: one file of the pane's work tree, read-only — the question `git diff` cannot answer.
//
// An unchanged file has no patch and a hunk's context is three lines, so "what does the rest of that
// file say" was, from a phone, unanswerable. The bridge half is bridge/file-view.ts; this is the
// sheet, and it shares the diff sheet's host (`RightSheet`) because it is the same kind of thing:
// a page beside the terminal, dismissed with a swipe, that the mirror stays live behind.
//
// ── NO SYNTAX HIGHLIGHTING, AND THAT IS A DECISION RATHER THAN A GAP ────────────────────────────
// Every highlighter worth having either emits an HTML STRING — unusable here, because this app's
// XSS boundary is that agent-adjacent text becomes React text nodes and never markup (CLAUDE.md →
// "Security posture") — or arrives as a multi-hundred-kilobyte grammar bundle for a repo whose
// dependency policy makes a casual addition a decision with its own argument. What it would buy is
// also the smallest slice of the value: the diff sheet next door already carries the +/− colouring,
// which is the 80% case, and the reason this sheet exists is to read CONTEXT, not to admire it.
// If it is ever wanted, it is hand-rolled over the same token stream the ANSI parser already
// produces — not a library, and not `dangerouslySetInnerHTML`.
//
// ── THE WINDOW, WHICH IS routes/history.tsx's ──────────────────────────────────────────────────
// The whole file arrives in one request (the bridge caps it at 512 KiB) and only the head of it is
// rendered, growing as the reader scrolls. 5,000 lines at 390px is ~5,000 DOM rows before wrapping
// is even considered, and the transcript route already measured what that costs. The data is in
// memory, so growing the window is instant and needs no network.

interface FileSheetProps {
  open: boolean;
  onClose: () => void;
  paneId: string;
  /** The file to show, repo-relative. Null closes the sheet's content down to nothing. */
  path: string | null;
  scope?: Scope;
  /** The mirror's font size, so code reads at the size the operator already chose for code. */
  fontSize: number;
  /** The mirror's face, for the same reason. */
  mirrorFace: MirrorFont;
  /**
   * Offer a Preview for this file — wired only when the pane can actually serve one, so an `.html`
   * in a pane whose bridge has no preview route shows no button rather than a broken one.
   */
  onPreview?: (path: string) => void;
}

type Loaded<T> = { phase: "loading" } | { phase: "ready"; data: T } | { phase: "failed"; message: string };

/** How many lines are rendered on open. A few screens at any font size the A+/A− control offers. */
export const INITIAL_LINES = 400;
/** How many more each growth step reveals. */
export const LINE_STEP = 800;
/** How close to the bottom (px) the reader has to get before the window grows on its own. */
const GROW_THRESHOLD = 600;

/** The sentence for a refused read, by status. Every one of them is an ordinary answer. */
function describeFailure<TThrown>(e: TThrown): string {
  if (isApiErrorStatus(e, 415)) return t("file.error.binary");
  if (isApiErrorStatus(e, 403)) return t("file.error.outside");
  if (isApiErrorStatus(e, 400)) return t("file.error.badPath");
  if (isApiErrorStatus(e, 404)) return t("file.error.notFound");
  return t("file.error.failed");
}

/** Whether this file is one the preview route would serve — the client half of `isPreviewPath`. */
function previewable(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

export function FileSheet({ open, onClose, paneId, path, scope, fontSize, mirrorFace, onPreview }: FileSheetProps) {
  useLocale();
  const [file, setFile] = useState<Loaded<PaneFileResponse>>({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(INITIAL_LINES);
  const scroller = useRef<HTMLDivElement>(null);
  // One in-flight request; a newer one aborts the older so a slow answer cannot land on top of a
  // fresher one — the shape every loader in this app uses.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (want: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setFile({ phase: "loading" });
      try {
        const data = await api.fetchPaneFile(paneId, want, scope, controller.signal);
        if (controller.signal.aborted) return;
        setFile({ phase: "ready", data });
      } catch (e) {
        if (controller.signal.aborted) return;
        setFile({ phase: "failed", message: describeFailure(e) });
      }
    },
    [paneId, scope],
  );

  // Opening (re)reads the file; closing forgets it, so a re-open never greets the operator with the
  // contents of a file the agent has since rewritten.
  useEffect(() => {
    if (!open || path === null) {
      inFlight.current?.abort();
      setCopied(false);
      return;
    }
    setShown(INITIAL_LINES);
    setCopied(false);
    void load(path);
  }, [open, path, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const lines = useMemo(() => {
    if (file.phase !== "ready") return [];
    const split = file.data.text.split("\n");
    // A trailing newline is a line terminator, not an empty last line — and drawing it as one adds a
    // phantom row to every well-formed file.
    if (split.length > 0 && split[split.length - 1] === "") split.pop();
    return split;
  }, [file]);

  const visible = shown >= lines.length ? lines : lines.slice(0, shown);
  const more = lines.length - visible.length;

  // Grow as the reader approaches the bottom, so a long file feels continuous rather than costing a
  // tap per window. The data is already held, so this is a render and not a fetch.
  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < GROW_THRESHOLD) {
        setShown((n) => (n >= lines.length ? n : n + LINE_STEP));
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [lines.length]);

  async function copyPath() {
    if (path === null) return;
    try {
      await navigator.clipboard.writeText(path);
      buzz();
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const ready = file.phase === "ready" ? file.data : null;
  const subtitle = ready
    ? t("file.subtitle", { lines: String(lines.length), bytes: String(ready.bytes) })
    : undefined;

  return (
    <RightSheet open={open} onClose={onClose} title={path ?? t("file.title")} subtitle={subtitle}>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-rule px-2 py-1">
          {path !== null && onPreview !== undefined && previewable(path) && (
            <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={() => onPreview(path)}>
              <MonitorPlay className="size-4" />
              {t("file.preview")}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={() => void copyPath()}>
            {copied ? <Check className="size-4 text-status-done" /> : <Copy className="size-4" />}
            {copied ? t("file.copied") : t("file.copyPath")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2"
            onClick={() => path !== null && void load(path)}
            aria-label={t("file.refresh")}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>

        {file.phase === "loading" && (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("file.loading")}
          </p>
        )}
        {file.phase === "failed" && <p className="px-4 py-6 text-sm text-muted-foreground">{file.message}</p>}
        {file.phase === "ready" && (
          // `overflow-auto` on the container and `min-w-max` on the <pre>: a long line PANS rather
          // than wraps, which is markdown-text.tsx's answer for a table and the only honest one for
          // code — a wrapped 200-column line stops being the line the agent is talking about.
          <div ref={scroller} className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <pre
              data-slot="file-body"
              className={cn("min-w-max px-2 py-2 font-mono leading-snug", mirrorFace.className)}
              style={{ fontSize, ...mirrorFace.style }}
            >
              {visible.map((line, i) => (
                <div key={`${i}:${line}`} className="flex whitespace-pre">
                  {/* The gutter is `select-none` so a copy of the body is the body: dragging across
                      a numbered listing and pasting the numbers with it is the classic annoyance
                      this one line avoids. `tabular-nums` keeps the column from breathing as the
                      count crosses a power of ten. */}
                  <span className="mr-3 shrink-0 select-none text-right tabular-nums text-muted-foreground" style={{ width: "4ch" }}>
                    {i + 1}
                  </span>
                  <span>{line === "" ? " " : line}</span>
                </div>
              ))}
            </pre>
            {more > 0 && (
              <div className="px-4 py-3">
                <Button variant="outline" size="sm" className="w-full" onClick={() => setShown((n) => n + LINE_STEP)}>
                  {t("file.more", { count: String(more) })}
                </Button>
              </div>
            )}
            {file.data.truncated && (
              <p className="px-4 py-3 text-xs text-muted-foreground">{t("file.truncated")}</p>
            )}
          </div>
        )}
      </div>
    </RightSheet>
  );
}
