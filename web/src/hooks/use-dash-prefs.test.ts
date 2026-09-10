import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  __resetDashPrefs,
  coerceDashPrefs,
  COLLAPSE_THRESHOLD,
  movePinned,
  openForCount,
  prunePinned,
  setPinned,
  useDashPrefs,
  useLowPower,
} from "./use-dash-prefs";

describe("openForCount", () => {
  it("starts expanded on a small install", () => {
    expect(openForCount(null, 2)).toBe(true);
    expect(openForCount(null, COLLAPSE_THRESHOLD)).toBe(true);
  });

  it("starts collapsed once the list is a wall", () => {
    expect(openForCount(null, COLLAPSE_THRESHOLD + 1)).toBe(false);
    expect(openForCount(null, 45)).toBe(false);
  });

  it("an explicit choice always beats the threshold, in both directions", () => {
    expect(openForCount(true, 45)).toBe(true);
    expect(openForCount(false, 1)).toBe(false);
  });
});

describe("coerceDashPrefs", () => {
  it("defaults an empty object", () => {
    expect(coerceDashPrefs({})).toEqual({
      spacesOpen: null,
      shellsOpen: null,
      launchOpen: null,
      recentOpen: true,
      recentDir: "newest",
      // `""` is "a plain shell", which is what the tab strip's "+" has always opened.
      newTabLauncher: "",
      pinned: [],
      lowPower: false,
    });
  });

  it("keeps valid values", () => {
    expect(
      coerceDashPrefs({
        spacesOpen: false,
        shellsOpen: true,
        launchOpen: false,
        recentOpen: false,
        recentDir: "oldest",
        newTabLauncher: "claude",
        pinned: ["w1:p1", "w2:p3"],
        lowPower: true,
      }),
    ).toEqual({
      spacesOpen: false,
      shellsOpen: true,
      launchOpen: false,
      recentOpen: false,
      recentDir: "oldest",
      newTabLauncher: "claude",
      pinned: ["w1:p1", "w2:p3"],
      lowPower: true,
    });
  });

  it("FORK: keeps a pinned list as strings only, de-duplicated, in order", () => {
    expect(coerceDashPrefs({ pinned: ["a", 3, "b", "a", ""] }).pinned).toEqual(["a", "b"]);
    expect(coerceDashPrefs({ pinned: "a" }).pinned).toEqual([]);
    expect(coerceDashPrefs({ lowPower: "yes" }).lowPower).toBe(false);
  });

  it("rejects a bogus direction rather than trusting it", () => {
    expect(coerceDashPrefs({ recentDir: "sideways" }).recentDir).toBe("newest");
  });

  it("takes any string as the pinned launcher, and anything else as none", () => {
    // NOT validated against the current rows here: this store has never read `launchers.toml`, and
    // the rows are per-host anyway. An unknown command resolves to nothing at the call site
    // (`pinnedLauncher`, lib/launchers.ts) and falls back to the shell.
    expect(coerceDashPrefs({ newTabLauncher: "codex --profile work" }).newTabLauncher).toBe(
      "codex --profile work",
    );
    expect(coerceDashPrefs({ newTabLauncher: 7 }).newTabLauncher).toBe("");
  });

  it("survives garbage", () => {
    expect(coerceDashPrefs(null).recentDir).toBe("newest");
    expect(coerceDashPrefs("nope").recentOpen).toBe(true);
    expect(coerceDashPrefs({ spacesOpen: "yes" }).spacesOpen).toBeNull();
    expect(coerceDashPrefs({ launchOpen: 1 }).launchOpen).toBeNull();
  });
});

describe("useDashPrefs", () => {
  // FORK: the prefs are one module store now, so a case's writes would outlive it without this.
  beforeEach(() => {
    localStorage.clear();
    __resetDashPrefs();
  });

  it("starts at the defaults", () => {
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs).toEqual({
      spacesOpen: null,
      shellsOpen: null,
      launchOpen: null,
      recentOpen: true,
      recentDir: "newest",
      newTabLauncher: "",
      pinned: [],
      lowPower: false,
    });
  });

  it("persists each setting across a remount", () => {
    const first = renderHook(() => useDashPrefs());
    act(() => first.result.current.setSpacesOpen(true));
    act(() => first.result.current.setShellsOpen(true));
    act(() => first.result.current.setLaunchOpen(false));
    act(() => first.result.current.setRecentOpen(false));
    act(() => first.result.current.setRecentDir("oldest"));
    act(() => first.result.current.setNewTabLauncher("claude"));
    act(() => first.result.current.setLowPower(true));
    act(() => first.result.current.setPinned("w1:p1", true));

    // A remount AND a fresh page (the store re-reads storage) both see the same values.
    __resetDashPrefs();
    const second = renderHook(() => useDashPrefs());
    expect(second.result.current.prefs).toEqual({
      spacesOpen: true,
      shellsOpen: true,
      launchOpen: false,
      recentOpen: false,
      recentDir: "oldest",
      newTabLauncher: "claude",
      pinned: ["w1:p1"],
      lowPower: true,
    });
  });

  it("FORK: two readers see one write in the same tick — it is one store, not one state per hook", () => {
    const a = renderHook(() => useDashPrefs());
    const b = renderHook(() => useLowPower());
    expect(b.result.current).toBe(false);
    act(() => a.result.current.setLowPower(true));
    expect(b.result.current).toBe(true);
  });

  it("reads back a corrupt stored value as the defaults instead of throwing", () => {
    localStorage.setItem("collie:dash-prefs:v1", "{not json");
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs.recentDir).toBe("newest");
  });
});

describe("FORK: pins", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetDashPrefs();
  });

  it("a new pin lands at the END of the order, and un-pinning removes it", () => {
    const { result } = renderHook(() => useDashPrefs());
    act(() => setPinned("a", true));
    act(() => setPinned("b", true));
    expect(result.current.prefs.pinned).toEqual(["a", "b"]);
    act(() => setPinned("a", false));
    expect(result.current.prefs.pinned).toEqual(["b"]);
  });

  it("moves a pin one step, and a move off either end is a no-op", () => {
    const { result } = renderHook(() => useDashPrefs());
    act(() => setPinned("a", true));
    act(() => setPinned("b", true));
    act(() => setPinned("c", true));
    act(() => movePinned("c", -1));
    expect(result.current.prefs.pinned).toEqual(["a", "c", "b"]);
    act(() => movePinned("a", -1));
    expect(result.current.prefs.pinned).toEqual(["a", "c", "b"]);
    act(() => movePinned("b", 1));
    expect(result.current.prefs.pinned).toEqual(["a", "c", "b"]);
  });

  it("prunes ids the herd no longer holds — at edit time, never on read", () => {
    const { result } = renderHook(() => useDashPrefs());
    act(() => setPinned("gone", true));
    act(() => setPinned("a", true));
    // Reading changes nothing: a pane can be absent for one poll during a restart.
    expect(result.current.prefs.pinned).toEqual(["gone", "a"]);
    expect(prunePinned(["gone", "a"], ["a"])).toEqual(["a"]);
    // An edit with the herd in hand drops it.
    act(() => setPinned("b", true, ["a", "b"]));
    expect(result.current.prefs.pinned).toEqual(["a", "b"]);
  });
});
