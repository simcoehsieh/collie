import { useCallback, useSyncExternalStore } from "react";
import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";

import type { ChangesLayout } from "@/lib/changes-tree";
import { coerceDashView, type DashView } from "@/lib/dash-view";
import type { RecentDir } from "@/lib/triage";

// Dashboard layout preferences, persisted in localStorage. Deliberately separate from
// use-display-prefs (which is about the terminal mirror) — these are about the herd list.
// Safe in SSR contexts: every localStorage touch is guarded.
//
// FORK: ONE STORE, NOT ONE STATE PER HOOK CALL. Upstream held the prefs in `useState` inside
// `useDashPrefs`, which was fine while the dashboard was the only reader. Two of the fork's
// additions read the same prefs from two different places at once — Low power is flipped in Settings
// but read by the poll loop under the root layout — so a per-instance state would have let Settings say
// "on" while the tick kept polling at the fast gap until the next remount. Module state behind
// `useSyncExternalStore`, the same shape `lib/stt.ts` uses for hands-free, so every reader sees a
// write in the same tick.

export interface DashPrefs {
  /**
   * Whether the Spaces section is expanded. `null` means "never chosen" — the count threshold
   * decides (see {@link spacesOpenFor}), so a two-space install isn't handed a mystery collapsed
   * header while a forty-space one isn't handed a wall. An explicit choice always wins.
   */
  spacesOpen: boolean | null;
  /**
   * Whether the Shells section of the pane switcher is expanded. `null` = never chosen, so the
   * count decides — a herd with 37 bare shells shouldn't bury the agents you actually switch to.
   */
  shellsOpen: boolean | null;
  /**
   * Whether the Launch section is expanded. `null` = never chosen, so the count decides, like
   * Spaces: two launchers are worth showing, and an operator who declared thirty should not have
   * their herd pushed off the first screen by a wall of buttons.
   */
  launchOpen: boolean | null;
  /** Which way Recent runs. Attention sections are never affected. */
  recentDir: RecentDir;
  /**
   * What the tab strip's "+" opens: a launcher row's `command`, or `""` for a plain shell.
   *
   * `""` is the default and the shipped behaviour — an install with no launchers, or one that never
   * touches the long-press, gets exactly the bare shell it always did. The value is the row's
   * COMMAND rather than its label because the command is what `POST /api/launch` matches on, and a
   * label the operator later renames must not silently point the "+" at a different row. A command
   * that has since left `launchers.toml` resolves to nothing and falls back to the shell, which is
   * the same answer as never having chosen.
   */
  newTabLauncher: string;
  /**
   * FORK: Low power. Widens the poll gaps (hooks/use-polling.ts) while a mirror is followed —
   * 1 Hz becomes a third of that, a send's burst a tenth of a second slower — and leaves the live
   * feed alone, because one open stream is cheaper than the polls it replaces. Off by default: the
   * fast cadence is the product, and this is the operator saying "not today".
   */
  lowPower: boolean;
  /** FORK: the dashboard's usage section (components/quota-card.tsx), open unless folded. */
  quotaOpen: boolean;
  /** The dashboard's workspace filter: the one workspace shown alone, or null for all of them. */
  isolatedSpace: string | null;
  /** Workspaces hidden from the dashboard list (long-press a chip); their chips stay, dimmed. */
  hiddenSpaces: string[];
  /**
   * Whether the Changes view also looks for repos INSIDE the pane's folder, not only the repo that
   * contains it (ADR 0065). On by default: a workspace that keeps its member repos gitignored shows
   * nothing otherwise.
   */
  changesNested: boolean;
  /** How many folder levels below the pane's folder that search goes, 1 to 4. */
  changesDepth: number;
  /** The Changes list drawn flat, one row per file, or as a folder tree. */
  changesLayout: ChangesLayout;
  /**
   * The composer's action belt size, one factor for the whole belt: band, pills, icons and words
   * all grow from it together (`--belt-scale`, `components/actions-row.tsx`). One of
   * {@link BELT_SCALES}. 1.15 is the baseline Altan asked for on 2026-09-23 ("slightly higher and
   * the icons slightly larger, like 15%"); the other two are the Settings row's way up from there.
   */
  beltScale: BeltScale;
  /** The dashboard's footer tab: Panes, Focus or Changes (ADR 0066, renamed by ADR 0068). Panes by default. */
  dashView: DashView;
}

const STORAGE_KEY = "collie:dash-prefs:v1";

