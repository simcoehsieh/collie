import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, Loader2 } from "lucide-react";

import { listDirs } from "@/lib/api";
import { shortenHome } from "@/lib/shorten-home";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import type { Scope } from "@/lib/scope";
import type { DirsResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// Pick a folder instead of typing its path. The manual field it sits above is unchanged and stays
// the answer for everything this cannot reach (a dotted directory, a path outside home, dictation);
// this is the answer for the ordinary case, which is "one of the handful of project directories I
// already work in", and which used to cost an absolute path typed on glass with no feedback for a
// typo but a shell that opens somewhere else.
//
// TAPPING A ROW BOTH DESCENDS AND SELECTS, and that is the whole interaction. The alternative —
// descend on the row, select with a second control — asks for two taps per level and then a third
// to commit, and puts the operator in a state where the row they are looking at is not the one that
// would be used. Here the header always names what a create would use: you walk down until it says
// the right thing and press the button below.
//
// EVERY LISTING FAILURE IS THE SAME MOVE: stay where you are and say so. The bridge refuses with a
// status and no coded body (bridge/dirs.ts says why), and there is nothing the operator can do
// differently about a 403 versus a 404 from inside a picker — the recovery for all of them is the
// manual field.

interface DirPickerProps {
  /** The chosen directory, absolute. `""` means "the operator's home", which is also the default. */
  value: string;
  onChange: (path: string) => void;
  /**
   * Directories worth one tap because the operator is already working in them — the open spaces'
   * own `cwd`s, deduped by the caller's list order (most recent first). Absent renders no strip at
   * all rather than an empty one.
   */
  shortcuts?: readonly string[];
  /** Which machine's disk to browse. The same scope the create is addressed to. */
  scope?: Scope;
  disabled?: boolean;
}

const NO_SHORTCUTS: readonly string[] = [];

/** What a listing is doing right now. `failed` is terminal for one directory, never for the picker. */
type Phase = "idle" | "loading" | "failed";

export function DirPicker({
  value,
  onChange,
  shortcuts = NO_SHORTCUTS,
  scope,
  disabled,
}: DirPickerProps) {
  useLocale();
  // WHERE THE LISTING IS, which is not the same state as WHAT IS CHOSEN. They move together on
  // every tap in here, and apart the moment the operator types in the manual field below — where
  // yanking the browser to a half-typed path would re-fetch on every keystroke and land on 404s.
  const [at, setAt] = useState(value);
  const [listing, setListing] = useState<DirsResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    let live = true;
    setPhase("loading");
    void (async () => {
      try {
        const res = await listDirs(at === "" ? undefined : at, scope);
        if (!live) return;
        setListing(res);
        setPhase("idle");
      } catch {
        // A refusal or a dead bridge, and the picker's move is the same: keep the last good listing
        // on screen so the operator can step back out of wherever they are.
        if (live) setPhase("failed");
      }
    })();
    return () => {
      live = false;
    };
  }, [at, scope]);

  const go = useCallback(
    (path: string) => {
      if (disabled) return;
      setAt(path);
      onChange(path);
    },
    [disabled, onChange],
  );

  const home = listing?.home ?? "";
  const shown = (path: string): string => (home === "" ? path : shortenHome(path, home));
  const parent = listing?.parent ?? null;

  return (
    <div className="flex flex-col gap-1">
      {shortcuts.length > 0 && (
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {shortcuts.map((path) => (
            <button
              key={path}
              type="button"
              disabled={disabled}
              onClick={() => go(path)}
              className={cn(
                // `min-h-11` and never `h-`: a floor, so a long project name that wraps grows the
                // chip rather than being clipped (DESIGN.md §6).
                "flex min-h-11 shrink-0 items-center rounded-lg border border-border px-3 text-sm",
                value === path
                  ? "border-primary bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {shown(path).split("/").pop() || shown(path)}
            </button>
          ))}
        </div>
      )}

      {/* The header IS the answer: whatever it says is what a create would use. */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 px-2 py-1">
        <button
          type="button"
          disabled={disabled || parent === null}
          onClick={() => parent !== null && go(parent)}
          aria-label={t("dirs.up")}
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground disabled:opacity-30"
        >
          <CornerLeftUp className="size-4" />
        </button>
        {/* `dir="rtl"` truncates from the LEFT, which is where a long path's uninteresting half is:
            `…/git/side-projects/collie` beats `~/git/side-pro…`. The text itself is unchanged — only
            which end the ellipsis eats. `text-left` is the other half of that pair and is not
            optional: rtl also right-ALIGNS, which parks a short path (`~`, on the very first open)
            against the far edge with the width of a phone between it and the up arrow. */}
        <span className="min-w-0 flex-1 truncate text-left font-mono text-xs" dir="rtl">
          <span dir="ltr">{listing === null ? "…" : shown(listing.path)}</span>
        </span>
        {phase === "loading" && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      <div className="max-h-56 overflow-y-auto overscroll-contain rounded-lg border border-border">
        {phase === "failed" && (
          <p className="px-3 py-2 text-xs text-status-blocked">{t("dirs.failed")}</p>
        )}
        {listing !== null && listing.entries.length === 0 && phase !== "failed" && (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t("dirs.empty")}</p>
        )}
        {listing?.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            disabled={disabled}
            onClick={() => go(entry.path)}
            className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-accent"
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        ))}
        {listing?.truncated === true && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("dirs.truncated", { count: listing.entries.length })}
          </p>
        )}
      </div>
    </div>
  );
}
