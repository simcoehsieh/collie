import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RightSheet } from "@/components/ui/right-sheet";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { DOC_PROXY_PATH } from "@/lib/doc-links";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { DocSummaryView, DocTagView } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: the knowledge-base panel — a document beside the terminal, and the BROWSER that finds one
// the agent never printed.
//
// Before this the panel could only be reached through a link in the mirror, so the operator's own
// notes were readable from the phone exactly when an agent had happened to mention them. The
// browser is kb's recent list, its search and its tags, proxied by bridge/docs-list.ts, drawn as
// rows that open the same sandboxed frame the link did. A BACK STACK inside the panel makes the
// hop from a document to the browser (and to a previous document) one tap, instead of closing and
// reopening a panel that had cost a megabyte to fill.

/** One document the panel can show: its slug, the proxied path the frame loads, and the URL to name. */
export interface DocRef {
  slug: string;
  path: string;
  href: string;
}

interface DocPanelProps {
  open: boolean;
  onClose: () => void;
  /**
   * The document to open ON THIS OPENING — a link tap. Null opens the browser. Read when `open`
   * flips true and not again, so navigating inside the panel never fights the prop.
   */
  initial: DocRef | null;
}

/** How long a keystroke waits before it becomes a search, so a typed word costs one round trip. */
export const SEARCH_DEBOUNCE_MS = 300;
/** How many tag chips the row shows — the most-used ones; kb has dozens. */
export const TAG_CHIPS = 14;

export function DocPanel({ open, onClose, initial }: DocPanelProps) {
  useLocale();
  // The stack of documents opened in this session of the panel; empty means the browser is showing.
  const [stack, setStack] = useState<DocRef[]>([]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setStack(initial ? [initial] : []);
    if (!open) setStack([]);
    wasOpen.current = open;
  }, [open, initial]);

  const current = stack.length > 0 ? stack[stack.length - 1]! : null;

  const openDoc = useCallback((slug: string) => {
    setStack((prev) => [...prev, { slug, path: `${DOC_PROXY_PATH}${slug}`, href: slug }]);
  }, []);

  function back() {
    setStack((prev) => prev.slice(0, -1));
  }

  return (
    <RightSheet
      open={open}
      onClose={onClose}
      title={current ? current.slug : t("docs.title")}
      subtitle={current && current.href !== current.slug ? current.href : undefined}
    >
      {current ? (
        <div className="flex h-full flex-col">
          {/* Back leads to the previous document, or to the browser when this was the first — so a
              document opened from a link is one tap from the rest of the knowledge base. */}
          <div className="flex shrink-0 items-center border-b border-rule px-2 py-1">
            <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={back}>
              <ChevronLeft className="size-4" />
              {stack.length > 1 ? t("docs.back") : t("docs.title")}
            </Button>
          </div>
          {/* `sandbox=""` withholds every capability — the same posture the response's own CSP takes,
              spelled again on the embedder so neither side is the only thing standing between an
              agent-written document and Collie's origin. `block` because an inline-level iframe in
              a scrolling body leaves a baseline gap and `h-full` misbehaves. */}
          <iframe src={current.path} sandbox="" title={current.slug} className="block min-h-0 w-full flex-1 border-0" />
        </div>
      ) : (
        <DocBrowser onOpen={openDoc} />
      )}
    </RightSheet>
  );
}

type Listing =
  | { phase: "loading" }
  | { phase: "ready"; documents: DocSummaryView[]; nextCursor?: string; more: boolean }
  | { phase: "failed" };

export function DocBrowser({ onOpen }: { onOpen: (slug: string) => void }) {
  useLocale();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<DocTagView[]>([]);
  const [listing, setListing] = useState<Listing>({ phase: "loading" });
  const inFlight = useRef<AbortController | null>(null);

  // The tag row, once. A failure here is silent: the row is an accelerator, not the feature.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await api.fetchDocTags(controller.signal);
        if (!controller.signal.aborted) setTags(res.tags.slice(0, TAG_CHIPS));
      } catch {
        // the row stays empty
      }
    })();
    return () => controller.abort();
  }, []);

  const load = useCallback(
    async (q: string, tagPath: string, cursor?: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      if (cursor === undefined) setListing({ phase: "loading" });
      else setListing((prev) => (prev.phase === "ready" ? { ...prev, more: true } : prev));
      try {
        const res = await api.fetchDocs({ q: q || undefined, tag: tagPath || undefined, cursor }, controller.signal);
        if (controller.signal.aborted) return;
        setListing((prev) => {
          const previous = cursor !== undefined && prev.phase === "ready" ? prev.documents : [];
          const next: Listing = { phase: "ready", documents: [...previous, ...res.documents], more: false };
          if (res.nextCursor !== undefined) next.nextCursor = res.nextCursor;
          return next;
        });
      } catch {
        if (controller.signal.aborted) return;
        setListing({ phase: "failed" });
      }
    },
    [],
  );

  // A keystroke waits SEARCH_DEBOUNCE_MS; a tag tap and the first paint do not.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      void load("", tag);
      return;
    }
    const id = window.setTimeout(() => void load(trimmed, tag), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, tag, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const searching = query.trim() !== "";

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-rule px-3 py-2">
        <label className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("docs.search.placeholder")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query !== "" && (
            <button type="button" aria-label={t("common.closeAria")} onClick={() => setQuery("")} className="text-muted-foreground">
              <X className="size-4" />
            </button>
          )}
        </label>
        {tags.length > 0 && (
          <div role="group" aria-label={t("docs.tags.aria")} className="-mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none]">
            {tags.map((row) => {
              const active = tag === row.path;
              return (
                <button
                  key={row.path}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTag(active ? "" : row.path)}
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                    // FORK: tonal ON, not solid — a filter chip marks state, and this panel's one
                    // action is the document you tap. See pane-strip.tsx for the rule.
                    active ? "bg-control-on text-control-on-foreground" : "bg-muted text-foreground hover:bg-accent",
                  )}
                >
                  {row.path}
                  <span className={cn("ml-1 tabular-nums", active ? "text-control-on-foreground/80" : "text-muted-foreground")}>
                    {row.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {searching ? t("docs.results") : t("docs.recent")}
        </p>
        {listing.phase === "loading" && (
          <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </p>
        )}
        {listing.phase === "failed" && <p className="px-4 py-4 text-sm text-muted-foreground">{t("docs.error")}</p>}
        {listing.phase === "ready" && listing.documents.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t("docs.empty")}</p>
        )}
        {listing.phase === "ready" && (
          <ul className="divide-y divide-border">
            {listing.documents.map((doc) => (
              <li key={doc.slug}>
                <button
                  type="button"
                  onClick={() => onOpen(doc.slug)}
                  className="flex min-h-11 w-full flex-col gap-0.5 px-4 py-2 text-left hover:bg-accent active:bg-muted"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{doc.title || doc.slug}</span>
                    {doc.updatedAt && (
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(Date.parse(doc.updatedAt))}</span>
                    )}
                  </span>
                  {doc.summary && (
                    <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{doc.summary}</span>
                  )}
                </button>
              </li>
            ))}
            {listing.nextCursor !== undefined && (
              <li className="px-4 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={listing.more}
                  onClick={() => void load(query.trim(), tag, listing.nextCursor)}
                >
                  {listing.more ? <Loader2 className="size-4 animate-spin" /> : t("docs.more")}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
