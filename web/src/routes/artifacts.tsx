import { useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { useNavigate } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { ArtifactCard } from "@/components/artifact-card";
import { EmptyState } from "@/components/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { latestVersions, useArtifacts } from "@/lib/artifacts";
import { t } from "@/lib/i18n";
import { artifactPath, homePath } from "@/lib/nav";
import { useRootData } from "@/lib/route-data";
import type { ArtifactView } from "@/lib/types";

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

export function ArtifactsRoute() {
  useLocale();
  const data = useRootData();
  const navigate = useNavigate();
  const { artifacts, phase } = useArtifacts(data.scope);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => latestVersions(artifacts).filter((a) => matches(a, query)), [artifacts, query]);
  const pinned = rows.filter((a) => a.pinned);
  const rest = rows.filter((a) => !a.pinned);
  const open = (a: ArtifactView) => navigate(artifactPath(a.id, data.scope));

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
              onClick={() => navigate(homePath(data.scope))}
              aria-label={t("settings.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{t("artifacts.title")}</h1>
            <SettingsGear scope={data.scope} />
          </>
        }
      />
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-4" data-slot="artifacts-route">
        {artifacts.length > 0 && (
          <label className="mb-3 flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("artifacts.search.placeholder")}
              aria-label={t("artifacts.search.placeholder")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
        )}
        {rows.length === 0 ? (
          <EmptyState
            heading={t("artifacts.empty.heading")}
            body={phase === "failed" ? t("artifacts.failed") : query !== "" ? t("artifacts.empty.search") : t("artifacts.empty.body")}
            detail={query === "" && phase !== "failed" ? "collie artifact add report.html --title …" : undefined}
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
          </div>
        )}
      </main>
    </div>
  );
}
