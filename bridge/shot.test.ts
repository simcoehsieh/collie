import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import {
  SHOT_IMAGE_CAP,
  SHOT_OUTPUT_CAP,
  ShotRunner,
  allowedShotUrl,
  normaliseProbe,
  parseShotCommand,
  redactSecrets,
  shotDataUrl,
  shotImageMime,
  type ShotIo,
  type ShotRun,
} from "./shot.ts";

// The spawn is mocked everywhere below, exactly the way `quota.test.ts` mocks its own: this file
// must never start a browser, and the questions it asks are all about what the bridge does with
// what a command returns — not about what the command does.

const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function webp(bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(WEBP_HEAD.length, bytes));
  out.set(WEBP_HEAD);
  return out;
}

/** The stand-in for the spawn: it records the argv it was handed and answers what the case says. */
interface FakeIo extends ShotIo {
  calls: string[][];
}

function fakeIo(reply: (argv: readonly string[]) => ShotRun | Promise<ShotRun>): FakeIo {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv: readonly string[]) => {
      calls.push([...argv]);
      return reply(argv);
    },
  };
}

/** A probe payload as the command would print it: a JSON document, which is exactly what it takes. */
const encode = (value: JsonValue): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const PROBE = {
  tag: "BUTTON",
  id: "export",
  classes: "btn btn-primary",
  selector: "#export",
  elementPath: "html > body > div > button#export",
  text: "Export CSV",
  box: { x: 40.4, y: 137.9, width: 105.1, height: 36 },
  role: "button",
  accessibleName: "Export CSV",
  computedStyles: { display: "inline-block", color: "rgb(255, 255, 255)" },
  htmlSnippet: '<button id="export">Export CSV</button>',
  nearbyText: ["1,284 requests", "Refresh"],
  nearbyElements: ['button.btn-ghost "Refresh"'],
  url: "http://127.0.0.1:5173/",
  reactComponents: "App > Toolbar > Button",
};

describe("parseShotCommand", () => {
  test("splits on whitespace and never on a shell", () => {
    expect(parseShotCommand("uv run --project ~/git/ai-live python tools/collie_shot/main.py")).toEqual([
      "uv",
      "run",
      "--project",
      "~/git/ai-live",
      "python",
      "tools/collie_shot/main.py",
    ]);
    expect(parseShotCommand("  collie-shot\t--quiet ")).toEqual(["collie-shot", "--quiet"]);
  });

  test("empty is off — which is what makes the route 404 and the capability absent", () => {
    expect(parseShotCommand("")).toBeNull();
    expect(parseShotCommand("   ")).toBeNull();
  });
});

