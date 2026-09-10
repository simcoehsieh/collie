import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_CSP,
  DOCUMENT_PATH_PREFIX,
  KB_TIMEOUT_MS,
  MAX_DOCUMENT_BYTES,
  documentEtag,
  documentResponseHeaders,
  documentSlugFromPath,
  fetchDocument,
  isDocumentSlug,
  isKbDocumentId,
  kbDocumentHtmlUrl,
  kbHeaders,
  kbMetadataUrl,
  normaliseKbOrigin,
  type KbAnswer,
  type KbIo,
  type KbRequestInit,
  type KbSettings,
} from "./docs.ts";

// The route that serves somebody else's HTML from Collie's own origin. Two questions run through
// every case below, and they are the two the feature lives or dies on:
//
//   1. WHAT MAY BECOME A REQUEST — the slug is interpolated into a loopback call carrying the
//      bridge's kb credential, so the grammar is the boundary and it is asserted by its refusals.
//   2. WHAT THE BROWSER IS TOLD ABOUT THE BYTES — the sandbox, and the two directives either side
//      of it whose absence fails silently rather than loudly.
//
// Everything is driven through the injected `KbIo`, so nothing here opens a socket. The token in
// every fixture is a recognisable sentinel precisely so the last test can prove it never escapes.

const TOKEN = "sentinel-token-must-never-escape";
const ORIGIN = "http://127.0.0.1:8082";
const ID = "06357161-2e6d-4070-a411-926f3dd2a9d1";

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

/** kb's metadata answer, field for field as the live API returns it. */
function metadataJson(over: Record<string, string | number> = {}): string {
  return JSON.stringify({
    id: ID,
    folder_id: "61d4d0b9-a974-47ef-b357-493376389628",
    slug: "herdr-interface-anatomy",
    title: "Herdr 介面解剖：五個名詞與各自能做什麼",
    summary: "herdr 0.8.2 的介面與物件模型導覽。",
    lifecycle_status: "knowledge",
    html_size_bytes: Buffer.byteLength(HTML, "utf8"),
    content_sha256: HTML_SHA256,
    created_at: "2026-09-06T13:46:26Z",
    updated_at: "2026-09-06T13:46:34Z",
    ...over,
  });
}

/**
 * One kb answer. `content-length` is supplied the way kb supplies it on every response; passing
 * null for it is how the "kb sent no length" case is written.
 */
function kbAnswer(
  status: number,
  text: string,
  over: Record<string, string | null> = {},
): KbAnswer {
  const headers = new Map<string, string>([
    ["content-length", String(Buffer.byteLength(text, "utf8"))],
    ["content-type", "application/json; charset=utf-8"],
  ]);
  for (const [name, value] of Object.entries(over)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return {
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => text,
  };
}

/** A chunked kb answer: no Content-Length, the bytes arrive on a stream in 4 KB pieces. */
function streamedAnswer(status: number, text: string, contentType: string): KbAnswer {
  const bytes = Buffer.from(text, "utf8");
  const headers = new Map<string, string>([["content-type", contentType]]);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 4096)));
      offset += 4096;
    },
  });
  return {
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => text,
    body,
  };
}

const htmlAnswer = (text = HTML): KbAnswer =>
  kbAnswer(200, text, { "content-type": "text/html; charset=utf-8" });

interface Call {
  url: string;
  init: KbRequestInit;
}

/** One scripted kb, plus the record of what it was asked — the assertion half of most cases below. */
interface KbFixture {
  io: KbIo;
  calls: Call[];
}

