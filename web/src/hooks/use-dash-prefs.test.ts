import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  coerceDashPrefs,
  COLLAPSE_THRESHOLD,
  openForCount,
  useDashPrefs,
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
      }),
    ).toEqual({
      spacesOpen: false,
      shellsOpen: true,
      launchOpen: false,
      recentOpen: false,
      recentDir: "oldest",
      newTabLauncher: "claude",
    });
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
  beforeEach(() => localStorage.clear());

  it("starts at the defaults", () => {
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs).toEqual({
      spacesOpen: null,
      shellsOpen: null,
      launchOpen: null,
      recentOpen: true,
      recentDir: "newest",
      newTabLauncher: "",
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

    const second = renderHook(() => useDashPrefs());
    expect(second.result.current.prefs).toEqual({
      spacesOpen: true,
      shellsOpen: true,
      launchOpen: false,
      recentOpen: false,
      recentDir: "oldest",
      newTabLauncher: "claude",
    });
  });

  it("reads back a corrupt stored value as the defaults instead of throwing", () => {
    localStorage.setItem("collie:dash-prefs:v1", "{not json");
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs.recentDir).toBe("newest");
  });
});
