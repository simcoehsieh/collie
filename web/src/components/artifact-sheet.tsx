import { Library } from "lucide-react";
import { useNavigate } from "react-router";

import { ArtifactCard } from "@/components/artifact-card";
import { EmptyState } from "@/components/empty-state";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { artifactsForPane, latestVersions, useArtifacts } from "@/lib/artifacts";
import { t } from "@/lib/i18n";
import { artifactPath, artifactsPath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";

// FORK — the pane's own artifacts, as a sheet off the header chip: the newest version of each,
// newest first, and one row at the bottom into the whole library. A `drawer` arm in agent-chat.tsx
// like every other sheet there, so it cannot be open beside the switcher or the pane menu.

export function ArtifactSheet({
  open,
  onClose,
  paneId,
  scope,
}: {
  open: boolean;
  onClose: () => void;
  paneId: string;
  scope?: Scope;
}) {
  useLocale();
  const navigate = useNavigate();
  const { artifacts, phase } = useArtifacts(scope);
  const mine = latestVersions(artifactsForPane(artifacts, paneId));
  return (
    <BottomSheet open={open} onClose={onClose} title={t("artifacts.sheet.title")}>
      <div data-slot="artifact-sheet" className="flex flex-col gap-2 px-1 pb-2">
        {mine.length === 0 ? (
          <EmptyState
            mark={null}
            heading={t("artifacts.empty.heading")}
            body={phase === "failed" ? t("artifacts.failed") : t("artifacts.empty.pane")}
            className="py-6"
          />
        ) : (
          mine.map((a) => (
            <ArtifactCard
              key={a.id}
              artifact={a}
              onOpen={(artifact) => {
                onClose();
                navigate(artifactPath(artifact.id, scope));
              }}
            />
          ))
        )}
        <button
          type="button"
          onClick={() => {
            onClose();
            navigate(artifactsPath(scope));
          }}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50"
        >
          <Library className="size-3.5" aria-hidden />
          {t("artifacts.sheet.all")}
        </button>
      </div>
    </BottomSheet>
  );
}
