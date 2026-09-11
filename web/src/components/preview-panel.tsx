import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RightSheet } from "@/components/ui/right-sheet";
import { useLocale } from "@/hooks/use-locale";
import { previewSrc } from "@/lib/doc-links";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// FORK: an HTML file the agent WROTE, framed beside the terminal (bridge/preview.ts).
//
// It is `doc-panel.tsx`'s iframe with three controls around it rather than a second panel, and the
// posture is identical: `sandbox=""` on the embedder, spelled again even though the response carries
// its own `sandbox` CSP, so neither side is the only thing standing between an agent-written page
// and Collie's origin. The ONE difference from a knowledge-base document is that this file is being
// rewritten while the operator looks at it, which is what the three controls are for.
//
// ── WHY A WIDTH TOGGLE, AND WHY IT IS A SCALE RATHER THAN A ZOOM ────────────────────────────────
// The panel is a full-height sheet on a 390px phone, and the page inside it was written for a
// desktop — so "does my layout work" is unanswerable by default, because the page is simply cut off.
// The toggle sets the iframe's own WIDTH (which is what the page's media queries read) and then
// scales the result down to fit the panel, so 768 means "render as a 768px viewport and show me all
// of it" rather than "make the text smaller". A CSS zoom would change the viewport width too and
// answer a different question.
//
// ── WHY Reload IS A BUTTON AND NOT A POLL ───────────────────────────────────────────────────────
// There is no live reload to have: the bridge has no WebSocket handler on either listener, so
// nothing can tell the panel the file moved. Polling a 5 MB page on a mobile link to find out would
// be worse than the button. The response is `no-cache` + a strong ETag, so the tap costs a
// conditional request and a 304 when nothing changed — which is what makes the button honest.

/** The widths the toggle offers: a phone, a small tablet, and whatever the panel actually is. */
const WIDTHS = [390, 768, 0] as const;
type PreviewWidth = (typeof WIDTHS)[number];

interface PreviewPanelProps {
  open: boolean;
  onClose: () => void;
  /** The pane whose cwd the path was validated against — the jail is that directory, not the disk. */
  paneId: string;
  /** The absolute path on the answering machine, as `classifyDocLink` validated it. Null = closed. */
  path: string | null;
}

export function PreviewPanel({ open, onClose, paneId, path }: PreviewPanelProps) {
  useLocale();
  const [width, setWidth] = useState<PreviewWidth>(0);
  // Bumped to force the frame to re-fetch. A key change remounts the iframe, which is the only way
  // to reload a cross-origin frame the parent cannot script into.
  const [nonce, setNonce] = useState(0);
  const [panelWidth, setPanelWidth] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);

  // A fresh open starts at "fit": the operator asked to see the page, not to see it at whatever
  // width they were checking a different page at ten minutes ago.
  useEffect(() => {
    if (open) {
      setWidth(0);
      setNonce((n) => n + 1);
    }
  }, [open, path]);

  // The panel's own width, measured rather than assumed — the sheet is full-width below `sm` and
  // inset above it, so a constant here would be wrong on exactly one of the two.
  //
  // A `resize` listener rather than a `ResizeObserver`, and it is not a fallback: this box is sized
  // by the viewport and by nothing else, so the only events that move it are a rotation and a split
  // view, both of which are window resizes. The observer would be a second mechanism watching for
  // changes that cannot happen.
  useEffect(() => {
    if (!open) return;
    const measure = () => setPanelWidth(hostRef.current?.clientWidth ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  if (path === null) {
    return <RightSheet open={open} onClose={onClose} title={t("preview.title")}>{null}</RightSheet>;
  }

  const src = `${previewSrc(paneId, path)}#${String(nonce)}`;
  // 1 at "fit" and whenever the chosen width already fits — a page is never scaled UP, because
  // enlarging a 390px layout to fill a 400px panel only makes it blurry.
  const scale = width === 0 || panelWidth === 0 || panelWidth >= width ? 1 : panelWidth / width;
  const name = path.split("/").pop() ?? path;

  return (
    <RightSheet open={open} onClose={onClose} title={name} subtitle={path}>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-rule px-2 py-1">
          <div role="group" aria-label={t("preview.width.aria")} className="flex items-center gap-1">
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={width === w}
                onClick={() => setWidth(w)}
                className={cn(
                  "min-h-8 rounded-full px-2.5 text-xs font-medium tabular-nums transition-colors",
                  width === w ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-accent",
                )}
              >
                {w === 0 ? t("preview.width.fit") : String(w)}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2"
            onClick={() => setNonce((n) => n + 1)}
            aria-label={t("preview.reload")}
          >
            <RefreshCw className="size-4" />
          </Button>
          {/* The one way OUT of the app, and it is offered rather than assumed: the panel cannot
              print, cannot open a devtools inspector and cannot save. `previewSrc` is same-origin,
              so this opens the bridge's own route in Safari with the operator's existing session. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2"
            onClick={() => window.open(previewSrc(paneId, path), "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="size-4" />
            {t("preview.openExternally")}
          </Button>
        </div>

        {/* `overflow-auto` on the host, a fixed-width frame inside it: on iOS a nested iframe is one
            gesture target, so the panel's scroll and the page's fight unless the frame is sized to
            its content and the OUTER box is the scroller. */}
        <div ref={hostRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <iframe
            // `sandbox=""` withholds every capability — no scripts, no forms, no popups, and above
            // all no same-origin — which is the response's own CSP said again on the embedder. A
            // page the agent generated out of things it read on the web must not be one word away
            // from Collie's storage and its API.
            sandbox=""
            src={src}
            title={name}
            className="block border-0"
            style={{
              width: width === 0 ? "100%" : `${String(width)}px`,
              height: scale === 1 ? "100%" : `${String(100 / scale)}%`,
              minHeight: "100%",
              transform: scale === 1 ? undefined : `scale(${String(scale)})`,
              transformOrigin: "top left",
            }}
          />
        </div>
      </div>
    </RightSheet>
  );
}
