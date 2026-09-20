import { useSyncExternalStore } from "react";

// Has this device seen the first-run screen, and which version of it. Per-device, like haptics and
// the typeface: a fact only the phone in your hand cares about, so there is no bridge field and no
// server-side record of who saw what.
//
// THE STORED VALUE IS A DECIMAL INTEGER STRING, never JSON and never a boolean — `"1"`, not
// `{"v":1}`. An absent or unparseable value reads as `0`.
//
// FORK — THE SCREEN NEVER OPENS BY ITSELF (2026-09-20). Upstream opens it on a device that has
// never seen it AND on every device whose stored number is behind `TOUR_VERSION`. On a fork that
// merges upstream every few days, the second half is the one that bites: a bumped version means the
// first-run screen greets the operator after a deployment they made themselves, on an install they
// have run for months. The operator's words were "why does opening the app always give me a Collie
// 'show dashboard' asking screen — pull it out".
//
// So "never seen" and "the operator asked to see it" stop being the same case, which is the one
// thing upstream's single zero cannot express. `resetTour()` now writes the sentinel
// `TOUR_REQUESTED` (-1) and `shouldShowTour` answers true for THAT AND NOTHING ELSE. The Settings
// row keeps working exactly as before — it is the only door in — and no automatic path can open the
// screen again: not a fresh device, not a cleared storage, not a version bump.
//
// THE BUMP RULE still governs `TOUR_VERSION` upstream-side, and `markTourSeen()` still stamps it,
// so the number keeps meaning "which screen this device last read" for anything that asks. It just
// no longer decides whether the screen appears.

/** The one place this key is spelled. The e2e seeder imports it rather than re-typing it. The `v1`
 *  in it names the STORE’s shape (a decimal integer), not the screen’s version — that is the
 *  number stored under it, so a new screen never needs a new key. */
export const TOUR_STORAGE_KEY = "collie:tour:v1";

/**
 * The first-run screen this bundle ships. A device that has seen a lower number is shown it once
 * more. Version 2 is the single scrolling screen that replaced the three-slide tour: every claim on
 * it is new, and most of them are now facts about this install, so every device earns one more look.
 */
export const TOUR_VERSION = 2;

/**
 * FORK: the one value that opens the screen. Negative on purpose — the version space is positive,
 * so no bump and no stored history can ever collide with it, and a device that has genuinely never
 * seen the screen (`0`) stays distinct from one whose operator just asked for it.
 */
export const TOUR_REQUESTED = -1;

/** The version this device last saw, `0` for "never" and `TOUR_REQUESTED` for "asked to see it". */
let seen = load();
const listeners = new Set<() => void>();

function load(): number {
  // try/catch IS the environment probe: a `localStorage` that does not exist throws on the read,
  // and private mode throws on some browsers even where it does. Either way, never seen.
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    // FORK: the sentinel survives a reload — an operator who taps "show it again" and lands on a
    // cold start must still get the screen. Every OTHER non-positive value is still never-seen.
    if (parsed === TOUR_REQUESTED) return TOUR_REQUESTED;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0; // private mode / SSR
  }
}

function write(version: number): void {
  seen = version;
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, String(version));
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session, so the
    // tour does not re-open behind the operator's back on a revalidation.
  }
  for (const fn of listeners) fn();
}

export function tourSeenVersion(): number {
  return seen;
}

/** Called from exactly one place: the effect in `TourHost` that OPENS the screen. Never on close. */
export function markTourSeen(): void {
  write(TOUR_VERSION);
}

/** The Settings row's "show it again" — FORK: writes the sentinel, not `"0"`. It is the ONLY
 *  caller, and therefore the only way the screen is ever shown. It does not remove the key. */
export function resetTour(): void {
  write(TOUR_REQUESTED);
}

/**
 * FORK: only an explicit request opens the screen. Upstream's `seenVersion < TOUR_VERSION` also
 * fired for a fresh device and for every device left behind by a version bump — see the file
 * header for why a fork that deploys upstream weekly cannot live with the second one.
 */
export function shouldShowTour(seenVersion: number): boolean {
  return seenVersion === TOUR_REQUESTED;
}

/** Reactive read for the host. Module-scoped store, mirroring lib/haptics.ts. */
export function useTourSeen(): number {
  return useSyncExternalStore(subscribe, tourSeenVersion, () => 0);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam — resets the module store to "never seen" between cases. */
export function __resetTourStore(): void {
  seen = 0;
  try {
    localStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
