import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { artifactRawSrc } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { ArtifactView } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK — the body of one artifact, by kind. A page is a FRAME: `sandbox=""` under the bridge's
// DOCUMENT_CSP, exactly as preview-panel.tsx and doc-panel.tsx draw theirs, so a report built from
// things read on the web cannot reach the app's origin. Markdown and text come back as text/plain
// and are rendered HERE, by the same renderer the thread uses — never by the frame. An image is an
// `<img>`. Anything else is offered to a new tab (the share sheet, on a phone), never rendered.

type Loaded = { phase: "loading" } | { phase: "ready"; text: string } | { phase: "failed" };

function useRawText(src: string, enabled: boolean): Loaded {
  const [state, setState] = useState<Loaded>({ phase: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setState({ phase: "loading" });
    void (async () => {
      try {
        const res = await fetch(src, { signal: ctl.signal, credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        const text = await res.text();
        if (!ctl.signal.aborted) setState({ phase: "ready", text });
      } catch {
        if (!ctl.signal.aborted) setState({ phase: "failed" });
      }
    })();
    return () => ctl.abort();
  }, [src, enabled]);
  return state;
}

export function ArtifactViewer({
  artifact,
  scope,
  className,
}: {
  artifact: ArtifactView;
  scope?: Scope;
  className?: string;
}) {
  useLocale();
  const [nonce, setNonce] = useState(0);
  const src = artifactRawSrc(artifact.id, scope);
  const textual = artifact.kind === "markdown" || artifact.kind === "text";
  const raw = useRawText(src, textual);

  if (artifact.kind === "html") {
    return (
      <div data-slot="artifact-viewer" className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <div className="flex items-center gap-1 px-2 py-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{artifact.slug}</span>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("artifacts.viewer.refresh")} onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("artifacts.viewer.openTab")}
            onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border bg-background">
          <iframe
            sandbox=""
            src={`${src}#${String(nonce)}`}
            title={artifact.title}
            className="block h-full min-h-full w-full border-0"
          />
        </div>
      </div>
    );
  }

  if (artifact.kind === "image") {
    return (
      <div data-slot="artifact-viewer" className={cn("min-h-0 flex-1 overflow-auto overscroll-contain", className)}>
        <img src={src} alt={artifact.title} className="mx-auto block max-w-full rounded-md" />
      </div>
    );
  }

  if (textual) {
    if (raw.phase === "loading") {
      return <p className={cn("px-3 py-6 text-center text-sm text-muted-foreground", className)}>{t("artifacts.viewer.loading")}</p>;
    }
    if (raw.phase === "failed") {
      return <p className={cn("px-3 py-6 text-center text-sm text-muted-foreground", className)}>{t("artifacts.viewer.missing")}</p>;
    }
    return (
      <div data-slot="artifact-viewer" className={cn("min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2", className)}>
        {artifact.kind === "markdown" ? (
          <MarkdownText text={raw.text} className="font-content text-sm" />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{raw.text}</pre>
        )}
      </div>
    );
  }

  return (
    <div data-slot="artifact-viewer" className={cn("flex flex-col items-center gap-3 px-4 py-8 text-center", className)}>
      <p className="text-sm text-muted-foreground">{t("artifacts.viewer.attachment")}</p>
      <Button variant="secondary" onClick={() => window.open(src, "_blank", "noopener,noreferrer")}>
        <ExternalLink className="size-4" />
        {t("artifacts.viewer.openTab")}
      </Button>
    </div>
  );
}
