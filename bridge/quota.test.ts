import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  QUOTA_TTL_MS,
  QuotaSource,
  normaliseQuota,
  parseQuotaCommand,
  type QuotaIo,
  type QuotaRun,
} from "./quota.ts";

// The fixture is a real `ai-quota --json` from 2026-09-10 with the account fields redacted. It has
// the three shapes the normaliser must survive: a provider with both windows (claude), one with no
// five-hour window but model quotas and a credits object (openai), and one with secondary
// windows of its own (gemini).
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "ai-quota.json"), "utf8");

describe("parseQuotaCommand", () => {
  test("splits on whitespace and never on a shell", () => {
    expect(parseQuotaCommand("/Users/x/.local/bin/ai-quota --json")).toEqual([
      "/Users/x/.local/bin/ai-quota",
      "--json",
    ]);
    expect(parseQuotaCommand("  ai-quota   --json\t-p claude ")).toEqual(["ai-quota", "--json", "-p", "claude"]);
  });
  test("empty is off", () => {
    expect(parseQuotaCommand("")).toBeNull();
    expect(parseQuotaCommand("   ")).toBeNull();
  });
});

describe("normaliseQuota", () => {
  const body = normaliseQuota(FIXTURE, "2026-09-10T16:26:50Z")!;

  test("always the three agents, in the operator's order and names", () => {
    expect(body.agents.map((a) => a.key)).toEqual(["claude", "codex", "agy"]);
    expect(body.agents.map((a) => a.name)).toEqual(["claude", "codex", "agy"]);
    expect(body.fetchedAt).toBe("2026-09-10T16:26:50Z");
  });

  test("the five-hour and weekly windows lead, typed by their length", () => {
    const claude = body.agents[0]!;
    expect(claude.status).toBe("ok");
    expect(claude.plan).toBe("Claude MAX (claude max 20x)");
    expect(claude.windows.map((w) => w.kind)).toEqual(["5h", "weekly"]);
    const raw = JSON.parse(FIXTURE).providers.claude;
    expect(claude.windows[0]).toEqual({
      kind: "5h",
      label: raw.five_hour_window.label,
      usedPercent: Math.round(raw.five_hour_window.used_percent * 10) / 10,
      resetAt: raw.five_hour_window.reset_at,
      resetAfterSeconds: raw.five_hour_window.reset_after_seconds,
      status: "allowed",
    });
    expect(claude.windows[1]!.usedPercent).toBe(Math.round(raw.primary_window.used_percent * 10) / 10);
  });

  test("a provider with no five-hour window still has its week, its models and its balance", () => {
    const codex = body.agents[1]!;
    expect(codex.windows.map((w) => w.kind)).toEqual(["weekly"]);
    expect(codex.models).toEqual([{ label: "GPT-5.3-Codex-Spark", usedPercent: 0, resetAfterSeconds: 18000 }]);
    expect(codex.credits).toBe("$0");
  });

  test("secondary windows follow as `other`, keeping the provider's label", () => {
    const agy = body.agents[2]!;
    const raw = JSON.parse(FIXTURE).providers.gemini;
    const secondary = raw.secondary_windows.length;
    expect(secondary).toBeGreaterThan(0);
    expect(agy.windows.map((w) => w.kind)).toEqual(["5h", "weekly", ...Array<"other">(secondary).fill("other")]);
    expect(agy.windows[2]!.label).toBe(raw.secondary_windows[0].label);
    expect(agy.windows[1]!.usedPercent).toBe(Math.round(raw.primary_window.used_percent * 10) / 10);
    expect(agy.models!.length).toBeGreaterThan(0);
  });

  test("nothing that could name the account is copied out", () => {
    const text = JSON.stringify(body);
    expect(text).not.toContain("account_email");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("acct_redacted");
  });

  test("a provider the CLI did not report is `missing`; one it could not read is `error` with its words", () => {
    const partial = normaliseQuota(
      JSON.stringify({
        providers: {
          claude: { status: "error", error: "keychain locked", five_hour_window: null },
        },
      }),
      "t",
    )!;
    expect(partial.agents.map((a) => a.status)).toEqual(["error", "missing", "missing"]);
    expect(partial.agents[0]!.error).toBe("keychain locked");
    expect(partial.agents[0]!.windows).toEqual([]);
  });

  test("a percentage is clamped and rounded so the bar can be drawn", () => {
    const odd = normaliseQuota(
      JSON.stringify({
        providers: {
          openai: {
            status: "ok",
            primary_window: { used_percent: 133.333, limit_window_seconds: 604800 },
            five_hour_window: { used_percent: -4, limit_window_seconds: 18000 },
          },
        },
      }),
      "t",
    )!;
    expect(odd.agents[1]!.windows.map((w) => w.usedPercent)).toEqual([0, 100]);
  });

  test("not the JSON this module knows is null, not a throw", () => {
    expect(normaliseQuota("not json", "t")).toBeNull();
    expect(normaliseQuota("[]", "t")).toBeNull();
    expect(normaliseQuota('{"providers": 3}', "t")).toBeNull();
  });
});