/** An io that answers from a URL→answer table and records what it was asked. A miss throws. */
function kbIo(routes: Record<string, KbAnswer | Error>): KbFixture {
  const calls: Call[] = [];
  return {
    calls,
    io: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        const answer = routes[url];
        if (answer === undefined) throw new Error(`no fixture for ${url}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

/** The io no test may reach: proof that a refusal happened before anything was dialled. */
const unreachableIo: KbIo = {
  fetch: async () => {
    throw new Error("kb must not be contacted for this request");
  },
};

const settings: KbSettings = { origin: ORIGIN, token: TOKEN };

const happyRoutes = () => ({
  [kbMetadataUrl(ORIGIN, "herdr-interface-anatomy")]: kbAnswer(200, metadataJson()),
  [kbDocumentHtmlUrl(ORIGIN, ID)]: htmlAnswer(),
});

/** The injected `warn`, so a warning is asserted as a value rather than by capturing the console. */
interface Warnings {
  warn: (message: string) => void;
  lines: string[];
}

function collectWarnings(): Warnings {
  const lines: string[] = [];
  return { warn: (message) => void lines.push(message), lines };
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

describe("normaliseKbOrigin", () => {
  test.each(["http://127.0.0.1:8082", "http://localhost:8082", "http://[::1]:8082"])(
    "accepts the loopback form %s",
    (origin) => {
      expect(normaliseKbOrigin(origin)).toBe(origin);
    },
  );

  test("strips a trailing slash so the built URL has exactly one", () => {
    // Without this, `${origin}/api/documents/x` is `http://127.0.0.1:8082//api/…` — which kb may or
    // may not route, and which nobody wants to debug from a phone.
    expect(normaliseKbOrigin("http://127.0.0.1:8082/")).toBe("http://127.0.0.1:8082");
  });

  // THE EGRESS BOUNDARY. If this ever admits a public host, one typo in an env var turns the bridge
  // into an open proxy that pulls arbitrary internet content into Collie's own origin — with the
  // sandbox as the only remaining thing between that content and the operator.
  test.each([
    ["a public host", "https://knowledge.agnex.dev"],
    ["a LAN address that is not loopback", "http://192.168.1.10:8082"],
    ["a host that merely starts like loopback", "http://localhost.evil.example"],
    ["a non-HTTP scheme", "file:///etc/passwd"],
    ["something that is not a URL at all", "127.0.0.1:8082"],
    ["nothing", ""],
  ])("refuses %s", (_why, origin) => {
    expect(normaliseKbOrigin(origin)).toBeNull();
  });

  test("refuses an origin that carries a path, a query or a fragment", () => {
    // `http://127.0.0.1:8082/api` would build `…/api/api/documents/x`; a 404 from a doubled prefix
    // is a bad way to learn about a config mistake, and a query would ride every call kb receives.
    expect(normaliseKbOrigin("http://127.0.0.1:8082/api")).toBeNull();
    expect(normaliseKbOrigin("http://127.0.0.1:8082/?debug=1")).toBeNull();
    expect(normaliseKbOrigin("http://127.0.0.1:8082/#x")).toBeNull();
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

describe("isKbDocumentId", () => {
  test("admits the UUID kb returns, and nothing that could be a path", () => {
    // The id is interpolated into a URL exactly as the slug is. That it arrived from kb rather than
    // from the phone is not a reason to skip the grammar — a rule with a trusted-source exception
    // stops being checkable the day the source changes.
    expect(isKbDocumentId(ID)).toBe(true);
    expect(isKbDocumentId("herdr-interface-anatomy")).toBe(false);
    expect(isKbDocumentId(`${ID}/../healthz`)).toBe(false);
    expect(isKbDocumentId("")).toBe(false);
  });
});

describe("fetchDocument — the happy path", () => {
  test("resolves the slug, then fetches the HTML, presenting the token on both hops", async () => {
    const { io, calls } = kbIo(happyRoutes());
    const result = await fetchDocument("herdr-interface-anatomy", settings, null, io, silent);

    expect(result.ok).toBe(true);
    if (!result.ok || result.unchanged) throw new Error("expected a served document");
    expect(result.html).toBe(HTML);
    expect(result.metadata.etag).toBe(HTML_ETAG);
    expect(result.metadata.slug).toBe("herdr-interface-anatomy");
    // The title comes back because the frame is an opaque origin: the panel cannot read the
    // document's own <title> across it, so if the bridge does not carry it, nothing can.
    expect(result.metadata.title).toContain("Herdr");

    // TWO hops, in this order, because kb's /html route answers 400 to a slug — a single-hop
    // "optimisation" would 400 on every document in the corpus.
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:8082/api/documents/herdr-interface-anatomy",
      `http://127.0.0.1:8082/api/documents/${ID}/html`,
    ]);
    for (const call of calls) {
      expect(call.init.headers["x-internal-token"]).toBe(TOKEN);
    }
  });

  test("neither hop will follow a redirect, and both are on a deadline", async () => {
    // `redirect: "follow"` is the default and it is the leak: the fetch spec strips Authorization,
    // Cookie and Proxy-Authorization across origins and says nothing about a custom header, so
    // x-internal-token would travel to whatever host a Location named. The deadline is for the
    // other failure — a container that is alive but wedged, which without it hangs until Bun closes
    // the phone's connection with nothing said.
    const { io, calls } = kbIo(happyRoutes());
    await fetchDocument("herdr-interface-anatomy", settings, null, io, silent);
    for (const call of calls) {
      expect(call.init.redirect).toBe("manual");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(KB_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("a matching If-None-Match answers after ONE hop and never asks for the body", async () => {
    // The whole reason the two-hop design is cheap: kb's content_sha256 is taken over the exact
    // bytes /html returns, so the metadata alone settles a conditional request. Lose this and a
    // warm phone re-downloads a 2 MB document over a mobile link every time the panel opens.
    const { io, calls } = kbIo({
      [kbMetadataUrl(ORIGIN, "herdr-interface-anatomy")]: kbAnswer(200, metadataJson()),
    });
    const result = await fetchDocument("herdr-interface-anatomy", settings, HTML_ETAG, io, silent);
    expect(result).toEqual({
      ok: true,
      unchanged: true,
      metadata: {
        slug: "herdr-interface-anatomy",
        title: "Herdr 介面解剖：五個名詞與各自能做什麼",
        etag: HTML_ETAG,
        sizeBytes: Buffer.byteLength(HTML, "utf8"),
      },
    });
    expect(calls).toHaveLength(1);
  });
});

describe("fetchDocument — refusing before anything is dialled", () => {
  test.each(["../healthz", "%2e%2e%2fhealthz", "", "Herdr", "x\r\ny"])(
    "never contacts kb about %s",
    async (slug) => {
      // The grammar runs before the configuration check and before any string is concatenated, so
      // there is no ordering in which an unvalidated segment reaches a URL. If this ever fails, the
      // failure is not a 404 — it is a credentialled request to an endpoint nobody chose.
      const result = await fetchDocument(slug, settings, null, unreachableIo, silent);
      expect(result).toEqual({ ok: false, reason: "bad_slug" });
    },
  );

  test("an unconfigured bridge asks nothing and says nothing", async () => {
    // Silence is the feature being declined by doing nothing (CLAUDE.md's outbound-call posture).
    // A warning per request would punish every operator who never wanted a document panel.
    const { warn, lines } = collectWarnings();
    const off: KbSettings = { origin: "", token: "" };
    const result = await fetchDocument("herdr-interface-anatomy", off, null, unreachableIo, warn);
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(lines).toEqual([]);
  });

  test("an origin that is not loopback is refused loudly, and dialled never", async () => {
    // The opposite case from the one above: the operator meant to switch this on, and it is off for
    // a reason only this line will tell them. Refusing here is also what keeps the bridge from
    // proxying the open web into its own origin.
    const { warn, lines } = collectWarnings();
    const result = await fetchDocument(
      "herdr-interface-anatomy",
      { origin: "https://knowledge.agnex.dev", token: TOKEN },
      null,
      unreachableIo,
      warn,
    );
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("loopback");
  });

  test("a configured origin with no token is the feature being off, not an auth failure", async () => {
    // Reporting this as `unauthorised` would send the operator looking at kb's logs for a request
    // that was never made.
    const result = await fetchDocument(
      "herdr-interface-anatomy",
      { origin: ORIGIN, token: "  " },
      null,
      unreachableIo,
      silent,
    );
    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("fetchDocument — telling the failures apart", () => {
  test("a rejected credential is NEVER reported as a missing document", async () => {
    // kb's auth middleware runs before routing, so a bad token against a slug that does not exist
    // answers 401, not 404 — the two can never overlap. Flattening this into "not found" is the
    // failure that costs a debugging session: the operator goes looking for a deleted document
    // when the real answer is that this bridge's token is stale.
    const { io } = kbIo({
      [kbMetadataUrl(ORIGIN, "herdr-interface-anatomy")]: kbAnswer(401, "unauthorized\n", {
        "content-type": "text/plain; charset=utf-8",
      }),
    });
    const result = await fetchDocument("herdr-interface-anatomy", settings, null, io, silent);
    expect(result).toEqual({ ok: false, reason: "unauthorised" });
  });

  test("a credential rejected on the SECOND hop is still a misconfiguration", async () => {
    // Reachable when kb's own secret is rotated between the two calls. It is also where a
    // classifier that only checks auth on the first hop would fall through and report the document
    // as corrupt — sending the operator to look at kb's filesystem over a token they just changed.
    // The 401 body is plain text (`http.Error`), not the JSON envelope every other error uses, so
    // anything that read the body before the status would throw here rather than answer.
    const { io } = kbIo({
      ...happyRoutes(),
      [kbDocumentHtmlUrl(ORIGIN, ID)]: kbAnswer(401, "unauthorized\n", {
        "content-type": "text/plain; charset=utf-8",
      }),
    });
    await expect(
      fetchDocument("herdr-interface-anatomy", settings, null, io, silent),
    ).resolves.toEqual({ ok: false, reason: "unauthorised" });
  });

  test("an authenticated 404 is a stale link and says so", async () => {
    const { io } = kbIo({
      [kbMetadataUrl(ORIGIN, "gone")]: kbAnswer(404, JSON.stringify({ error: "document not found" })),
    });
    // The one refusal a client is allowed to see plainly: the operator tapped a link to a document
    // that has been deleted, and "no such document" is the true and actionable answer.
    expect(await fetchDocument("gone", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("containers being down is a throw, and never looks like a 404", async () => {
    // Nothing listening on loopback is a refused connect — a rejected promise, not a Response — so
    // this distinction needs no status inspection and cannot be confused with a missing document.
    // If it were, the phone would say "not found" while the fix is `docker compose up`.
    const refused = new Error("Unable to connect. Is the computer able to access the url?");
    const { io } = kbIo({ [kbMetadataUrl(ORIGIN, "herdr-interface-anatomy")]: refused });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("a wedged container lands in the same bucket, with its own line", async () => {
    // Alive but not answering (exhausted DB pool, lagging healthcheck) is the failure the deadline
    // exists for. The operator has one move for both, so the reason is shared; the log line is not,
    // because "did not answer" and "could not be reached" send you to different places.
    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    const { warn, lines } = collectWarnings();
    const { io } = kbIo({ [kbMetadataUrl(ORIGIN, "herdr-interface-anatomy")]: timeout });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, warn)).toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(lines[0]).toContain(String(KB_TIMEOUT_MS));
  });

  test("a metadata answer that is not the document contract is refused, not guessed at", async () => {
    // A 200 whose body has no `id` cannot produce a second hop, and inventing one would build a URL
    // out of whatever was there instead.
    const { io } = kbIo({
      [kbMetadataUrl(ORIGIN, "herdr-interface-anatomy")]: kbAnswer(200, JSON.stringify({ slug: "x" })),
    });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  test("an id that is not a UUID never becomes a URL", async () => {
    // The metadata is data, exactly like the request path was. Without this the second hop's URL is
    // assembled from a string kb happened to send.
    const { io, calls } = kbIo({
      [kbMetadataUrl(ORIGIN, "herdr-interface-anatomy")]: kbAnswer(
        200,
        metadataJson({ id: "../../healthz" }),
      ),
    });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(calls).toHaveLength(1);
  });

  test("a document over the ceiling is refused BEFORE its body is asked for", async () => {
    // kb publishes the byte count in the metadata, so an oversized document costs a 1 KB JSON
    // answer rather than a multi-megabyte download that is then thrown away.
    const { io, calls } = kbIo({
      [kbMetadataUrl(ORIGIN, "huge")]: kbAnswer(
        200,
        metadataJson({ slug: "huge", html_size_bytes: MAX_DOCUMENT_BYTES + 1 }),
      ),
    });
    expect(await fetchDocument("huge", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(calls).toHaveLength(1);
  });

  test("bytes that do not hash to the advertised digest are not served", async () => {
    // The ETag this bridge publishes is derived from kb's digest, so if the bytes disagree with it
    // the phone caches the wrong body under a tag that keeps matching — wrong until the operator
    // clears site data, which is not a thing anyone does from a phone.
    const { io } = kbIo({
      ...happyRoutes(),
      [kbDocumentHtmlUrl(ORIGIN, ID)]: htmlAnswer(HTML.replace("Herdr", "Tampered")),
    });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  test("an answer that is not HTML is refused rather than relabelled", async () => {
    // These bytes are about to be served as text/html from Collie's own origin. If kb sent JSON,
    // saying so is better than putting an HTML content-type on it and finding out in the panel.
    const { io } = kbIo({
      ...happyRoutes(),
      [kbDocumentHtmlUrl(ORIGIN, ID)]: kbAnswer(200, HTML),
    });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  test("a body with no declared length is read chunk by chunk up to the cap", async () => {
    // kb is Go's net/http: anything past its 4 KB write buffer goes out chunked, with no
    // Content-Length. That is most tag lists and every full page of documents, so an answer without
    // a length is ordinary — it is read from the stream and capped as it arrives, never buffered
    // past the ceiling.
    const { io } = kbIo({
      ...happyRoutes(),
      [kbDocumentHtmlUrl(ORIGIN, ID)]: streamedAnswer(200, HTML, "text/html; charset=utf-8"),
    });
    const served = await fetchDocument("herdr-interface-anatomy", settings, null, io, silent);
    expect(served.ok).toBe(true);
    if (served.ok && !served.unchanged) expect(served.html).toBe(HTML);
  });

  test("a streamed body that runs past the cap is dropped where it crosses it", async () => {
    const oversized = "字".repeat(MAX_DOCUMENT_BYTES / 3 + 1024);
    const { io } = kbIo({
      ...happyRoutes(),
      [kbDocumentHtmlUrl(ORIGIN, ID)]: streamedAnswer(200, oversized, "text/html; charset=utf-8"),
    });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  test("a declared length that undersells the body does not get the body served", async () => {
    // The declared length is a claim and the ceiling is measured against the bytes: a peer that
    // promises 40 and sends megabytes must not be able to walk a document past the cap by lying
    // about it. Measured in BYTES, not characters — one CJK glyph in these documents is three.
    const oversized = "字".repeat(MAX_DOCUMENT_BYTES);
    const { io } = kbIo({
      ...happyRoutes(),
      [kbDocumentHtmlUrl(ORIGIN, ID)]: {
        status: 200,
        headers: {
          get: (name) =>
            name.toLowerCase() === "content-length" ? "40" : "text/html; charset=utf-8",
        },
        text: async () => oversized,
      },
    });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  test("metadata that resolves and HTML that 404s is corruption, not a stale link", async () => {
    // The document existed a millisecond ago, so this is kb's DB being ahead of its filesystem —
    // its own handler names the case. Reporting it as "no such document" would send the operator
    // looking for a link they deleted instead of at a kb that needs attention.
    const { warn, lines } = collectWarnings();
    const { io } = kbIo({
      ...happyRoutes(),
      [kbDocumentHtmlUrl(ORIGIN, ID)]: kbAnswer(404, JSON.stringify({ error: "html file missing" })),
    });
    expect(await fetchDocument("herdr-interface-anatomy", settings, null, io, warn)).toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(lines.join(" ")).toContain("404");
  });
});

describe("fetchDocument — the renamed slug", () => {
  const stale = kbMetadataUrl(ORIGIN, "old-name");
  const redirected = (canonical: string): KbAnswer =>
    kbAnswer(308, JSON.stringify({ canonical_slug: canonical }));

  test("a 308 is followed by hand, to the canonical slug, exactly once", async () => {
    // Absorbed on a hop this module was making anyway, so a stale knowledge.agnex.dev link tapped
    // out of months-old scrollback just works. Following it by hand rather than letting fetch do it
    // is what keeps x-internal-token off any host a Location might name.
    const { io, calls } = kbIo({
      [stale]: redirected("herdr-interface-anatomy"),
      ...happyRoutes(),
    });
    const result = await fetchDocument("old-name", settings, null, io, silent);
    expect(result.ok).toBe(true);
    if (!result.ok || result.unchanged) throw new Error("expected a served document");
    // The CANONICAL slug comes back, not the one that was asked for — the caller cannot correct the
    // address bar, or log the rename, with the stale one.
    expect(result.metadata.slug).toBe("herdr-interface-anatomy");
    expect(calls.map((c) => c.url)).toEqual([
      stale,
      kbMetadataUrl(ORIGIN, "herdr-interface-anatomy"),
      kbDocumentHtmlUrl(ORIGIN, ID),
    ]);
  });

  test("the canonical slug is re-checked against the same grammar", async () => {
    // It arrives in a response body and goes straight back into a URL path. Trusting it because it
    // came from kb would be the same mistake as trusting the request path because it came from a
    // logged-in phone.
    const { io, calls } = kbIo({ [stale]: redirected("../../healthz") });
    expect(await fetchDocument("old-name", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(calls).toHaveLength(1);
  });

  test("a 308 body with no canonical_slug is refused, not retried blindly", async () => {
    // kb's 308 body carries only `canonical_slug` — there is no id in it, so there is no shortcut
    // and nothing to fall back on when the field is missing.
    const { io } = kbIo({ [stale]: kbAnswer(308, JSON.stringify({ message: "renamed" })) });
    expect(await fetchDocument("old-name", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  test("a 308 that redirects to a 308 stops", async () => {
    // Alias chains are not something kb creates; a second one means kb is behaving in a way this
    // module has no model of, and looping forever is the one outcome that must not be possible.
    const { io, calls } = kbIo({
      [stale]: redirected("second-name"),
      [kbMetadataUrl(ORIGIN, "second-name")]: redirected("third-name"),
    });
    expect(await fetchDocument("old-name", settings, null, io, silent)).toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(calls).toHaveLength(2);
  });
});

// THE CREDENTIAL LEAVES THIS MODULE IN EXACTLY ONE PLACE: the x-internal-token header. Every other
// exit — a result the route serialises, a warning that lands in the bridge's log, an error message
// carried up from a rejection — is checked here in one sweep, because a leak is invisible until
// somebody reads a log file they should not have to think about.
describe("the kb token", () => {
  test("is sent under the header kb's middleware actually matches", () => {
    // kb matches `X-Internal-Token` and nothing else, and its auth runs before routing — so a typo
    // in this name is indistinguishable from a wrong token, and both look like 401 on every path.
    expect(kbHeaders(TOKEN, "application/json")).toEqual({
      "x-internal-token": TOKEN,
      accept: "application/json",
    });
  });

  test("never appears in a result or a warning, on any path", async () => {
    const answers: Record<string, KbAnswer | Error>[] = [
      { [kbMetadataUrl(ORIGIN, "x")]: kbAnswer(401, `unauthorized ${TOKEN}\n`) },
      { [kbMetadataUrl(ORIGIN, "x")]: kbAnswer(404, JSON.stringify({ error: TOKEN })) },
      { [kbMetadataUrl(ORIGIN, "x")]: kbAnswer(500, JSON.stringify({ error: TOKEN })) },
      { [kbMetadataUrl(ORIGIN, "x")]: new Error(`connect failed for ${ORIGIN} with ${TOKEN}`) },
      { [kbMetadataUrl(ORIGIN, "x")]: kbAnswer(200, metadataJson({ slug: "x", id: TOKEN })) },
    ];
    for (const routes of answers) {
      const { warn, lines } = collectWarnings();
      const { io } = kbIo(routes);
      const result = await fetchDocument("x", settings, null, io, warn);
      // An upstream body is never relayed and an error's own message is never echoed: both can
      // carry a credential, a host or an account name that this bridge has no business repeating.
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(lines.join("\n")).not.toContain(TOKEN);
    }
  });
});
