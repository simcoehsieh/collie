import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  __resetDashPrefs,
  coerceDashPrefs,
  COLLAPSE_THRESHOLD,
  openForCount,
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
      recentDir: "newest",
      // `""` is "a plain shell", which is what the tab strip's "+" has always opened.
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
      showToolCalls: false,
      showCompactions: false,
      paneOrder: "place",
      chatExperiment: false,
      paneView: "chat",
    });
  });

  it("keeps valid values", () => {
    expect(
      coerceDashPrefs({
        spacesOpen: false,
        shellsOpen: true,
        launchOpen: false,
        recentDir: "oldest",
        newTabLauncher: "claude",
        lowPower: true,
        quotaOpen: false,
        isolatedSpace: "k1",
        hiddenSpaces: ["k2", 3, "k3"],
        changesNested: false,
        changesDepth: 4,
        changesLayout: "tree",
        beltScale: 1.5,
        dashView: "changes",
        showToolCalls: true,
        paneOrder: "activity",
        chatExperiment: true,
        paneView: "terminal",
      }),
    ).toEqual({
      spacesOpen: false,
      shellsOpen: true,
      launchOpen: false,
      recentDir: "oldest",
      newTabLauncher: "claude",
      lowPower: true,
      quotaOpen: false,
      isolatedSpace: "k1",
      hiddenSpaces: ["k2", "k3"],
      changesNested: false,
      changesDepth: 4,
      changesLayout: "tree",
      beltScale: 1.5,
      dashView: "changes",
      showToolCalls: true,
      showCompactions: false,
      paneOrder: "activity",
      chatExperiment: true,
      paneView: "terminal",
    });
  });

  it("FORK: reads a non-boolean Low power as off, and drops the retired `pinned` list", () => {
    expect(coerceDashPrefs({ lowPower: "yes" }).lowPower).toBe(false);
    // The fork's own pins lived here until 1.14 took upstream's (lib/pins.ts, its own key). A blob a
    // device stored before then still carries the list; it is read by nothing and not kept.
    expect(coerceDashPrefs({ pinned: ["w1:p1"] })).not.toHaveProperty("pinned");
  });

  it("keeps the Changes depth inside 1..4", () => {
    expect(coerceDashPrefs({ changesDepth: 9 }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesDepth: 0 }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesDepth: "3" }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesNested: "no" }).changesNested).toBe(true);
    expect(coerceDashPrefs({ changesLayout: "grid" }).changesLayout).toBe("list");
  });

  it("keeps the dashboard tab to the three views, Panes by default", () => {
    expect(coerceDashPrefs({ dashView: "focus" }).dashView).toBe("focus");
    expect(coerceDashPrefs({ dashView: "all" }).dashView).toBe("panes");
    expect(coerceDashPrefs({ dashView: 2 }).dashView).toBe("panes");
  });

  it("reads a pre-rename dashView value as focus (ADR 0068)", () => {
    expect(coerceDashPrefs({ dashView: "needs" }).dashView).toBe("focus");
    expect(coerceDashPrefs({ dashView: "attention" }).dashView).toBe("focus");
  });

  it("keeps the belt size to the three offered scales", () => {
    expect(coerceDashPrefs({ beltScale: 1.3 }).beltScale).toBe(1.3);
    expect(coerceDashPrefs({ beltScale: 2 }).beltScale).toBe(1.15);
    expect(coerceDashPrefs({ beltScale: "1.5" }).beltScale).toBe(1.15);
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
    expect(coerceDashPrefs("nope").recentDir).toBe("newest");
    expect(coerceDashPrefs({ spacesOpen: "yes" }).spacesOpen).toBeNull();
    expect(coerceDashPrefs({ launchOpen: 1 }).launchOpen).toBeNull();
  });

  it("ignores a retired `recentOpen` key from an older version's stored blob", () => {
    // The Recent fold this once toggled is gone (agent-list.tsx no longer sorts into it), so the
    // key is dropped from DashPrefs — but a device that saved it under an older Collie must still
    // parse today, with the rest of its stored choices intact.
    expect(
      coerceDashPrefs({ spacesOpen: true, recentOpen: false, recentDir: "oldest" }),
    ).toMatchObject({
      spacesOpen: true,
      shellsOpen: null,
      launchOpen: null,
      recentDir: "oldest",
      isolatedSpace: null,
      hiddenSpaces: [],
      changesNested: true,
      changesDepth: 2,
      changesLayout: "list",
      beltScale: 1.15,
      dashView: "panes",
      showToolCalls: false,
      showCompactions: false,
      paneOrder: "place",
      chatExperiment: false,
      paneView: "chat",
    });
    // FORK: toMatchObject, not toEqual — this fork's DashPrefs carries fields upstream's does not
    // (the new-tab launcher, low power, the quota fold). What the case pins is unchanged: the rest of
    // the stored choices survive, and the retired key is not carried along.
    expect(coerceDashPrefs({ spacesOpen: true, recentOpen: false, recentDir: "oldest" })).not.toHaveProperty(
      "recentOpen",
    );
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
      showToolCalls: false,
      showCompactions: false,
      paneOrder: "place",
      chatExperiment: false,
      paneView: "chat",
    });
  });

  it("persists each setting across a remount", () => {
    const first = renderHook(() => useDashPrefs());
    act(() => first.result.current.setSpacesOpen(true));
    act(() => first.result.current.setShellsOpen(true));
    act(() => first.result.current.setLaunchOpen(false));
    act(() => first.result.current.setRecentDir("oldest"));
    act(() => first.result.current.setNewTabLauncher("claude"));
    act(() => first.result.current.setLowPower(true));
    act(() => first.result.current.setQuotaOpen(false));
    act(() => first.result.current.setIsolatedSpace("k1"));
    act(() => first.result.current.toggleHiddenSpace("k2"));
    act(() => first.result.current.toggleHiddenSpace("k3"));
    act(() => first.result.current.toggleHiddenSpace("k2"));
    act(() => first.result.current.setChangesNested(false));
    act(() => first.result.current.setChangesDepth(3));
    act(() => first.result.current.setChangesLayout("tree"));
    act(() => first.result.current.setBeltScale(1.3));
    act(() => first.result.current.setDashView("focus"));
    act(() => first.result.current.setShowToolCalls(true));
    act(() => first.result.current.setPaneOrder("activity"));
    act(() => first.result.current.setChatExperiment(true));
    act(() => first.result.current.setPaneView("terminal"));

    // A remount AND a fresh page (the store re-reads storage) both see the same values.
    __resetDashPrefs();
    const second = renderHook(() => useDashPrefs());
    expect(second.result.current.prefs).toEqual({
      spacesOpen: true,
      shellsOpen: true,
      launchOpen: false,
      recentDir: "oldest",
      newTabLauncher: "claude",
      lowPower: true,
      quotaOpen: false,
      isolatedSpace: "k1",
      hiddenSpaces: ["k3"],
      changesNested: false,
      changesDepth: 3,
      changesLayout: "tree",
      beltScale: 1.3,
      dashView: "focus",
      showToolCalls: true,
      showCompactions: false,
      paneOrder: "activity",
      chatExperiment: true,
      paneView: "terminal",
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
