import { useCallback, useSyncExternalStore } from "react";
import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";

import type { ChangesLayout } from "@/lib/changes-tree";
import { coerceDashView, isLegacyDashView, wasFocusView, type DashView } from "@/lib/dash-view";
import { coercePaneOrder, type PaneOrder } from "@/lib/pane-order";
import { coercePaneView, type PaneView, DEFAULT_PANE_VIEW } from "@/lib/pane-view";
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
   * Whether the Files view lists the entries git ignores (ADR 0083). OFF by default: `node_modules`,
   * build output and logs bury the files an operator came to read. Per device, and it outlives the
   * folder: the name filter resets with each folder, this choice does not.
   */
  filesShowIgnored: boolean;
  /**
   * Whether the Changes screen shows the changed files only, as a flat list or a tree of them, rather
   * than the root folder with each change marked on its row (ADR 0083, 2026-10-06). OFF by default:
   * the folder with its marks shows both what changed and what sits beside it. Per device, beside
   * {@link filesShowIgnored}.
   */
  changesOnly: boolean;
  /**
   * The composer's action belt size, one factor for the whole belt: band, pills, icons and words
   * all grow from it together (`--belt-scale`, `components/actions-row.tsx`). One of
   * {@link BELT_SCALES}. 1.15 is the baseline Altan asked for on 2026-09-23 ("slightly higher and
   * the icons slightly larger, like 15%"); the other two are the Settings row's way up from there.
   */
  beltScale: BeltScale;
  /** The dashboard's footer tab: Dashboard, Crew or Changes (ADR 0085). Dashboard by default. */
  dashView: DashView;
  /**
   * The Dashboard's "needs you" switch (ADR 0085, the old Focus tab): on, each workspace shows only
   * its panes that need you. Per device, off by default. A device that had the Focus tab selected
   * reads as on, once (see {@link coerceDashPrefs}).
   */
  needsYouOnly: boolean;
  /**
   * Whether a session view draws the agent's tool calls: the reads, the searches, the commands and
   * the edits it ran between saying things.
   *
   * OFF by default, and that is the decision rather than an accident. A working session is mostly
   * tool calls — a single turn can be forty reads and a grep — so a transcript that draws them all
   * is a transcript you scroll past to find the one paragraph you came for. What the agent SAID is
   * what the page is for; what it DID is available in one tap.
   *
   * Read by the History page today (components/transcript-view.tsx) and by the Chat stream when it
   * lands. One pref for both: two settings for one idea is how they drift apart.
   */
  showToolCalls: boolean;
  /**
   * Whether a session view keeps the recap the agent writes when it compacts its own context.
   *
   * OFF by default, for the reason Claude Code's own UI folds it: the recap is thousands of
   * characters the agent wrote for ITSELF, and a phone has no use for it. Off draws one marker line
   * where the compaction happened and never builds the text; on folds the recap behind that marker.
   * Read by the Chat stream and the History page, as {@link showToolCalls} is.
   */
  showCompactions: boolean;
  /**
   * The order a pane list runs in: `place` (machine, space, tab, position) or `activity` (whatever
   * happened last, first). PLACE by default, which is the order ADR 0063 gave every surface.
   *
   * The operator's own request is the only thing that turns this on, and ADR 0071 holds the reason
   * the list does not then re-sort itself on a poll: the reading is taken when the list opens and
   * held while it is on screen. See lib/pane-order.ts, which owns both halves.
   *
   * Read by the pane switcher today (components/agent-sidebar.tsx).
   */
  paneOrder: PaneOrder;
  /**
   * Which body a pane with a session draws: the chat stream or the terminal mirror. One standing
   * value for the whole device, written from the pane's ⋮ menu alone. `chat` by default since 1.17.0
   * (ADR 0082); a device that chose the terminal keeps it.
   *
   * See lib/pane-view.ts for why it is one per-device value and not a per-pane override.
   */
  paneView: PaneView;
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
  filesShowIgnored: false,
  changesOnly: false,
  beltScale: 1.15,
  dashView: "dashboard",
  needsYouOnly: false,
  showToolCalls: false,
  showCompactions: false,
  paneOrder: "place",
  paneView: DEFAULT_PANE_VIEW,
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
    filesShowIgnored: asJsonBoolean(p.filesShowIgnored) ?? DEFAULTS.filesShowIgnored,
    changesOnly: asJsonBoolean(p.changesOnly) ?? DEFAULTS.changesOnly,
    beltScale: coerceBeltScale(p.beltScale),
    dashView: coerceDashView(p.dashView),
    // THE FOCUS MIGRATION (ADR 0085): a stored Focus tab turns the switch on, so no one loses the
    // view they had. An explicit stored value wins otherwise.
    needsYouOnly: wasFocusView(p.dashView) ? true : (asJsonBoolean(p.needsYouOnly) ?? DEFAULTS.needsYouOnly),
    showToolCalls: asJsonBoolean(p.showToolCalls) ?? DEFAULTS.showToolCalls,
    showCompactions: asJsonBoolean(p.showCompactions) ?? DEFAULTS.showCompactions,
    paneOrder: coercePaneOrder(p.paneOrder),
    paneView: coercePaneView(p.paneView),
  };
}

