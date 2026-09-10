import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { __resetQuotaCache } from "@/lib/api";
import type { QuotaResponse } from "@/lib/types";
import { server } from "@/test/setup";
import { __resetQuota, countdownParts, quotaData, quotaError, readQuota, secondsUntil, usageTone } from "./quota";

// FORK: the usage section's reads and its arithmetic.

afterEach(() => {
  __resetQuota();
  __resetQuotaCache();
});

const body: QuotaResponse = { ok: true, fetchedAt: "t", agents: [] };

describe("readQuota", () => {
  it("keeps the body, and keeps THE SAME body on a 304", async () => {
    let calls = 0;
    server.use(
      http.get("/api/quota", ({ request }) => {
        calls++;
        if (request.headers.get("if-none-match") === '"q1"') return new HttpResponse(null, { status: 304 });
        return HttpResponse.json(body, { headers: { etag: '"q1"' } });
      }),
    );
    await readQuota();
    const first = quotaData();
    expect(first).toEqual(body);
    await readQuota();
    expect(calls).toBe(2);
    expect(quotaData()).toBe(first);
    expect(quotaError()).toBeNull();
  });

  it("a failed read leaves the last body in place and names the failure", async () => {
    server.use(http.get("/api/quota", () => HttpResponse.json(body, { headers: { etag: '"a"' } })));
    await readQuota();
    server.use(http.get("/api/quota", () => HttpResponse.text("the quota command failed", { status: 503 })));
    await readQuota(true);
    expect(quotaData()).toEqual(body);
    expect(quotaError()).toContain("503");
  });

  it("two passive reads at once are one request; a refresh is its own", async () => {
    let calls = 0;
    const seen: string[] = [];
    server.use(
      http.get("/api/quota", ({ request }) => {
        calls++;
        seen.push(new URL(request.url).search);
        return HttpResponse.json(body, { headers: { etag: `"${calls}"` } });
      }),
    );
    await Promise.all([readQuota(), readQuota()]);
    expect(calls).toBe(1);
    await readQuota(true);
    expect(seen.at(-1)).toBe("?refresh=1");
  });
});

describe("arithmetic", () => {
  it("tones by thirds of the bar", () => {
    expect(usageTone(0)).toBe("ok");
    expect(usageTone(49.9)).toBe("ok");
    expect(usageTone(50)).toBe("warn");
    expect(usageTone(79.9)).toBe("warn");
    expect(usageTone(80)).toBe("high");
    expect(usageTone(100)).toBe("high");
  });

  it("counts down from the reset time, floored at zero, null when none", () => {
    const now = Date.parse("2026-09-10T16:00:00Z");
    expect(secondsUntil("2026-09-10T20:10:00Z", now)).toBe(4 * 3600 + 10 * 60);
    expect(secondsUntil("2026-09-10T15:00:00Z", now)).toBe(0);
    expect(secondsUntil(null, now)).toBeNull();
    expect(secondsUntil("not a date", now)).toBeNull();
  });

  it("splits seconds into days, hours and minutes", () => {
    expect(countdownParts(5 * 86400 + 15 * 3600 + 30 * 60 + 5)).toEqual({ days: 5, hours: 15, minutes: 30 });
    expect(countdownParts(59)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });
});
