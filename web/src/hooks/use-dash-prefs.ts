import { useCallback, useSyncExternalStore } from "react";
import { asJsonBoolean, asJsonObject, type JsonValue } from "@/lib/json";

import type { RecentDir } from "@/lib/triage";

// Dashboard layout preferences, persisted in localStorage. Deliberately separate from
// use-display-prefs (which is about the terminal mirror) — these are about the herd list.
// Safe in SSR contexts: every localStorage touch is guarded.
//
// FORK: ONE STORE, NOT ONE STATE PER HOOK CALL. Upstream held the prefs in `useState` inside
// `useDashPrefs`, which was fine while the dashboard was the only reader. Two of the fork's
// additions read the same prefs from two different places at once — the pinned order is applied by
// the dashboard and edited from a sheet the dashboard owns, and Low power is flipped in Settings but
// read by the poll loop under the root layout — so a per-instance state would have let Settings say
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
  /** Whether the Recent section is expanded. Defaults open — it's the recency list itself. */
  recentOpen: boolean;
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
   * FORK: pane ids the operator pinned to the top of the dashboard, in the order they chose.
   *
   * Pane IDS, not row keys: a pin is a per-device statement about a terminal the operator keeps
   * coming back to, and on a solo install the id is the whole address. A pinned id the snapshot no
   * longer carries is simply not rendered (lib/triage.ts skips it) rather than pruned on sight —
   * a pane can vanish for one poll during a bridge restart, and un-pinning it for that would be a
   * pin that forgets itself. It IS pruned when the operator next edits the list, which is the one
   * moment the list is known to be looked at.
   */
  pinned: string[];
  /**
   * FORK: Low power. Widens the poll gaps (hooks/use-polling.ts) while a mirror is followed —
   * 1 Hz becomes a third of that, a send's burst a tenth of a second slower — and leaves the live
   * feed alone, because one open stream is cheaper than the polls it replaces. Off by default: the
   * fast cadence is the product, and this is the operator saying "not today".
   */
  lowPower: boolean;
  /** FORK: the dashboard's usage section (components/quota-card.tsx), open unless folded. */
  quotaOpen: boolean;
}

const STORAGE_KEY = "collie:dash-prefs:v1";

/** Above this many rows, an un-chosen foldable section starts collapsed. */
export const COLLAPSE_THRESHOLD = 8;

const DEFAULTS: DashPrefs = {
  spacesOpen: null,
  shellsOpen: null,
  launchOpen: null,
  recentOpen: true,
  recentDir: "newest",
  newTabLauncher: "",
  pinned: [],
  lowPower: false,
  quotaOpen: true,
};

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

/** A stored pinned list, or the default: strings only, de-duplicated, order kept. */
function coercePinned(raw: JsonValue | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v !== "" && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Coerce an untrusted parsed value into {@link DashPrefs}, filling anything missing or wrong-typed
 * from the defaults. Pure + exported so the file-shape handling is unit-tested.
 */
export function coerceDashPrefs(raw: JsonValue | undefined): DashPrefs {
  const p = asJsonObject(raw);
  if (!p) return { ...DEFAULTS, pinned: [] };
  return {
    spacesOpen: asJsonBoolean(p.spacesOpen) ?? DEFAULTS.spacesOpen,
    shellsOpen: asJsonBoolean(p.shellsOpen) ?? DEFAULTS.shellsOpen,
    launchOpen: asJsonBoolean(p.launchOpen) ?? DEFAULTS.launchOpen,
    recentOpen: asJsonBoolean(p.recentOpen) ?? DEFAULTS.recentOpen,
    recentDir: p.recentDir === "oldest" || p.recentDir === "newest" ? p.recentDir : DEFAULTS.recentDir,
    // A string of unknown provenance, and it is NOT validated against the current launcher rows
    // here: this store has never read that file and the rows are per-host anyway. An unknown
    // command resolves to nothing at the call site and falls back to the shell.
    newTabLauncher: typeof p.newTabLauncher === "string" ? p.newTabLauncher : DEFAULTS.newTabLauncher,
    pinned: coercePinned(p.pinned),
    lowPower: asJsonBoolean(p.lowPower) ?? DEFAULTS.lowPower,
    quotaOpen: asJsonBoolean(p.quotaOpen) ?? DEFAULTS.quotaOpen,
  };
}

function loadPrefs(): DashPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULTS, pinned: [] };
    return coerceDashPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS, pinned: [] };
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

