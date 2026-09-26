import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENTRY_TIMEOUT_MS,
  DOCUMENT_CSP,
  DOCUMENT_PATH_PREFIX,
  MAX_DOCUMENT_BYTES,
  agentryQueryArgv,
  documentEtag,
  documentResponseHeaders,
  documentRowSql,
  documentSlugFromPath,
  fetchDocument,
  isDocumentSlug,
  normaliseAgentry,
  sqlText,
  type AgentryIo,
  type AgentrySettings,
} from "./docs.ts";
import type { QuotaRun } from "./quota.ts";

// The route that serves somebody else's HTML from Collie's own origin, read out of agentry. Three
// questions run through every case below, and they are the three the feature lives or dies on:
//
//   1. WHAT MAY BECOME A QUERY — the slug is quoted into `agentry query`'s SQL, so the grammar is the
//      boundary and it is asserted by its refusals.
//   2. WHAT MAY BECOME A READ — the path read is the ROW's, and it must still be inside agentry's
//      documents directory after symlinks are resolved.
//   3. WHAT THE BROWSER IS TOLD ABOUT THE BYTES — the sandbox, and the two directives either side
//      of it whose absence fails silently rather than loudly.
//
// `agentry query` is replaced by a scripted `run`; the files are real, in a temporary home.

/**
 * A document shaped like the operator's real ones: a `<base href="about:srcdoc">` left over from
 * kb's own srcdoc viewer, an inline `<style>`, and an in-page anchor that only works if that base
 * tag is neutralised. Its digest is `shasum -a 256` of exactly these bytes, taken outside this
 * process — an oracle, rather than the same hasher the implementation uses agreeing with itself.
 */
const HTML =
  '<!doctype html><html><head><base href="about:srcdoc"><style>body{color:#111}</style>' +
  "</head><body><h1>Herdr</h1><a href=\"#s\">s</a></body></html>";
const HTML_SHA256 = "b6b6cc04d6d51db3888f636435a3c7ec82f400a2534c8ca339879e5777f0204e";
const HTML_ETAG = `"d1:${HTML_SHA256}"`;
const SLUG = "herdr-interface-anatomy";
const CLI = "/opt/agentry/bin/agentry";
const TITLE = "Herdr 介面解剖：五個名詞與各自能做什麼";

