import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bootBody, snapshotEtagOf, type BootParts } from "./boot.ts";
import { computeEtag } from "./http-cache.ts";
import { DEFAULT_NOTIFY_PREFS } from "./notify-prefs.ts";
import type { BridgeConfig, SnapshotResponse } from "./types.ts";

const snapshot = (over: Partial<SnapshotResponse> = {}): SnapshotResponse => ({
  bridge: "connected",
  agents: [],
  shellPanes: [],
  workspaces: [],
  tabs: [],
  sessions: [],
  ts: 1_700_000_000_000,
  ...over,
});

// SAFETY: `BridgeConfig` carries a dozen optional capability blocks this file never reads; the
// assertion states that the three required ones are present and the rest are legitimately absent,
// which is exactly the body a solo bridge with nothing configured publishes.
const config = (over: Partial<BridgeConfig> = {}): BridgeConfig =>
  ({ push: false, vapidPublicKey: "", build: "test", ...over }) as BridgeConfig;

const parts = (over: Partial<BootParts> = {}): BootParts => ({
  snapshot: snapshot(),
  config: config(),
  launchers: { launchers: [], home: "/home/op" },
  notifyPrefs: DEFAULT_NOTIFY_PREFS,
  quota: null,
  ...over,
});

describe("snapshotEtagOf — one expression for one body's version", () => {
  test("it is the tag the snapshot route computes: the body with `ts` zeroed", () => {
    const body = snapshot();
    expect(snapshotEtagOf(body)).toBe(computeEtag(JSON.stringify({ ...body, ts: 0 })));
  });

  test("a body that differs only in `ts` has the same tag — otherwise every poll would be a miss", () => {
    expect(snapshotEtagOf(snapshot({ ts: 1 }))).toBe(snapshotEtagOf(snapshot({ ts: 2 })));
  });

  test("a body whose CONTENT moved does not", () => {
    const moved = snapshot({ bridge: "disconnected" });
    expect(snapshotEtagOf(moved)).not.toBe(snapshotEtagOf(snapshot()));
  });

  // The load-bearing claim of the whole route: the client seeds its snapshot ETag map from
  // `snapshotEtag`, so its first POLL must be a 304. That holds only while the route and this
  // function compute the same thing, which is why the route calls this one rather than repeating it.
  test("server.ts computes its snapshot ETag through this function, not a second copy", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    expect(src).toContain("const etag = snapshotEtagOf(wire);");
    expect(src).not.toContain("computeEtag(JSON.stringify({ ...wire, ts: 0 }))");
  });
});

describe("bootBody — the five bodies as one", () => {
  test("it carries each route's own body, plus the tag that names the snapshot", () => {
    const p = parts();
    const body = bootBody(p);
    expect(body.snapshot).toBe(p.snapshot);
    expect(body.config).toBe(p.config);
    expect(body.launchers).toBe(p.launchers);
    expect(body.notifyPrefs).toBe(p.notifyPrefs);
    expect(body.snapshotEtag).toBe(snapshotEtagOf(p.snapshot));
  });

  test("no quota source: the keys are ABSENT, never present and undefined", () => {
    const body = bootBody(parts());
    expect("quota" in body).toBe(false);
    expect("quotaEtag" in body).toBe(false);
  });

  test("the quota rides only when the CONFIG says the card is on", () => {
    const quotaWire = { ok: true as const, agents: [], fetchedAt: "z" };
    const serialised = { body: JSON.stringify(quotaWire), etag: '"q1"' };
    // A source answered, but the config does not advertise the card — the two must not disagree, and
    // the config is the one the client acts on.
    expect("quota" in bootBody(parts({ quota: serialised }))).toBe(false);
    const on = bootBody(parts({ quota: serialised, config: config({ quota: true }) }));
    expect(on.quota).toEqual(quotaWire);
    expect(on.quotaEtag).toBe('"q1"');
  });

  test("a quota body that will not parse is dropped, not thrown — the client asks the route", () => {
    const body = bootBody(
      parts({ quota: { body: "not json", etag: '"q1"' }, config: config({ quota: true }) }),
    );
    expect("quota" in body).toBe(false);
  });

  test("the bundle offers no conditional GET of its own — the tag inside names one document", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    const route = src.slice(src.indexOf('if (pathname === "/api/boot"'));
    const block = route.slice(0, route.indexOf("// ── Misc API"));
    expect(block).not.toContain("if-none-match");
    expect(block).toContain('"cache-control": "no-store"');
    // Local only, on the line before anything is read — the same declaration `/api/events` makes.
    expect(block).toContain('if (host.kind !== "local") return text("no boot bundle for a member host", 404);');
    // The same read gate the five routes it bundles pass.
    expect(block).toContain('const denied = guard(req, cfg, "read", pairing);');
  });
});
