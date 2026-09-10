import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NOTIFY_PREFS,
  NotifyPrefsStore,
  coerceNotifyPrefs,
  coercePaneRule,
  parseNotifyPrefsPatch,
  ruleFor,
  type PaneIdentity,
} from "./notify-prefs.ts";
import { loadConfig } from "./config.ts";

// Notify-type prefs own which agent statuses push. The coercion is pure; the merge + disk round-trip
// is verified through a throwaway temp state dir (mirrors snooze.test.ts / push.test.ts).

const dirs: string[] = [];
async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-notify-prefs-"));
  dirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const defaults = { blocked: true, done: false, updates: true, panes: [] };

describe("coerceNotifyPrefs", () => {
  test("fills missing / non-boolean keys from defaults", () => {
    expect(coerceNotifyPrefs(undefined)).toEqual(defaults);
    expect(coerceNotifyPrefs(null)).toEqual(defaults);
    expect(coerceNotifyPrefs({})).toEqual(defaults);
    expect(coerceNotifyPrefs({ blocked: false })).toEqual({ ...defaults, blocked: false });
    expect(coerceNotifyPrefs({ done: true })).toEqual({ ...defaults, done: true });
    // `updates` is a first-class key: an explicit false sticks, non-booleans fall back to the default.
    expect(coerceNotifyPrefs({ updates: false })).toEqual({ ...defaults, updates: false });
    expect(coerceNotifyPrefs({ blocked: "yes", done: 1, updates: 0 })).toEqual(defaults);
  });

  test("keeps valid pane rules and drops the junk around them", () => {
    const prefs = coerceNotifyPrefs({
      panes: [
        { paneId: "w1:p1", mode: "mute" },
        { label: "AI Stock", mode: "blocked", snoozedUntil: 42 },
        { mode: "all" }, // names no pane
        { paneId: "w1:p2", mode: "loud" }, // unknown mode
        "nonsense",
        { paneId: "w1:p3", label: "  ", mode: "default", snoozedUntil: -1 },
      ],
    });
    expect(prefs.panes).toEqual([
      { paneId: "w1:p1", mode: "mute" },
      { label: "AI Stock", mode: "blocked", snoozedUntil: 42 },
      { paneId: "w1:p3", mode: "default" },
    ]);
    // A file written before rules existed, or with a non-array, loads with none.
    expect(coerceNotifyPrefs({ panes: "all" }).panes).toEqual([]);
    expect(coercePaneRule({ mode: "mute" })).toBeNull();
  });
});

describe("parseNotifyPrefsPatch", () => {
  test("accepts the three switches and rejects a non-boolean", () => {
    expect(parseNotifyPrefsPatch({ done: true })).toEqual({ done: true });
    expect(parseNotifyPrefsPatch({})).toEqual({});
    expect(parseNotifyPrefsPatch({ blocked: "no" })).toBeNull();
    expect(parseNotifyPrefsPatch(null)).toBeNull();
    expect(parseNotifyPrefsPatch([])).toBeNull();
  });

  test("`panes` replaces the list and must be an array; bad rows are dropped, not refused", () => {
    expect(parseNotifyPrefsPatch({ panes: [{ paneId: "w1:p1", mode: "mute" }, { mode: "all" }] })).toEqual({
      panes: [{ paneId: "w1:p1", mode: "mute" }],
    });
    expect(parseNotifyPrefsPatch({ panes: [] })).toEqual({ panes: [] });
    expect(parseNotifyPrefsPatch({ panes: "none" })).toBeNull();
  });
});

describe("ruleFor", () => {
  const pane: PaneIdentity = {
    paneId: "w2:p1",
    paneLabel: "AI Stock",
    tabLabel: "develop",
    workspaceLabel: "AI Stock",
    terminalTitle: "2026-09-10 資料異常排查",
  };

  test("an exact id beats a label, and a label matches any of the pane's names, case-insensitively", () => {
    const byId = { paneId: "w2:p1", mode: "mute" } as const;
    const byLabel = { label: "ai stock", mode: "blocked" } as const;
    expect(ruleFor([byLabel, byId], pane)).toBe(byId);
    expect(ruleFor([byLabel], pane)).toBe(byLabel);
    expect(ruleFor([{ label: "develop", mode: "all" }], pane)?.mode).toBe("all");
    expect(ruleFor([{ label: "資料異常", mode: "all" }], pane)?.mode).toBe("all");
    expect(ruleFor([{ label: "AI Live", mode: "mute" }], pane)).toBeNull();
    expect(ruleFor([{ paneId: "w2:p9", mode: "mute" }], pane)).toBeNull();
  });

  test("a pane with no names at all can only match by id", () => {
    expect(ruleFor([{ label: "x", mode: "mute" }], { paneId: "w1:p1" })).toBeNull();
  });
});

