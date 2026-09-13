import { useEffect, useState } from "react";
import { ArrowLeft, Pin, PinOff, Trash2, BookOpen, StickyNote } from "lucide-react";
import { useNavigate, useParams } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { ArtifactKindIcon, artifactWhen } from "@/components/artifact-card";
import { ArtifactViewer } from "@/components/artifact-viewer";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { deleteArtifact, fetchArtifact, patchArtifact } from "@/lib/api";
import { artifactSize, loadArtifacts, useArtifacts, versionsOf } from "@/lib/artifacts";
import { t } from "@/lib/i18n";
import { artifactPath, artifactsPath, panePath } from "@/lib/nav";
import { useRootData } from "@/lib/route-data";
import type { ArtifactView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NoteSheet } from "@/components/notes-sheet";

// FORK — one artifact, opened to read. The header is the back-button takeover; under it a strip
// says where it came from and offers the versions, then the body (components/artifact-viewer.tsx).
//
// The record is taken from the library snapshot when it is there (a tap from a card) and fetched by
// id when it is not (a deep link, a fresh tab), so the same route serves both without a loader that
// would refetch on every poll.

type Found = { phase: "loading" } | { phase: "ready"; artifact: ArtifactView } | { phase: "missing" };

export function ArtifactRoute() {
  useLocale();
  const data = useRootData();
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const { artifacts } = useArtifacts(data.scope);
  const inLibrary = artifacts.find((a) => a.id === id) ?? null;
  const [fetched, setFetched] = useState<Found>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // FORK: a note on the whole artifact, sent back to the pane that made it (lib/notes.ts).
  const [noting, setNoting] = useState(false);

  useEffect(() => {
    if (inLibrary !== null) return;
    const ctl = new AbortController();
    setFetched({ phase: "loading" });
    fetchArtifact(id, data.scope, ctl.signal)
      .then((res) => setFetched({ phase: "ready", artifact: res.artifact }))
      .catch(() => {
        if (ctl.signal.aborted) return;
        setFetched({ phase: "missing" });
      });
    return () => ctl.abort();
  }, [id, data.scope, inLibrary]);

  const artifact = inLibrary ?? (fetched.phase === "ready" ? fetched.artifact : null);
  const versions = artifact === null ? [] : versionsOf(artifacts, artifact.slug);

  const back = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate(artifactsPath(data.scope));
  };

  async function togglePin() {
    if (artifact === null || busy) return;
    setBusy(true);
    try {
      await patchArtifact(artifact.id, { pinned: !artifact.pinned }, data.scope);
      await loadArtifacts(data.scope);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (artifact === null || busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await deleteArtifact(artifact.id, data.scope);
      await loadArtifacts(data.scope);
      navigate(artifactsPath(data.scope), { replace: true });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const from =
    artifact === null
      ? ""
      : artifact.pane !== null
        ? t("artifacts.viewer.from", { pane: `${artifact.pane.workspaceLabel} › ${artifact.pane.agent}` })
        : artifact.origin !== null
          ? t("artifacts.viewer.origin", { origin: artifact.origin })
          : t("artifacts.viewer.noPane");

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-lg flex-1 flex-col" data-slot="artifact-route">
      <RouteHeader
        width="wide"
        override={
          <>
            <Button variant="ghost" size="icon" className="size-11" onClick={back} aria-label={t("artifacts.viewer.back")}>
              <ArrowLeft className="size-5" />
            </Button>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {artifact !== null && <ArtifactKindIcon kind={artifact.kind} className="text-muted-foreground" />}
              <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
                {artifact?.title ?? t("artifacts.title")}
              </h1>
            </div>
            {artifact !== null && (
              <>
                {artifact.pane !== null && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    aria-label={t("artifacts.viewer.note")}
                    onClick={() => setNoting(true)}
                  >
                    <StickyNote className="size-5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-11", artifact.pinned && "text-primary")}
                  disabled={busy}
                  aria-pressed={artifact.pinned}
                  aria-label={artifact.pinned ? t("artifacts.viewer.unpin") : t("artifacts.viewer.pin")}
                  onClick={() => void togglePin()}
                >
                  {artifact.pinned ? <PinOff className="size-5" /> : <Pin className="size-5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-11", confirming && "text-destructive")}
                  disabled={busy}
                  aria-label={confirming ? t("artifacts.viewer.deleteConfirm") : t("artifacts.viewer.delete")}
                  onClick={() => void remove()}
                  onBlur={() => setConfirming(false)}
                >
                  <Trash2 className="size-5" />
                </Button>
              </>
            )}
          </>
        }
      />
      {artifact === null ? (
        fetched.phase === "loading" ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("artifacts.viewer.loading")}</p>
        ) : (
          <EmptyState
            heading={t("artifacts.viewer.missing")}
            action={
              <Button variant="secondary" onClick={() => navigate(artifactsPath(data.scope))}>
                {t("artifacts.title")}
              </Button>
            }
          />
        )
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
            {artifact.pane !== null ? (
              <button
                type="button"
                className="min-w-0 truncate text-left underline-offset-2 active:underline"
                onClick={() => navigate(panePath(artifact.pane!.paneId, data.scope))}
              >
                {from}
              </button>
            ) : (
              <span className="min-w-0 truncate">{from}</span>
            )}
            <span aria-hidden>·</span>
            <span className="tabular-nums">{artifactSize(artifact.size)}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{artifactWhen(artifact.createdMs)}</span>
            {artifact.kbSlug !== null && (
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 text-primary underline-offset-2 active:underline"
                aria-label={t("artifacts.viewer.inKb")}
                onClick={() => window.open(`/api/doc/${encodeURIComponent(artifact.kbSlug ?? "")}`, "_blank", "noopener,noreferrer")}
              >
                <BookOpen className="size-3" aria-hidden />
                kb
              </button>
            )}
            {versions.length > 1 && (
              <span className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label={t("artifacts.viewer.versions")}>
                {versions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    aria-pressed={v.id === artifact.id}
                    onClick={() => navigate(artifactPath(v.id, data.scope), { replace: true })}
                    className={cn(
                      "rounded-full px-1.5 font-mono text-[10px] tabular-nums transition-colors",
                      v.id === artifact.id ? "bg-primary/15 text-primary" : "text-muted-foreground active:bg-muted",
                    )}
                  >
                    {t("artifacts.card.version", { version: String(v.version) })}
                  </button>
                ))}
              </span>
            )}
          </div>
          {confirming && (
            <p className="mx-3 mb-1 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {t("artifacts.viewer.deleteConfirm")}
            </p>
          )}
          <ArtifactViewer artifact={artifact} scope={data.scope} className="px-3 pb-[calc(var(--safe-bottom)_+_0.5rem)]" />
          {artifact.pane !== null && (
            <NoteSheet
              open={noting}
              onClose={() => setNoting(false)}
              paneId={artifact.pane.paneId}
              scope={data.scope}
              anchor={{ kind: "artifact", id: artifact.id, slug: artifact.slug, title: artifact.title, version: artifact.version }}
            />
          )}
        </>
      )}
    </div>
  );
}