describe("allowedShotUrl — the anti-egress rule, enforced on THIS side too", () => {
  test("loopback in every spelling", () => {
    expect(allowedShotUrl("http://localhost:5173/app")).toBe("http://localhost:5173/app");
    expect(allowedShotUrl("http://127.0.0.1:4318/")).toBe("http://127.0.0.1:4318/");
    expect(allowedShotUrl("http://[::1]:8080/x")).toBe("http://[::1]:8080/x");
    expect(allowedShotUrl("http://0.0.0.0:3000/")).toBe("http://0.0.0.0:3000/");
  });

  test("anything else is refused unless the operator named it", () => {
    expect(allowedShotUrl("https://example.com/")).toBeNull();
    // The classic SSRF neighbours: a name that RESOLVES to loopback is still not loopback here,
    // because this list is about the NAME, and a name is what the command is handed.
    expect(allowedShotUrl("http://127.0.0.1.nip.io/")).toBeNull();
    expect(allowedShotUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(allowedShotUrl("https://example.com/", ["example.com"])).toBe("https://example.com/");
    expect(allowedShotUrl("https://EXAMPLE.com/", ["  Example.COM "])).toBe("https://example.com/");
  });

  test("no scheme but http(s), and never credentials in the authority", () => {
    expect(allowedShotUrl("file:///etc/passwd")).toBeNull();
    expect(allowedShotUrl("javascript:alert(1)")).toBeNull();
    expect(allowedShotUrl("data:text/html,<b>x")).toBeNull();
    expect(allowedShotUrl("not a url")).toBeNull();
    expect(allowedShotUrl("http://user:pw@127.0.0.1/")).toBeNull();
  });
});

describe("shotImageMime — the bytes decide, not the command's word", () => {
  test("the two formats the command may return", () => {
    expect(shotImageMime(new Uint8Array(WEBP_HEAD))).toBe("image/webp");
    expect(shotImageMime(new Uint8Array(PNG_HEAD))).toBe("image/png");
  });

  test("everything else is not an answer", () => {
    // RIFF without WEBP at 8 is some other container; a plain error message is the case that
    // matters most, because forwarding it would have put the command's stdout in a response body.
    expect(shotImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
    expect(shotImageMime(new TextEncoder().encode("Traceback (most recent call last): token=sk-abc"))).toBeNull();
    expect(shotImageMime(new Uint8Array([]))).toBeNull();
  });

  test("a data URL is the mime plus base64 and nothing else", () => {
    expect(shotDataUrl(new Uint8Array([1, 2, 3]), "image/webp")).toBe("data:image/webp;base64,AQID");
  });
});

describe("redactSecrets", () => {
  test("the value goes, the name stays", () => {
    expect(redactSecrets('<a href="/cb?access_token=abc123&page=2">')).toBe(
      '<a href="/cb?access_token=[redacted]&page=2">',
    );
    expect(redactSecrets('<input name="password" value="hunter2">')).toBe(
      '<input name="[redacted]" value="hunter2">',
    );
    expect(redactSecrets("sessionid: 9f3c1a")).toBe("sessionid: [redacted]");
  });

  test("narrow on purpose — an ordinary class name survives", () => {
    // Orca's own argument for the narrowness: `code` and `state` match `source-code` and `stateful`,
    // and a redaction that eats those degrades every answer without protecting anything.
    const markup = '<div class="source-code stateful" data-code="x">const state = 1</div>';
    expect(redactSecrets(markup)).toBe(markup);
  });
});

describe("normaliseProbe — every field named, every field capped", () => {
  test("the command's JSON becomes the phone's body", () => {
    const body = normaliseProbe(JSON.stringify(PROBE))!;
    expect(body.tag).toBe("button");
    expect(body.selector).toBe("#export");
    expect(body.box).toEqual({ x: 40, y: 138, width: 105, height: 36 });
    expect(body.reactComponents).toBe("App > Toolbar > Button");
    // Resolved by nothing in the page, so the field is absent rather than guessed.
    expect(body.sourceFile).toBeUndefined();
  });

  test("a field the command grows is NOT copied", () => {
    const body = normaliseProbe(JSON.stringify({ ...PROBE, cookies: "a=b", innerHTML: "<script>" }))!;
    expect(JSON.stringify(body)).not.toContain("cookies");
    expect(JSON.stringify(body)).not.toContain("innerHTML");
  });

  test("the budgets are re-applied here, not merely trusted", () => {
    const body = normaliseProbe(
      JSON.stringify({
        ...PROBE,
        selector: "a".repeat(2000),
        htmlSnippet: "<b>".repeat(4000),
        text: "t".repeat(1000),
        nearbyText: Array.from({ length: 40 }, (_, i) => `${i}-${"x".repeat(500)}`),
        nearbyElements: Array.from({ length: 40 }, () => "div"),
        computedStyles: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, "v"])),
      }),
    )!;
    expect(body.selector.length).toBe(700);
    expect(body.htmlSnippet.length).toBe(4096);
    expect(body.text.length).toBe(200);
    expect(body.nearbyText).toHaveLength(10);
    expect(body.nearbyText[0]!.length).toBe(200);
    expect(body.nearbyElements).toHaveLength(6);
    expect(Object.keys(body.computedStyles)).toHaveLength(16);
  });

  test("redaction is applied on this side as well as in the page", () => {
    // The command redacts because it is the only thing that can see the DOM; this redacts because
    // it is the only thing between a command and a terminal. A command that regressed cannot widen
    // what a pane is told.
    const body = normaliseProbe(
      JSON.stringify({
        ...PROBE,
        htmlSnippet: '<form action="/l?csrf=deadbeef"><input name="api_key" value="sk-live-1"></form>',
        nearbyText: ["session_id=9f3c1a"],
        url: "http://127.0.0.1:5173/cb?access_token=abc123",
      }),
    )!;
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("deadbeef");
    expect(wire).not.toContain("9f3c1a");
    expect(wire).not.toContain("abc123");
    expect(body.htmlSnippet).toContain("csrf=[redacted]");
  });

  test("a style key that is not a CSS property name never becomes a label", () => {
    const body = normaliseProbe(JSON.stringify({ ...PROBE, computedStyles: { "<img src=x>": "1", color: "red" } }))!;
    expect(Object.keys(body.computedStyles)).toEqual(["color"]);
  });

  test("not the JSON this module knows is null, not a throw", () => {
    expect(normaliseProbe("not json")).toBeNull();
    expect(normaliseProbe("[]")).toBeNull();
    expect(normaliseProbe("{}")).toBeNull();
    expect(normaliseProbe(JSON.stringify({ tag: "<script>" }))).toBeNull();
  });
});