describe("NotifyPrefsStore", () => {
  test("defaults to blocked-on / done-off when nothing is saved", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("isNotifiable follows the current prefs; other statuses are never notifiable", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.isNotifiable("blocked")).toBe(true);
    expect(store.isNotifiable("done")).toBe(false);
    expect(store.isNotifiable("working")).toBe(false);
    expect(store.isNotifiable("idle")).toBe(false);
    await store.set({ done: true });
    expect(store.isNotifiable("done")).toBe(true);
  });

  test("a pane rule overrides the switches for that pane only", async () => {
    let now = 1_000;
    const store = new NotifyPrefsStore(await tempCfg(), () => now);
    await store.set({
      panes: [
        { paneId: "w1:p1", mode: "mute" },
        { paneId: "w1:p2", mode: "all" },
        { label: "quiet", mode: "blocked" },
        { paneId: "w1:p4", mode: "default", snoozedUntil: 5_000 },
      ],
    });
    const p = (paneId: string, over: Partial<PaneIdentity> = {}): PaneIdentity => ({ paneId, ...over });
    // mute: nothing, ever.
    expect(store.isNotifiable("blocked", p("w1:p1"))).toBe(false);
    // all: done pushes even though the switch is off.
    expect(store.isNotifiable("done", p("w1:p2"))).toBe(true);
    // blocked: by label, and done stays off even after the done switch is turned on.
    await store.set({ done: true });
    expect(store.isNotifiable("done", p("w1:p3", { tabLabel: "Quiet Room" }))).toBe(false);
    expect(store.isNotifiable("blocked", p("w1:p3", { tabLabel: "Quiet Room" }))).toBe(true);
    // default + snooze: silent until the deadline, then the switches again.
    expect(store.isNotifiable("blocked", p("w1:p4"))).toBe(false);
    now = 6_000;
    expect(store.isNotifiable("blocked", p("w1:p4"))).toBe(true);
    // A pane no rule names follows the switches; a caller with no pane at all does too.
    expect(store.isNotifiable("done", p("w1:p9"))).toBe(true);
    expect(store.isNotifiable("done")).toBe(true);
    // A rule never makes a non-notifiable status push.
    expect(store.isNotifiable("working", p("w1:p2"))).toBe(false);
  });

  test("set merges a partial patch, persists, and returns the updated prefs", async () => {
    const cfg = await tempCfg();
    const store = new NotifyPrefsStore(cfg);
    const updated = await store.set({ done: true, updates: false });
    expect(updated).toEqual({ blocked: true, done: true, updates: false, panes: [] });

    // Round-trips through disk: a fresh store reloads the same values (survives a restart).
    const reloaded = new NotifyPrefsStore(cfg);
    await reloaded.load();
    expect(reloaded.current()).toEqual({ blocked: true, done: true, updates: false, panes: [] });
  });

  test("pane rules round-trip through disk and `panes` replaces rather than merges", async () => {
    const cfg = await tempCfg();
    const store = new NotifyPrefsStore(cfg);
    await store.set({ panes: [{ paneId: "w1:p1", mode: "mute" }, { label: "AI Live", mode: "blocked" }] });
    const reloaded = new NotifyPrefsStore(cfg);
    await reloaded.load();
    expect(reloaded.current().panes).toEqual([
      { paneId: "w1:p1", mode: "mute" },
      { label: "AI Live", mode: "blocked" },
    ]);
    await reloaded.set({ panes: [{ label: "AI Live", mode: "all" }] });
    expect(reloaded.current().panes).toEqual([{ label: "AI Live", mode: "all" }]);
    // The switches were untouched by a panes-only patch.
    expect(reloaded.current().blocked).toBe(true);
  });

  test("current() returns a copy — callers can't mutate the store's state", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    const snap = store.current();
    snap.blocked = false;
    snap.panes.push({ paneId: "x", mode: "mute" });
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("persists with owner-only (0600) permissions", async () => {
    const cfg = await tempCfg();
    const store = new NotifyPrefsStore(cfg);
    await store.set({ blocked: false });
    const mode = (await stat(join(cfg.stateDir, "notify-prefs.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a partial saved file fills the missing key from defaults", async () => {
    const cfg = await tempCfg();
    await writeFile(join(cfg.stateDir, "notify-prefs.json"), JSON.stringify({ blocked: false }));
    const store = new NotifyPrefsStore(cfg);
    await store.load();
    expect(store.current()).toEqual({ blocked: false, done: false, updates: true, panes: [] });
  });

  test("load tolerates a missing file (keeps defaults)", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });
});
