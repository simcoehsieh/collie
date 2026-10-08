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
      filesShowIgnored: false,
      changesOnly: false,
      beltScale: 1.15,
      dashView: "dashboard",
      needsYouOnly: false,
      showToolCalls: false,
      showCompactions: false,
      paneOrder: "place",
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
        filesShowIgnored: true,
        changesOnly: true,
        beltScale: 1.5,
        dashView: "changes",
        needsYouOnly: true,
        showToolCalls: true,
        paneOrder: "activity",
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
      filesShowIgnored: true,
      changesOnly: true,
      beltScale: 1.5,
      dashView: "changes",
      needsYouOnly: true,
      showToolCalls: true,
      showCompactions: false,
      paneOrder: "activity",
      paneView: "terminal",
    });
  });

  it("FORK: reads a non-boolean Low power as off, and drops the retired `pinned` list", () => {
    expect(coerceDashPrefs({ lowPower: "yes" }).lowPower).toBe(false);
    // The fork's own pins lived here until 1.14 took upstream's (lib/pins.ts, its own key). A blob a
    // device stored before then still carries the list; it is read by nothing and not kept.
    expect(coerceDashPrefs({ pinned: ["w1:p1"] })).not.toHaveProperty("pinned");
  });

  it("ignores a stored chatExperiment, whatever it holds (Chat is the default, ADR 0082)", () => {
    for (const stored of [true, false, "yes", null]) {
      const prefs = coerceDashPrefs({ chatExperiment: stored });
      expect(prefs).not.toHaveProperty("chatExperiment");
      expect(prefs.paneView).toBe("chat");
    }
    // A device that chose the terminal keeps it, with or without the old key beside it.
    expect(coerceDashPrefs({ chatExperiment: true, paneView: "terminal" }).paneView).toBe("terminal");
    expect(coerceDashPrefs({ paneView: "terminal" }).paneView).toBe("terminal");
  });

  it("keeps the Changes depth inside 1..4", () => {
    expect(coerceDashPrefs({ changesDepth: 9 }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesDepth: 0 }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesDepth: "3" }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesNested: "no" }).changesNested).toBe(true);
    expect(coerceDashPrefs({ changesLayout: "grid" }).changesLayout).toBe("list");
  });

  it("keeps the Files ignored switch to a boolean, off by default", () => {
    expect(coerceDashPrefs({}).filesShowIgnored).toBe(false);
    expect(coerceDashPrefs({ filesShowIgnored: true }).filesShowIgnored).toBe(true);
    expect(coerceDashPrefs({ filesShowIgnored: "yes" }).filesShowIgnored).toBe(false);
  });

  it("keeps the Changes segment's pref (changesOnly) to a boolean, off by default", () => {
    expect(coerceDashPrefs({}).changesOnly).toBe(false);
    expect(coerceDashPrefs({ changesOnly: true }).changesOnly).toBe(true);
    expect(coerceDashPrefs({ changesOnly: "yes" }).changesOnly).toBe(false);
  });

  it("keeps the dashboard tab to the three views, Dashboard by default", () => {
    expect(coerceDashPrefs({ dashView: "dashboard" }).dashView).toBe("dashboard");
    expect(coerceDashPrefs({ dashView: "crew" }).dashView).toBe("crew");
    expect(coerceDashPrefs({ dashView: "changes" }).dashView).toBe("changes");
    expect(coerceDashPrefs({ dashView: "all" }).dashView).toBe("dashboard");
    expect(coerceDashPrefs({ dashView: 2 }).dashView).toBe("dashboard");
  });

  // ADR 0085: no one loses their view. The first tab was renamed, and the Focus tab became a switch.
  it.each([
    ["panes", "dashboard", false],
    ["focus", "dashboard", true],
    ["needs", "dashboard", true],
    ["attention", "dashboard", true],
    ["dashboard", "dashboard", false],
    ["crew", "crew", false],
    ["changes", "changes", false],
    ["all", "dashboard", false],
  ] as const)("reads a stored dashView of %s as %s with the needs-you switch %s", (stored, view, on) => {
    const prefs = coerceDashPrefs({ dashView: stored });
    expect(prefs.dashView).toBe(view);
    expect(prefs.needsYouOnly).toBe(on);
  });

  it("keeps a stored needs-you switch, and a stored Focus turns it on over an explicit off", () => {
    expect(coerceDashPrefs({ needsYouOnly: true }).needsYouOnly).toBe(true);
    expect(coerceDashPrefs({ needsYouOnly: "yes" }).needsYouOnly).toBe(false);
    expect(coerceDashPrefs({ dashView: "focus", needsYouOnly: false }).needsYouOnly).toBe(true);
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
      filesShowIgnored: false,
      changesOnly: false,
      beltScale: 1.15,
      dashView: "dashboard",
      needsYouOnly: false,
      showToolCalls: false,
      showCompactions: false,
      paneOrder: "place",
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
      filesShowIgnored: false,
      changesOnly: false,
      beltScale: 1.15,
      dashView: "dashboard",
      needsYouOnly: false,
      showToolCalls: false,
      showCompactions: false,
      paneOrder: "place",
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
    act(() => first.result.current.setFilesShowIgnored(true));
    act(() => first.result.current.setChangesOnly(true));
    act(() => first.result.current.setBeltScale(1.3));
    act(() => first.result.current.setDashView("crew"));
    act(() => first.result.current.setNeedsYouOnly(true));
    act(() => first.result.current.setShowToolCalls(true));
    act(() => first.result.current.setPaneOrder("activity"));
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
      filesShowIgnored: true,
      changesOnly: true,
      beltScale: 1.3,
      dashView: "crew",
      needsYouOnly: true,
      showToolCalls: true,
      showCompactions: false,
      paneOrder: "activity",
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

  it("writes the migrated blob back once, so a stored Focus does not turn the switch on again", () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "focus", recentDir: "oldest" }));
    const first = renderHook(() => useDashPrefs());
    expect(first.result.current.prefs).toMatchObject({ dashView: "dashboard", needsYouOnly: true });
    expect(JSON.parse(localStorage.getItem("collie:dash-prefs:v1")!)).toMatchObject({
      dashView: "dashboard",
      needsYouOnly: true,
      recentDir: "oldest",
    });
    // The operator turns the switch off; a reload must not turn it back on.
    act(() => first.result.current.setNeedsYouOnly(false));
    const second = renderHook(() => useDashPrefs());
    expect(second.result.current.prefs).toMatchObject({ dashView: "dashboard", needsYouOnly: false });
  });

  it("FORK: a device that never opted into Chat keeps the terminal through the 1.17 flip, once", () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ chatExperiment: false, paneView: "chat" }));
    const first = renderHook(() => useDashPrefs());
    expect(first.result.current.prefs.paneView).toBe("terminal");
    const stored = JSON.parse(localStorage.getItem("collie:dash-prefs:v1")!);
    expect(stored.paneView).toBe("terminal");
    expect(stored).not.toHaveProperty("chatExperiment");
    // The ⋮ menu's switch then turns Chat on, and a reload keeps it.
    act(() => first.result.current.setPaneView("chat"));
    __resetDashPrefs();
    expect(renderHook(() => useDashPrefs()).result.current.prefs.paneView).toBe("chat");
  });

  it("FORK: a device that had opted into Chat keeps it", () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ chatExperiment: true, paneView: "chat" }));
    expect(renderHook(() => useDashPrefs()).result.current.prefs.paneView).toBe("chat");
  });

  it("leaves a stored crew choice alone", () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "crew" }));
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs.dashView).toBe("crew");
    expect(JSON.parse(localStorage.getItem("collie:dash-prefs:v1")!)).toEqual({ dashView: "crew" });
  });

  it("reads back a corrupt stored value as the defaults instead of throwing", () => {
    localStorage.setItem("collie:dash-prefs:v1", "{not json");
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs.recentDir).toBe("newest");
  });
});