describe("ShotRunner — the argv it builds and the failures it reports", () => {
  test("the operator's argv, then the verb, then bounded numbers — and no shell anywhere", async () => {
    const io = fakeIo(() => ({ code: 0, stdout: webp(), timedOut: false }));
    const runner = new ShotRunner(["collie-shot", "--quiet"], [], io, { warn: () => {} });
    await runner.shot("http://localhost:5173/app", 390, 844, 3);
    expect(io.calls[0]).toEqual(["collie-shot", "--quiet", "shot", "http://localhost:5173/app", "390", "844", "3"]);
  });

  test("a probe's point is clamped into the viewport it was taken at", async () => {
    const io = fakeIo(() => ({ code: 0, stdout: encode(PROBE), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: () => {} });
    await runner.probe("http://127.0.0.1:5173/", 390, 844, -40, 99_999, 3);
    expect(io.calls[0]).toEqual(["collie-shot", "probe", "http://127.0.0.1:5173/", "390", "844", "0", "844", "3"]);
  });

  test("a viewport and a dpr the phone could not have meant are clamped, never passed through", async () => {
    const io = fakeIo(() => ({ code: 0, stdout: webp(), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: () => {} });
    const got = await runner.shot("http://localhost:1/", 99_999, 0, 99);
    expect(io.calls[0]!.slice(-3)).toEqual(["2560", "200", "3"]);
    expect(got.ok && got.body.width).toBe(2560);
  });

  test("a refused URL never spawns anything", async () => {
    const io = fakeIo(() => ({ code: 0, stdout: webp(), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: () => {} });
    expect(await runner.shot("https://example.com/", 390, 844, 3)).toEqual({ ok: false, reason: "bad_url" });
    expect(await runner.probe("https://example.com/", 390, 844, 1, 1, 3)).toEqual({ ok: false, reason: "bad_url" });
    expect(io.calls).toHaveLength(0);
  });

  test("a good shot comes back inline as a data URL, with the viewport it was taken at", async () => {
    const io = fakeIo(() => ({ code: 0, stdout: webp(), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: () => {} });
    const got = await runner.shot("http://localhost:5173/", 390, 844, 3);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.body.image.startsWith("data:image/webp;base64,")).toBe(true);
    expect(got.body).toMatchObject({ mime: "image/webp", width: 390, height: 844, dpr: 3 });
  });

  test("the deadline is a reason, not a killed child with nothing attached", async () => {
    const warned: string[] = [];
    const io = fakeIo(() => ({ code: null, stdout: new Uint8Array(), timedOut: true }));
    const runner = new ShotRunner(["collie-shot"], [], io, { deadlineMs: 5, warn: (m) => warned.push(m) });
    expect(await runner.shot("http://localhost:1/", 390, 844, 3)).toEqual({ ok: false, reason: "timeout" });
    expect(warned.join("\n")).toContain("did not finish within 5ms");
  });

  test("killed WITHOUT timing out is the byte cap", async () => {
    const io = fakeIo(() => ({ code: null, stdout: new Uint8Array(), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: () => {} });
    expect(await runner.shot("http://localhost:1/", 390, 844, 3)).toEqual({ ok: false, reason: "too_large" });
  });

  test("an image past the inline cap is refused rather than sent", async () => {
    const io = fakeIo(() => ({ code: 0, stdout: webp(SHOT_IMAGE_CAP + 1), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: () => {} });
    expect(await runner.shot("http://localhost:1/", 390, 844, 3)).toEqual({ ok: false, reason: "too_large" });
    // And the two caps are the right way round: the spawn's is the larger, so an oversize run is
    // reported as too big rather than killed mid-read with no reason.
    expect(SHOT_OUTPUT_CAP).toBeGreaterThan(SHOT_IMAGE_CAP);
  });

  test("exit 2 is the command's own URL refusal, and it reaches the phone as that same verdict", async () => {
    const io = fakeIo(() => ({ code: 2, stdout: new Uint8Array(), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], ["example.com"], io, { warn: () => {} });
    expect(await runner.shot("https://example.com/", 390, 844, 3)).toEqual({ ok: false, reason: "bad_url" });
  });

  test("the command's output NEVER becomes the reason", async () => {
    const warned: string[] = [];
    const io = fakeIo(() => ({
      code: 0,
      stdout: new TextEncoder().encode("Traceback: Authorization: Bearer sk-live-secret"),
      timedOut: false,
    }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: (m) => warned.push(m) });
    const got = await runner.shot("http://localhost:1/", 390, 844, 3);
    expect(got).toEqual({ ok: false, reason: "unparsable" });
    expect(JSON.stringify(got) + warned.join("\n")).not.toContain("sk-live-secret");
  });

  test("a probe whose JSON is unreadable is a reason, not a body", async () => {
    const io = fakeIo(() => ({ code: 0, stdout: new TextEncoder().encode("<html>login</html>"), timedOut: false }));
    const runner = new ShotRunner(["collie-shot"], [], io, { warn: () => {} });
    expect(await runner.probe("http://localhost:1/", 390, 844, 1, 1, 3)).toEqual({ ok: false, reason: "unparsable" });
  });
});

// ── The seam, pinned at its registration site ────────────────────────────────────────────────
// `bun test` cannot stand up `Bun.serve` (CLAUDE.md), so the gate and the off-switch are asserted
// by reading the source — the same way `solo-baseline.test.ts` pins the route table.

describe("the routes", () => {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  test("both verbs are in the pane family, so they are session-scoped and write-gated", () => {
    expect(src).toContain("reply|keys|upload|close|rename|history|focus|diff|shot|probe");
    // NOT in `isRead`: a read-only device may watch a terminal, it may not start a browser.
    expect(src).toContain('const isRead = !action || action === "history" || action === "diff";');
  });

  test("unset is no route and no capability — declined by doing nothing", () => {
    expect(src).toContain("const shotArgv = parseShotCommand(cfg.shotCommand);");
    expect(src).toContain("const shot = shotArgv === null ? null : new ShotRunner(shotArgv, cfg.shotHosts);");
    expect(src).toContain('if (shot === null) return text("no shot command", 404);');
    expect(src).toContain("shot: shot !== null ? true : undefined,");
    expect(src).toContain("if (opts.shot === true) wire.shot = true;");
  });

  test("the command's stdout is never written into a response body as text", () => {
    // The only two things a failed run produces here are a fixed sentence and a status. Proven by
    // the refusal switch being a set of literals with no interpolation in it.
    const start = src.indexOf("function shotRefusal(");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf("\n}", start));
    expect(block).not.toContain("${");
  });
});