/** The depths the Changes setting offers. The bridge clamps to the same range on its side. */
export const CHANGES_DEPTHS = [1, 2, 3, 4] as const;

/** The belt sizes the Settings row offers: Default, Large, Larger. */
export const BELT_SCALES = [1.15, 1.3, 1.5] as const;
export type BeltScale = (typeof BELT_SCALES)[number];

/** Above this many rows, an un-chosen foldable section starts collapsed. */
export const COLLAPSE_THRESHOLD = 8;

const DEFAULTS: DashPrefs = {
  spacesOpen: null,
  shellsOpen: null,
  launchOpen: null,
  recentDir: "newest",
  newTabLauncher: "",
  lowPower: false,
  quotaOpen: true,
  isolatedSpace: null,
  hiddenSpaces: [],
  changesNested: true,
  changesDepth: 2,
  changesLayout: "list",
  beltScale: 1.15,
  dashView: "panes",
};

function coerceDepth(raw: JsonValue | undefined): number {
  return CHANGES_DEPTHS.find((d) => d === raw) ?? DEFAULTS.changesDepth;
}

function coerceBeltScale(raw: JsonValue | undefined): BeltScale {
  return BELT_SCALES.find((s) => s === raw) ?? DEFAULTS.beltScale;
}

/**
 * The effective open state of a count-sensitive section: an explicit choice always wins, otherwise
 * it opens only while it's short enough to be worth showing. Used by Spaces on the dashboard and by
 * Shells in the pane switcher — a two-item list shouldn't greet you as a mystery collapsed header,
 * and a forty-item one shouldn't greet you as a wall.
 */
export function openForCount(pref: boolean | null, count: number): boolean {
  if (pref !== null) return pref;
  return count <= COLLAPSE_THRESHOLD;
}

/**
 * Coerce an untrusted parsed value into {@link DashPrefs}, filling anything missing or wrong-typed
 * from the defaults. Pure + exported so the file-shape handling is unit-tested.
 */
export function coerceDashPrefs(raw: JsonValue | undefined): DashPrefs {
  const p = asJsonObject(raw);
  if (!p) return { ...DEFAULTS };
  return {
    spacesOpen: asJsonBoolean(p.spacesOpen) ?? DEFAULTS.spacesOpen,
    shellsOpen: asJsonBoolean(p.shellsOpen) ?? DEFAULTS.shellsOpen,
    launchOpen: asJsonBoolean(p.launchOpen) ?? DEFAULTS.launchOpen,
    // `p.recentOpen` (the fold's own state, from before the Recent section was removed) is read by
    // nothing here — an older version's stored blob still carries the key, and it is simply ignored,
    // the same way any other unknown field in a persisted object would be.
    recentDir: p.recentDir === "oldest" || p.recentDir === "newest" ? p.recentDir : DEFAULTS.recentDir,
    // A string of unknown provenance, and it is NOT validated against the current launcher rows
    // here: this store has never read that file and the rows are per-host anyway. An unknown
    // command resolves to nothing at the call site and falls back to the shell.
    newTabLauncher: typeof p.newTabLauncher === "string" ? p.newTabLauncher : DEFAULTS.newTabLauncher,
    lowPower: asJsonBoolean(p.lowPower) ?? DEFAULTS.lowPower,
    quotaOpen: asJsonBoolean(p.quotaOpen) ?? DEFAULTS.quotaOpen,
    isolatedSpace: asJsonString(p.isolatedSpace) ?? DEFAULTS.isolatedSpace,
    hiddenSpaces: Array.isArray(p.hiddenSpaces)
      ? p.hiddenSpaces.flatMap((k) => {
          const key = asJsonString(k);
          return key === undefined ? [] : [key];
        })
      : [],
    changesNested: asJsonBoolean(p.changesNested) ?? DEFAULTS.changesNested,
    changesDepth: coerceDepth(p.changesDepth),
    changesLayout: p.changesLayout === "tree" ? "tree" : DEFAULTS.changesLayout,
    beltScale: coerceBeltScale(p.beltScale),
    dashView: coerceDashView(p.dashView),
  };
}

function loadPrefs(): DashPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULTS };
    return coerceDashPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(prefs: DashPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore quota / SSR write errors — a lost layout preference is not worth a broken render.
  }
}

// ── The store ─────────────────────────────────────────────────────────────
let prefs: DashPrefs = loadPrefs();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getPrefs(): DashPrefs {
  return prefs;
}