// ── The cache ─────────────────────────────────────────────────────────────────────────────────

function fakeIo(reply: () => QuotaRun | Promise<QuotaRun>): QuotaIo & { runs: number } {
  const io = {
    runs: 0,
    run: async () => {
      io.runs++;
      return reply();
    },
  };
  return io;
}

const okRun = (): QuotaRun => ({ code: 0, stdout: FIXTURE, timedOut: false });

describe("QuotaSource", () => {
  test("the first read waits for the run; a second within the TTL is the cached body and no run", async () => {
    let clock = 1000;
    const io = fakeIo(okRun);
    const source = new QuotaSource(["ai-quota"], io, { now: () => clock, warn: () => {} });
    const first = await source.get();
    expect(first.ok).toBe(true);
    clock += 10_000;
    const second = await source.get();
    expect(io.runs).toBe(1);
    if (first.ok && second.ok) expect(second.etag).toBe(first.etag);
  });

  test("past the TTL the stale body is answered at once and the run happens behind it", async () => {
    let clock = 1000;
    let release: (run: QuotaRun) => void = () => {};
    const io = fakeIo(() => new Promise<QuotaRun>((r) => (release = r)));
    const source = new QuotaSource(["ai-quota"], io, { now: () => clock, warn: () => {} });
    const firstRun = source.get();
    release(okRun());
    const first = await firstRun;
    clock += QUOTA_TTL_MS + 1;
    const stale = await source.get();
    expect(stale.ok).toBe(true);
    if (first.ok && stale.ok) expect(stale.at).toBe(first.at);
    expect(io.runs).toBe(2);
    release(okRun());
    await new Promise((r) => setTimeout(r, 0));
    const fresh = source.cached()!;
    expect(fresh.at).toBe(clock);
  });

  test("concurrent readers share one run", async () => {
    let release: (run: QuotaRun) => void = () => {};
    const io = fakeIo(() => new Promise<QuotaRun>((r) => (release = r)));
    const source = new QuotaSource(["ai-quota"], io, { warn: () => {} });
    const a = source.get();
    const b = source.get(true);
    release(okRun());
    const [ra, rb] = await Promise.all([a, b]);
    expect(io.runs).toBe(1);
    expect(ra.ok && rb.ok).toBe(true);
  });

  test("`refresh` reruns inside the TTL and waits for the new body", async () => {
    let clock = 1000;
    const io = fakeIo(okRun);
    const source = new QuotaSource(["ai-quota"], io, { now: () => clock, warn: () => {} });
    await source.get();
    clock += 5;
    const refreshed = await source.get(true);
    expect(io.runs).toBe(2);
    if (refreshed.ok) expect(refreshed.at).toBe(clock);
  });

  test("a failed run keeps the last good body; with none it is a reason", async () => {
    const warned: string[] = [];
    let mode: "ok" | "exit" | "timeout" | "garbage" = "exit";
    const io = fakeIo(() =>
      mode === "ok"
        ? okRun()
        : mode === "timeout"
          ? { code: null, stdout: "", timedOut: true }
          : mode === "garbage"
            ? { code: 0, stdout: "Error: token expired sk-abc123", timedOut: false }
            : { code: 1, stdout: "", timedOut: false },
    );
    const source = new QuotaSource(["ai-quota"], io, { ttlMs: 0, warn: (m) => warned.push(m) });
    expect(await source.get()).toEqual({ ok: false, reason: "failed" });
    mode = "timeout";
    expect(await source.get()).toEqual({ ok: false, reason: "timeout" });
    mode = "garbage";
    expect(await source.get()).toEqual({ ok: false, reason: "unparsable" });
    // The warn names the failure and never the output.
    expect(warned.join("\n")).not.toContain("sk-abc123");
    mode = "ok";
    const good = await source.get(true);
    expect(good.ok).toBe(true);
    mode = "exit";
    const kept = await source.get(true);
    expect(kept.ok).toBe(true);
    if (good.ok && kept.ok) expect(kept.etag).toBe(good.etag);
    expect(source.failure()).toBe("failed");
  });
});