function loadPrefs(): DashPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULTS };
    const parsed: JsonValue = JSON.parse(raw);
    const prefs = coerceDashPrefs(parsed);
    // A retired tab name is written back migrated, so the Focus migration happens once: the switch is
    // then stored as its own value and the old name is gone.
    const stored = asJsonObject(parsed);
    // FORK: THE CHAT FLIP KEEPS THIS DEVICE'S BODY (2026-10-08, at the 1.17 merge). 1.17.0 made Chat
    // the default and ignores the old opt-in, so a device that never turned Chat on in Settings →
    // Experiments would flip to Chat on update. A blob that says it never opted in (`chatExperiment`
    // stored false) is migrated once to the terminal it was showing; the ⋮ menu's body switch still
    // turns Chat on. A fresh device, and one that had opted in, get upstream's default.
    if (stored && stored.chatExperiment === false && stored.paneView !== "terminal") {
      prefs.paneView = "terminal";
      savePrefs(prefs);
    } else if (stored && isLegacyDashView(stored.dashView)) savePrefs(prefs);
    return prefs;
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
// Loaded on first read, not at import: a test that writes the stored blob and then renders (upstream's
// own way, which assumed a per-hook state) is read the same way a reset-and-read one is.
let loaded: DashPrefs | null = null;
function storedPrefs(): DashPrefs {
  return (loaded ??= loadPrefs());
}
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getPrefs(): DashPrefs {
  return storedPrefs();
}

/** Apply a patch to the shared prefs, persist it, and wake every subscriber. */
export function updateDashPrefs(patch: Partial<DashPrefs>): void {
  loaded = { ...storedPrefs(), ...patch };
  savePrefs(loaded);
  for (const fn of listeners) fn();
}

/** The prefs as they stand right now — for code that runs outside a render (the poll tick). */
export function dashPrefs(): DashPrefs {
  return storedPrefs();
}

/** Whether Low power is on, readable from anywhere. The poll loop's input. */
export function lowPowerEnabled(): boolean {
  return storedPrefs().lowPower;
}

/** Subscribe-to-the-flag hook for the one or two places that only need Low power. */
export function useLowPower(): boolean {
  return useSyncExternalStore(subscribe, lowPowerEnabled, lowPowerEnabled);
}

/** Test seam — the store is module state, so one case's pins would outlive it. */
export function __resetDashPrefs(): void {
  loaded = null;
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
  setFilesShowIgnored: (show: boolean) => void;
  setChangesOnly: (only: boolean) => void;
  setBeltScale: (scale: number) => void;
  setDashView: (view: DashView) => void;
  setNeedsYouOnly: (on: boolean) => void;
  setShowToolCalls: (show: boolean) => void;
  setShowCompactions: (show: boolean) => void;
  setPaneOrder: (order: PaneOrder) => void;
  setPaneView: (view: PaneView) => void;
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
  const setFilesShowIgnored = useCallback(
    (filesShowIgnored: boolean) => updateDashPrefs({ filesShowIgnored }),
    [],
  );
  const setChangesOnly = useCallback((changesOnly: boolean) => updateDashPrefs({ changesOnly }), []);
  const setBeltScale = useCallback((scale: number) => updateDashPrefs({ beltScale: coerceBeltScale(scale) }), []);
  const setDashView = useCallback((dashView: DashView) => updateDashPrefs({ dashView }), []);
  const setNeedsYouOnly = useCallback((needsYouOnly: boolean) => updateDashPrefs({ needsYouOnly }), []);
  const setShowToolCalls = useCallback((showToolCalls: boolean) => updateDashPrefs({ showToolCalls }), []);
  const setShowCompactions = useCallback((showCompactions: boolean) => updateDashPrefs({ showCompactions }), []);
  const setPaneOrder = useCallback((paneOrder: PaneOrder) => updateDashPrefs({ paneOrder }), []);
  const setPaneView = useCallback((paneView: PaneView) => updateDashPrefs({ paneView }), []);

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
    setFilesShowIgnored,
    setChangesOnly,
    setBeltScale,
    setDashView,
    setNeedsYouOnly,
    setShowToolCalls,
    setShowCompactions,
    setPaneOrder,
    setPaneView,
  };
}