/** Apply a patch to the shared prefs, persist it, and wake every subscriber. */
export function updateDashPrefs(patch: Partial<DashPrefs>): void {
  prefs = { ...prefs, ...patch };
  savePrefs(prefs);
  for (const fn of listeners) fn();
}

/** The prefs as they stand right now — for code that runs outside a render (the poll tick). */
export function dashPrefs(): DashPrefs {
  return prefs;
}

/** Whether Low power is on, readable from anywhere. The poll loop's input. */
export function lowPowerEnabled(): boolean {
  return prefs.lowPower;
}

/** Subscribe-to-the-flag hook for the one or two places that only need Low power. */
export function useLowPower(): boolean {
  return useSyncExternalStore(subscribe, lowPowerEnabled, lowPowerEnabled);
}

/** Test seam — the store is module state, so one case's pins would outlive it. */
export function __resetDashPrefs(): void {
  prefs = loadPrefs();
  for (const fn of listeners) fn();
}

export interface UseDashPrefsReturn {
  prefs: DashPrefs;
  setSpacesOpen: (open: boolean) => void;
  setShellsOpen: (open: boolean) => void;
  setLaunchOpen: (open: boolean) => void;
  setRecentDir: (dir: RecentDir) => void;
  /** Point the tab strip's "+" at a launcher row, or at a plain shell with `""`. */
  setNewTabLauncher: (command: string) => void;
  /** FORK: Low power on or off. */
  setLowPower: (on: boolean) => void;
  /** FORK: fold or open the usage section. */
  setQuotaOpen: (open: boolean) => void;
  setIsolatedSpace: (key: string | null) => void;
  toggleHiddenSpace: (key: string) => void;
  setChangesNested: (nested: boolean) => void;
  setChangesDepth: (depth: number) => void;
  setChangesLayout: (layout: ChangesLayout) => void;
  setBeltScale: (scale: number) => void;
  setDashView: (view: DashView) => void;
}

export function useDashPrefs(): UseDashPrefsReturn {
  const current = useSyncExternalStore(subscribe, getPrefs, getPrefs);

  const setSpacesOpen = useCallback((spacesOpen: boolean) => updateDashPrefs({ spacesOpen }), []);
  const setShellsOpen = useCallback((shellsOpen: boolean) => updateDashPrefs({ shellsOpen }), []);
  const setLaunchOpen = useCallback((launchOpen: boolean) => updateDashPrefs({ launchOpen }), []);
  const setRecentDir = useCallback((recentDir: RecentDir) => updateDashPrefs({ recentDir }), []);
  const setNewTabLauncher = useCallback(
    (newTabLauncher: string) => updateDashPrefs({ newTabLauncher }),
    [],
  );
  const setLowPower = useCallback((lowPower: boolean) => updateDashPrefs({ lowPower }), []);
  const setQuotaOpen = useCallback((quotaOpen: boolean) => updateDashPrefs({ quotaOpen }), []);

  const setChangesNested = useCallback((changesNested: boolean) => updateDashPrefs({ changesNested }), []);
  const setChangesDepth = useCallback((depth: number) => updateDashPrefs({ changesDepth: coerceDepth(depth) }), []);
  const setChangesLayout = useCallback((changesLayout: ChangesLayout) => updateDashPrefs({ changesLayout }), []);
  const setBeltScale = useCallback((scale: number) => updateDashPrefs({ beltScale: coerceBeltScale(scale) }), []);
  const setDashView = useCallback((dashView: DashView) => updateDashPrefs({ dashView }), []);

  const setIsolatedSpace = useCallback((isolatedSpace: string | null) => updateDashPrefs({ isolatedSpace }), []);
  // Reads the SHARED prefs rather than a render's snapshot: upstream's `setPrefs(p => …)` folded the
  // read into React's updater, which this fork's module store does not have. `prefs` here is the
  // store's own current value, so two chips toggled in one tick cannot lose each other's write.
  const toggleHiddenSpace = useCallback((key: string) => {
    const hidden = dashPrefs().hiddenSpaces;
    updateDashPrefs({
      hiddenSpaces: hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key],
    });
  }, []);

  return {
    prefs: current,
    setSpacesOpen,
    setShellsOpen,
    setLaunchOpen,
    setRecentDir,
    setNewTabLauncher,
    setLowPower,
    setQuotaOpen,
    setIsolatedSpace,
    toggleHiddenSpace,
    setChangesNested,
    setChangesDepth,
    setChangesLayout,
    setBeltScale,
    setDashView,
  };
}