/** A throwaway `$AGENTRY_HOME` with the one document in `documents/`, and a secret beside it. */
const HOME = mkdtempSync(join(tmpdir(), "collie-docs-"));
mkdirSync(join(HOME, "documents"));
writeFileSync(join(HOME, "documents", `${SLUG}.html`), HTML);
// Outside `documents/`: what a row whose html_path escapes would reach.
writeFileSync(join(HOME, "secret.html"), HTML);
symlinkSync(join(HOME, "secret.html"), join(HOME, "documents", "linked-out.html"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const settings: AgentrySettings = { home: HOME, cli: CLI };

/** agentry's row, field for field as `documents_latest` returns it. */
function row(over: Record<string, string | number | null> = {}) {
  return {
    slug: SLUG,
    title: TITLE,
    html_path: `${SLUG}.html`,
    html_sha256: HTML_SHA256,
    html_bytes: Buffer.byteLength(HTML, "utf8"),
    ...over,
  };
}

/** agentry's success envelope, as `agentry query --format json` prints it. */
function envelope(rows: object[]): QuotaRun {
  return { code: 0, stdout: JSON.stringify({ ok: true, data: rows, meta: { truncated: false, rows: rows.length } }), timedOut: false };
}

/** One scripted agentry plus the record of what it was asked and which files were read. */
interface Fixture {
  io: AgentryIo;
  argv: string[][];
  reads: string[];
}

function agentry(answer: QuotaRun): Fixture {
  const argv: string[][] = [];
  const reads: string[] = [];
  return {
    argv,
    reads,
    io: {
      run: async (args) => {
        argv.push([...args]);
        return answer;
      },
      read: async (path) => {
        reads.push(path);
        return readFileSync(path);
      },
    },
  };
}

/** The io no test may reach: proof that a refusal happened before anything was run or read. */
const untouchable: AgentryIo = {
  run: async () => {
    throw new Error("agentry must not be run for this request");
  },
  read: async () => {
    throw new Error("no file may be read for this request");
  },
};

/** The injected `warn`, so a warning is asserted as a value rather than by capturing the console. */
function collectWarnings() {
  const lines: string[] = [];
  return { warn: (message: string) => void lines.push(message), lines };
}

const silent = () => {};

describe("the slug grammar", () => {
  test.each([
    "herdr-interface-anatomy",
    "medium-digest-2026-08-16",
    "2026-09-06-promote-pipeline-occ",
    "a",
    "x9",
  ])("admits the kb slug %s", (slug) => {
    expect(isDocumentSlug(slug)).toBe(true);
  });

  // Every one of these is a way to point a CREDENTIALLED loopback request at an endpoint this
  // module did not mean to call, or at a second request entirely. They are refused by a closed
  // charset rather than removed by an escaper, because an escaper is a thing that can have a bug.
  test.each([
    ["a separator reaches another kb route", "../healthz"],
    ["a bare slash does the same", "documents/x/html"],
    ["an encoded separator is never decoded, so it stays these literal characters", "%2e%2e%2fhealthz"],
    ["an uppercase escape is the same trick", "%2Fhealthz"],
    ["a query aims the same path at a different call", "x?limit=999"],
    ["a fragment is not part of a path kb ever sees", "x#y"],
    ["CRLF would append a second request", "x\r\nX-Internal-Token: stolen"],
    ["a NUL byte, which some readers truncate at and others do not", "x\u0000.html"],
    ["a space is not in any kb slug", "two words"],
    ["kb's canonical slugs never lead with a hyphen", "-leading"],
    ["an empty path segment is not a slug", ""],
    ["kb slugs are lowercase", "Herdr"],
  ])("refuses %s", (_why, slug) => {
    expect(isDocumentSlug(slug)).toBe(false);
  });

  test("refuses a slug past the ceiling", () => {
    // The ceiling exists so an absurd path is refused by the grammar rather than by whatever gives
    // out first further down — a URL length limit in Bun, or kb's own parser, or nothing at all.
    expect(isDocumentSlug("a".repeat(128))).toBe(true);
    expect(isDocumentSlug("a".repeat(129))).toBe(false);
  });
});

describe("documentSlugFromPath", () => {
  test("reads the slug out of the route's own path", () => {
    expect(documentSlugFromPath("/api/doc/herdr-interface-anatomy")).toBe("herdr-interface-anatomy");
  });

  // A prefix-sharing path must not be swallowed. `/api/docs` and `/api/document` are neighbours a
  // future route could plausibly want, and answering them here would serve a document where another
  // API belongs — the trailing slash in the prefix is what keeps them apart.
  test.each(["/api/docs", "/api/document/x", "/api/doc", "/api/doc/", "/settings", "/d/x", "/"])(
    "leaves %s alone",
    (pathname) => {
      expect(documentSlugFromPath(pathname)).toBeNull();
    },
  );

  test("a path that is under the prefix but is not a slug still gets nothing", () => {
    // The prefix check and the grammar are two separate questions, and this is the one that matters:
    // everything under the prefix reaches the grammar, so the tail of a path can never become a
    // second kb route just because the leading segments were right.
    expect(documentSlugFromPath("/api/doc/a/b")).toBeNull();
    expect(documentSlugFromPath("/api/doc/../healthz")).toBeNull();
    expect(documentSlugFromPath("/api/doc/%2e%2e%2fhealthz")).toBeNull();
  });

  // The prefix is spelled three times across two halves of the app — here, as a literal in
  // server.ts's `startsWith` (which the route golden reads), and as `DOC_PROXY_PATH` in
  // web/src/lib/doc-links.ts. This pins the one in this module; bridge/doc-path-contract.test.ts
  // pins it against the client's.
  test("the prefix lives under /api/, so the service worker passes it to the network", () => {
    // An iframe's document load is a NAVIGATION, and the SW answers navigations from the precached
    // app shell unless the path is on NAVIGATION_NETWORK_ONLY. `/^\/api\//` is already on that
    // list; a prefix outside it would render a second copy of Collie inside the panel, and would
    // have looked perfectly fine in a browser tab with no service worker.
    expect(DOCUMENT_PATH_PREFIX.startsWith("/api/")).toBe(true);
    expect(DOCUMENT_PATH_PREFIX.endsWith("/")).toBe(true);
  });
});

describe("the served document's headers", () => {
  const headers = documentResponseHeaders(HTML_ETAG);

  test("the policy is the exact string, sandbox first", () => {
    // Pinned literally because every clause below is a separate claim about it, and a policy
    // assembled by three different edits is how one of them quietly stops being true.
    expect(headers["content-security-policy"]).toBe(
      "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
        "base-uri 'none'; frame-ancestors 'self'",
    );
    expect(DOCUMENT_CSP).toBe(headers["content-security-policy"]);
  });

  test("the sandbox grants nothing — no scripts, no forms, no popups, no same-origin", () => {
    // The opaque origin is what stops an agent-authored document reading Collie's localStorage or
    // calling /api/* with the Access header attached. `allow-same-origin` would undo all of it in
    // one word, and 29 of the operator's 52 documents ship an inline <script> that would then run.
    expect(DOCUMENT_CSP).toMatch(/^sandbox;/u);
    expect(DOCUMENT_CSP).not.toContain("allow-");
  });

  test("framing is allowed for Collie and nobody else", () => {
    // Two failures live here, and both are invisible. `frame-ancestors 'none'` (what reusing the
    // app's own CSP constant would give) renders the panel blank with nothing in the bridge's log;
    // omitting the directive entirely leaves the document framable from any origin on the internet,
    // which looks exactly like working.
    expect(DOCUMENT_CSP).toContain("frame-ancestors 'self'");
    expect(DOCUMENT_CSP).not.toContain("frame-ancestors 'none'");
  });

  test("a leftover <base href=\"about:srcdoc\"> is disarmed by policy, not by rewriting bytes", () => {
    // 34 of 52 live documents carry that tag, put there for kb's srcdoc viewer. Collie loads by
    // URL, so without `base-uri 'none'` every `href="#section"` resolves against about:srcdoc and a
    // tapped contents entry navigates instead of scrolling — broken in 28 documents, and the reason
    // those documents ship a script shim this policy does not run.
    expect(DOCUMENT_CSP).toContain("base-uri 'none'");
  });

  test("what these documents are actually made of still renders", () => {
    // Inline <style> blocks and base64 data: images ARE the document — a median one is mostly
    // inlined WebP. With `default-src 'none'` and neither of these, the panel shows unstyled text
    // and empty image frames, which reads as "the proxy is broken" rather than "the policy is tight".
    expect(DOCUMENT_CSP).toContain("style-src 'unsafe-inline'");
    expect(DOCUMENT_CSP).toContain("img-src data:");
    expect(DOCUMENT_CSP).toContain("default-src 'none'");
  });

  test("the type is the literal, and the tag validates rather than expires", () => {
    // Never derived from what kb said: these bytes go into a frame as HTML, so a relayed or sniffed
    // type could only ever be a way to be wrong. `no-cache` + a strong tag is the house rule for
    // bytes that are not content-addressed — an edited document appears on the next open.
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["cache-control"]).toBe("no-cache");
    expect(headers.etag).toBe(HTML_ETAG);
  });
});

describe("documentEtag", () => {
  test("a digest becomes a strong tag naming Collie's representation", () => {
    // The `d1:` prefix is what makes a future body transform invalidatable: without it, a phone
    // would keep serving the old representation from cache under a tag that still matched.
    expect(documentEtag(HTML_SHA256)).toBe(`"d1:${HTML_SHA256}"`);
  });

  test.each([
    ["a newline, which would be response-header injection", `${HTML_SHA256}\r\nx: y`],
    ["a quote, which would end the tag early", `"${HTML_SHA256}"`],
    ["uppercase hex, which kb never sends", HTML_SHA256.toUpperCase()],
    ["a short digest", "abc123"],
    ["nothing", ""],
  ])("refuses %s", (_why, digest) => {
    // This value goes into a response header. "kb only ever sends lowercase hex" is a fact about
    // today's kb, not a property of this function, and the header is emitted either way.
    expect(documentEtag(digest)).toBeNull();
  });
});

describe("normaliseAgentry", () => {
  test("an absolute home and binary switch the store on; a trailing slash is dropped", () => {
    expect(normaliseAgentry({ home: "/Users/op/agentry-data/", cli: CLI })).toEqual({ home: "/Users/op/agentry-data", cli: CLI });
  });

  test.each([
    ["nothing configured", { home: "", cli: CLI }],
    ["a relative home, which would resolve against the bridge's cwd", { home: "agentry-data", cli: CLI }],
    ["a bare binary name, which launchd's PATH would not find", { home: "/x", cli: "agentry" }],
    ["no binary", { home: "/x", cli: "" }],
  ])("refuses %s", (_why, value) => {
    expect(normaliseAgentry(value)).toBeNull();
  });
});

describe("the SQL a slug becomes", () => {
  test("a literal is single-quoted with each quote doubled — the one way to end a DuckDB string", () => {
    expect(sqlText("plain")).toBe("'plain'");
    expect(sqlText("it's")).toBe("'it''s'");
    expect(sqlText("'; SELECT 1; --")).toBe("'''; SELECT 1; --'");
    // A backslash is NOT an escape in DuckDB's standard strings, so it is left alone.
    expect(sqlText("a\\'b")).toBe("'a\\''b'");
  });

  test("the row query names one slug, quoted, and asks for the columns the route checks", () => {
    expect(documentRowSql(SLUG)).toBe(
      `SELECT slug, title, html_path, html_sha256, html_bytes FROM documents_latest WHERE slug = '${SLUG}' LIMIT 1`,
    );
  });

  test("agentry runs as an argv with the SQL as one argument, never through a shell", () => {
    expect(agentryQueryArgv({ home: HOME, cli: CLI }, "SELECT 1")).toEqual([
      CLI, "query", "--home", HOME, "--format", "json", "--no-limit", "SELECT 1",
    ]);
  });
});

describe("fetchDocument — the happy path", () => {
  test("looks the slug up in agentry, then reads the ROW's file from the documents directory", async () => {
    const fx = agentry(envelope([row()]));
    const result = await fetchDocument(SLUG, settings, null, fx.io, silent);
    expect(result).toEqual({
      ok: true,
      unchanged: false,
      metadata: { slug: SLUG, title: TITLE, etag: HTML_ETAG, sizeBytes: Buffer.byteLength(HTML) },
      html: HTML,
    });
    expect(fx.argv).toEqual([agentryQueryArgv({ home: HOME, cli: CLI }, documentRowSql(SLUG))]);
    expect(fx.reads).toHaveLength(1);
    expect(fx.reads[0]!.endsWith(`/documents/${SLUG}.html`)).toBe(true);
  });

  test("a matching If-None-Match answers from the row and never reads the file", async () => {
    const fx = agentry(envelope([row()]));
    const result = await fetchDocument(SLUG, settings, HTML_ETAG, fx.io, silent);
    expect(result).toMatchObject({ ok: true, unchanged: true, metadata: { etag: HTML_ETAG } });
    expect(fx.reads).toEqual([]);
  });

  test("the query runs on a deadline", () => {
    expect(AGENTRY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("fetchDocument — refusing before anything is run", () => {
  test.each(["../etc/passwd", "a'b", "UPPER", "", "x".repeat(200)])("a slug outside the grammar (%s) runs nothing", async (slug) => {
    expect(await fetchDocument(slug, settings, null, untouchable, silent)).toEqual({ ok: false, reason: "bad_slug" });
  });

  test("an unconfigured bridge runs nothing and says nothing", async () => {
    const w = collectWarnings();
    const result = await fetchDocument(SLUG, { home: "", cli: CLI }, null, untouchable, w.warn);
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(w.lines).toEqual([]);
  });

  test("a relative home is refused loudly, and run never", async () => {
    const w = collectWarnings();
    const result = await fetchDocument(SLUG, { home: "agentry-data", cli: CLI }, null, untouchable, w.warn);
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(w.lines.join("\n")).toContain("absolute");
  });
});

describe("fetchDocument — telling the failures apart", () => {
  test("no row is a stale link", async () => {
    expect(await fetchDocument(SLUG, settings, null, agentry(envelope([])).io, silent)).toEqual({ ok: false, reason: "not_found" });
  });

  test("agentry past its deadline is unreachable, with its own line", async () => {
    const w = collectWarnings();
    const result = await fetchDocument(SLUG, settings, null, agentry({ code: null, stdout: "", timedOut: true }).io, w.warn);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(w.lines[0]).toContain(String(AGENTRY_TIMEOUT_MS));
  });

  test("a binary that is not there is unreachable, never a missing document", async () => {
    const result = await fetchDocument(SLUG, settings, null, agentry({ code: 127, stdout: "", timedOut: false }).io, silent);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  test("agentry's own error is unusable, and its message (which can quote the SQL) is not logged", async () => {
    const w = collectWarnings();
    const failed = { ok: false, error: { code: "USAGE", message: "syntax error near sentinel-must-not-log" } };
    const result = await fetchDocument(SLUG, settings, null, agentry({ code: 2, stdout: JSON.stringify(failed), timedOut: false }).io, w.warn);
    expect(result).toEqual({ ok: false, reason: "unusable" });
    expect(w.lines.join("\n")).toContain("USAGE");
    expect(w.lines.join("\n")).not.toContain("sentinel-must-not-log");
  });

  test("output that is not the envelope is unusable", async () => {
    const result = await fetchDocument(SLUG, settings, null, agentry({ code: 0, stdout: "not json", timedOut: false }).io, silent);
    expect(result).toEqual({ ok: false, reason: "unusable" });
  });

  test.each([
    ["a digest that is not hex", { html_sha256: "zz" }],
    ["no html_path", { html_path: null }],
    ["an empty html_path", { html_path: "" }],
    ["a byte count that is not a count", { html_bytes: -1 }],
    ["a slug outside the grammar", { slug: "../x" }],
  ])("a row with %s is refused, not guessed at", async (_why, over) => {
    const fx = agentry(envelope([row(over)]));
    expect(await fetchDocument(SLUG, settings, null, fx.io, silent)).toEqual({ ok: false, reason: "unusable" });
    expect(fx.reads).toEqual([]);
  });

  test("a document over the ceiling is refused BEFORE its file is read", async () => {
    const fx = agentry(envelope([row({ html_bytes: MAX_DOCUMENT_BYTES + 1 })]));
    expect(await fetchDocument(SLUG, settings, null, fx.io, silent)).toEqual({ ok: false, reason: "unusable" });
    expect(fx.reads).toEqual([]);
  });

  test("bytes that do not hash to the recorded digest are not served", async () => {
    const fx = agentry(envelope([row({ html_sha256: "0".repeat(64) })]));
    expect(await fetchDocument(SLUG, settings, null, fx.io, silent)).toEqual({ ok: false, reason: "unusable" });
  });

  test("a row whose file is gone is agentry's index ahead of its disk, not a stale link", async () => {
    const fx = agentry(envelope([row({ html_path: "vanished.html" })]));
    expect(await fetchDocument(SLUG, settings, null, fx.io, silent)).toEqual({ ok: false, reason: "unusable" });
  });

  test("bytes that are not UTF-8 are refused rather than served with replacement characters", async () => {
    const bad = Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]);
    const sha = new Bun.CryptoHasher("sha256").update(bad).digest("hex");
    writeFileSync(join(HOME, "documents", "latin1.html"), bad);
    const fx = agentry(envelope([row({ html_path: "latin1.html", html_sha256: sha, html_bytes: bad.byteLength })]));
    expect(await fetchDocument(SLUG, settings, null, fx.io, silent)).toEqual({ ok: false, reason: "unusable" });
  });
});

describe("fetchDocument — the row's path stays inside the documents directory", () => {
  // The path read is the one agentry's ROW names, never one built from the phone's slug — but a row
  // is still data, and a row that names a path outside `documents/` (or a link out of it) must not
  // turn this route into a reader of the rest of the disk. The target file hashes correctly on
  // purpose: only the containment check stands between these rows and a 200.
  test.each([
    ["a parent-directory escape", "../secret.html"],
    ["an absolute path", join(HOME, "secret.html")],
    ["a symlink inside documents/ that points out of it", "linked-out.html"],
  ])("%s is refused and never read", async (_why, htmlPath) => {
    const fx = agentry(envelope([row({ html_path: htmlPath })]));
    const w = collectWarnings();
    expect(await fetchDocument(SLUG, settings, null, fx.io, w.warn)).toEqual({ ok: false, reason: "unusable" });
    expect(fx.reads).toEqual([]);
    expect(w.lines.join("\n")).toContain("outside the documents directory");
  });
});

describe("isDocumentSlug covers every live agentry slug shape", () => {
  test("a long medium-digest slug is admitted", () => {
    expect(isDocumentSlug("google-l5-level-interview-if-you-join-10-tables-in-an-sql-query-how-would-you-optimize")).toBe(true);
  });
});
