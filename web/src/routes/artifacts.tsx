import { useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Search } from "lucide-react";
import { useNavigate } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { ArtifactCard } from "@/components/artifact-card";
import { EmptyState } from "@/components/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { latestVersions, useArtifacts } from "@/lib/artifacts";
import { t } from "@/lib/i18n";
import { artifactPath, homePath } from "@/lib/nav";
import { useRootData } from "@/lib/route-data";
import { scopeKey, type Scope } from "@/lib/scope";
import type { ArtifactKind, ArtifactView } from "@/lib/types";

// FORK — the library: everything every agent made, newest first, one row per artifact (its newest
// version), pinned ones first. The shell is the Overview's — a back-button takeover header over a
// scrolling column — because that is what a full-screen list looks like in this app.

function matches(a: ArtifactView, q: string): boolean {
  if (q === "") return true;
  const hay = `${a.title} ${a.slug} ${a.tags.join(" ")} ${a.pane?.workspaceLabel ?? ""} ${a.pane?.agent ?? ""} ${a.origin ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .every((w) => hay.includes(w));
}

const PAGE_SIZE = 40;
const KINDS = ["html", "markdown", "image", "text", "file"] satisfies ArtifactKind[];
interface LibraryView {
  query: string;
  kind: ArtifactKind | "all";
  pinnedOnly: boolean;
  limit: number;
}
const DEFAULT_VIEW: LibraryView = { query: "", kind: "all", pinnedOnly: false, limit: PAGE_SIZE };
// Navigation away and back keeps the search, filters and revealed window. Memory only: no artifact
// metadata is persisted to disk and each host/session has its own view. Bound inactive scopes.
const views = new Map<string, LibraryView>();

export function __resetArtifactViews(): void {
  views.clear();
}

export function ArtifactsRoute() {
  const { scope } = useRootData();
  return <ArtifactLibrary key={scopeKey(scope)} scope={scope} />;
}

function ArtifactLibrary({ scope }: { scope: Scope }) {
  useLocale();
  const navigate = useNavigate();
  const { artifacts, phase, reload } = useArtifacts(scope);
  const key = scopeKey(scope);
  const [view, setView] = useState(() => views.get(key) ?? DEFAULT_VIEW);
  const { query, kind, pinnedOnly, limit } = view;
  const changeView = (patch: Partial<LibraryView>) => {
    const next = { ...view, limit: PAGE_SIZE, ...patch };
    views.delete(key);
    views.set(key, next);
    if (views.size > 16) {
      const oldest = views.keys().next().value;
      if (oldest !== undefined) views.delete(oldest);
    }
    setView(next);
  };
  const latest = useMemo(() => latestVersions(artifacts), [artifacts]);
  const rows = useMemo(() => {
    const matched = latest.filter((a) => matches(a, query) && (kind === "all" || a.kind === kind) && (!pinnedOnly || a.pinned));
    return [...matched.filter((a) => a.pinned), ...matched.filter((a) => !a.pinned)];
  }, [latest, query, kind, pinnedOnly]);
  const visible = rows.slice(0, limit);
  const pinned = visible.filter((a) => a.pinned);
  const rest = visible.filter((a) => !a.pinned);
  const filtered = query.trim() !== "" || kind !== "all" || pinnedOnly;
  const open = (a: ArtifactView) => navigate(artifactPath(a.id, scope));

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-md flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              onClick={() => navigate(homePath(scope))}
              aria-label={t("settings.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{t("artifacts.title")}</h1>
            <Button variant="ghost" size="icon" className="size-11" onClick={reload}
              disabled={phase === "loading"} aria-label={t("artifacts.viewer.refresh")}>
              <RefreshCw className={phase === "loading" ? "size-4 animate-spin" : "size-4"} aria-hidden />
            </Button>
            <SettingsGear scope={scope} />
          </>
        }
      />
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-4" data-slot="artifacts-route">
        {artifacts.length > 0 && (
          <label className="mb-3 flex min-h-11 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => changeView({ query: e.target.value })}
              placeholder={t("artifacts.search.placeholder")}
              aria-label={t("artifacts.search.placeholder")}
              className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </label>
        )}
        {artifacts.length > 0 && (
          <>
            <div className="mb-2 flex min-h-11 items-center gap-2 overflow-x-auto px-0.5" aria-label={t("artifacts.filter.kind")}>
              <Chip label={t("artifacts.filter.all")} active={kind === "all"} onClick={() => changeView({ kind: "all" })} />
              {KINDS.map((k) => <Chip key={k} label={t(`artifacts.kind.${k}`)} active={kind === k} onClick={() => changeView({ kind: k })} />)}
            </div>
            <div className="mb-3 flex min-h-11 items-center justify-between gap-2">
              <Button variant={pinnedOnly ? "secondary" : "ghost"} size="sm" className="min-h-11"
                aria-pressed={pinnedOnly} onClick={() => changeView({ pinnedOnly: !pinnedOnly })}>
                {t("artifacts.filter.pinned")}
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums" role="status">
                {t("artifacts.results", { shown: String(visible.length), total: String(rows.length) })}
              </span>
            </div>
          </>
        )}
        <Collapse open={phase === "failed" && artifacts.length > 0}>
          <Notice tone="caution" variant="box" announce="status" className="mb-3">{t("artifacts.stale")}</Notice>
        </Collapse>
        {(phase === "idle" || phase === "loading") && artifacts.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground" role="status">{t("artifacts.viewer.loading")}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            heading={t("artifacts.empty.heading")}
            body={phase === "failed" ? t("artifacts.failed") : filtered ? t("artifacts.empty.search") : t("artifacts.empty.body")}
            detail={!filtered && phase !== "failed" ? "collie artifact add report.html --title …" : undefined}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {pinned.length > 0 && (
              <>
                <SectionLabel placement="above">{t("artifacts.pinned")}</SectionLabel>
                {pinned.map((a) => (
                  <ArtifactCard key={a.id} artifact={a} onOpen={open} showPane />
                ))}
                <SectionLabel placement="above" className="mt-2">
                  {t("artifacts.recent")}
                </SectionLabel>
              </>
            )}
            {rest.map((a) => (
              <ArtifactCard key={a.id} artifact={a} onOpen={open} showPane />
            ))}
            {rows.length > visible.length && (
              <Button variant="outline" className="min-h-11" onClick={() => changeView({ limit: limit + PAGE_SIZE })}>
                {t("artifacts.showMore")}
              </Button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