/**
 * Pin a pane, or un-pin it. Pinning appends to the END of the pinned order, so a fresh pin lands
 * under the ones the operator already arranged rather than shoving them down.
 */
export function setPinned(paneId: string, on: boolean, known?: readonly string[]): void {
  const current = prunePinned(prefs.pinned, known);
  const without = current.filter((id) => id !== paneId);
  updateDashPrefs({ pinned: on ? [...without, paneId] : without });
}

/** Move a pinned pane one step up (`-1`) or down (`+1`). A move off either end is a no-op. */
export function movePinned(paneId: string, delta: -1 | 1, known?: readonly string[]): void {
  const current = prunePinned(prefs.pinned, known);
  const from = current.indexOf(paneId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= current.length) return;
  const next = [...current];
  next.splice(from, 1);
  next.splice(to, 0, paneId);
  updateDashPrefs({ pinned: next });
}

/**
 * The pinned list with ids the snapshot no longer knows dropped — applied lazily, at edit time only
 * (see the field's note). `known` absent means "prune nothing".
 */
export function prunePinned(pinned: readonly string[], known?: readonly string[]): string[] {
  if (known === undefined) return [...pinned];
  const keep = new Set(known);
  return pinned.filter((id) => keep.has(id));
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
  setRecentOpen: (open: boolean) => void;
  setRecentDir: (dir: RecentDir) => void;
  /** Point the tab strip's "+" at a launcher row, or at a plain shell with `""`. */
  setNewTabLauncher: (command: string) => void;
  /** FORK: pin or un-pin a pane on the dashboard. */
  setPinned: (paneId: string, on: boolean, known?: readonly string[]) => void;
  /** FORK: reorder within the pinned rows. */
  movePinned: (paneId: string, delta: -1 | 1, known?: readonly string[]) => void;
  /** FORK: Low power on or off. */
  setLowPower: (on: boolean) => void;
  /** FORK: fold or open the usage section. */
  setQuotaOpen: (open: boolean) => void;
}

export function useDashPrefs(): UseDashPrefsReturn {
  const current = useSyncExternalStore(subscribe, getPrefs, getPrefs);

  const setSpacesOpen = useCallback((spacesOpen: boolean) => updateDashPrefs({ spacesOpen }), []);
  const setShellsOpen = useCallback((shellsOpen: boolean) => updateDashPrefs({ shellsOpen }), []);
  const setLaunchOpen = useCallback((launchOpen: boolean) => updateDashPrefs({ launchOpen }), []);
  const setRecentOpen = useCallback((recentOpen: boolean) => updateDashPrefs({ recentOpen }), []);
  const setRecentDir = useCallback((recentDir: RecentDir) => updateDashPrefs({ recentDir }), []);
  const setNewTabLauncher = useCallback(
    (newTabLauncher: string) => updateDashPrefs({ newTabLauncher }),
    [],
  );
  const setLowPower = useCallback((lowPower: boolean) => updateDashPrefs({ lowPower }), []);
  const setQuotaOpen = useCallback((quotaOpen: boolean) => updateDashPrefs({ quotaOpen }), []);

  return {
    prefs: current,
    setSpacesOpen,
    setShellsOpen,
    setLaunchOpen,
    setRecentOpen,
    setRecentDir,
    setNewTabLauncher,
    setPinned,
    movePinned,
    setLowPower,
    setQuotaOpen,
  };
}
