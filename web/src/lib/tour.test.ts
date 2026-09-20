import {
  __resetTourStore,
  TOUR_STORAGE_KEY,
  TOUR_REQUESTED,
  markTourSeen,
  resetTour,
  shouldShowTour,
  tourSeenVersion,
  TOUR_VERSION,
} from "./tour";

// The first-run screen's per-device store. The whole gate is `shouldShowTour(seen)`, so the value in
// storage has to be a number the app can compare — never a boolean, never JSON.
//
// FORK (2026-09-20): the gate answers true for the Settings row's sentinel and for nothing else.
// The cases below are the pins on that — a fresh device, a bumped version and a cleared storage all
// stay silent, and the one door still opens. See lib/tour.ts's header for why.

/** Re-import the module with storage already seeded, since `load()` runs once at module scope. */
async function loadWith(raw: string | null) {
  vi.resetModules();
  if (raw === null) localStorage.removeItem(TOUR_STORAGE_KEY);
  else localStorage.setItem(TOUR_STORAGE_KEY, raw);
  return await import("./tour");
}

describe("first-run store", () => {
  beforeEach(() => __resetTourStore());
  afterEach(() => __resetTourStore());

  it("starts unseen — and a fresh device is NOT shown the screen", () => {
    expect(tourSeenVersion()).toBe(0);
    expect(shouldShowTour(tourSeenVersion())).toBe(false);
  });

  it("marks it seen at this bundle's version, as a bare decimal string", () => {
    markTourSeen();
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe(String(TOUR_VERSION));
    expect(tourSeenVersion()).toBe(TOUR_VERSION);
    expect(shouldShowTour(tourSeenVersion())).toBe(false);
  });

  it("writes the sentinel on reset rather than removing the key, and that opens the screen", () => {
    markTourSeen();
    resetTour();
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe(String(TOUR_REQUESTED));
    expect(shouldShowTour(tourSeenVersion())).toBe(true);
  });

  // FORK: a version bump is exactly the case that used to greet the operator after a deployment
  // they made themselves. No number in the version space opens the screen any more.
  it("stays shut across a version bump, in both directions", () => {
    expect(shouldShowTour(TOUR_VERSION - 1)).toBe(false);
    expect(shouldShowTour(TOUR_VERSION)).toBe(false);
    expect(shouldShowTour(TOUR_VERSION + 1)).toBe(false);
  });

  it("opens for the sentinel and for nothing else", () => {
    expect(shouldShowTour(TOUR_REQUESTED)).toBe(true);
    for (const seen of [0, 1, 2, 3, 99, -2, -3]) expect(shouldShowTour(seen)).toBe(false);
  });

  it("reads an unparseable, empty or other-negative value as never-seen", async () => {
    for (const raw of ["", "yes", "{\"v\":1}", "-3"]) {
      const mod = await loadWith(raw);
      expect(mod.tourSeenVersion()).toBe(0);
    }
  });

  // FORK: the request has to survive a cold start — tapping "show it again" navigates home, and on
  // a PWA that can be a fresh document.
  it("reads the sentinel back after a reload, so the request survives", async () => {
    const mod = await loadWith(String(TOUR_REQUESTED));
    expect(mod.tourSeenVersion()).toBe(mod.TOUR_REQUESTED);
    expect(mod.shouldShowTour(mod.tourSeenVersion())).toBe(true);
  });

  it("reads a stored version back after a reload", async () => {
    const mod = await loadWith("1");
    expect(mod.tourSeenVersion()).toBe(1);
  });

  // FORK: upstream shows the new screen to a device that only ever saw the three-slide tour. This
  // install does not — the number is still read back, it just no longer decides anything.
  it("does not ambush a device that only ever saw the three-slide tour", async () => {
    const mod = await loadWith("1");
    expect(mod.TOUR_VERSION).toBe(2);
    expect(mod.tourSeenVersion()).toBe(1);
    expect(mod.shouldShowTour(mod.tourSeenVersion())).toBe(false);
  });

  it("notifies subscribers so the host repaints when the store is reset", () => {
    // useSyncExternalStore's subscribe is module-private; the observable effect is the same one the
    // Settings row depends on — a write reaches a reader that already read the old value.
    markTourSeen();
    const before = tourSeenVersion();
    resetTour();
    expect(before).not.toBe(tourSeenVersion());
  });
});
