import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { containedRealpath } from "./journal/files.ts";
import { runQuotaCommand, type QuotaRun } from "./quota.ts";
// Three generic readers for a field of an untrusted JSON object. They live under `stt/` because
// speech-to-text was their first caller, not because they know anything about it — and they are the
// readers named in .oxlintrc.json's `no-runtime-typeof` boundary override, so reusing them is also
// what keeps this file's parse of agentry's JSON lint-clean without widening that list.
import { jsonNumberField, jsonRecord, jsonStringField } from "./stt/json.ts";

// Serving ONE of the operator's archived documents from Collie's own origin, so a link an agent
// printed in the mirror can open in a panel beside the terminal instead of throwing the operator
// out of the PWA.
//
// ── WHERE THE DOCUMENTS LIVE (2026-09-26: agentry, not kb) ───────────────────────────────────────
// The archive used to be the knowledge system ("kb", a Go API on 127.0.0.1:8082) and this module
// was a credentialled loopback proxy to it. kb is being shut down; its documents now live in
// agentry: one row per slug in the `documents_latest` view (title, summary, tags, `html_path`,
// `html_sha256`, `html_bytes`) and the bytes at `$AGENTRY_HOME/documents/<html_path>`. Alfred
// (agentry's web front, alfred.agnex.dev) serves the same files, but every request it answers is
// gated on a Cloudflare Access JWT — loopback included — so there is no door on it this bridge
// could knock on without holding an Access credential. Reading agentry's own store is the one that
// needs nothing: `agentry query` for the row, the file for the bytes.
//
// ── WHY THIS IS SERVED FROM COLLIE'S ORIGIN AND NOT AN IFRAME OF THE REAL SITE ─────────────────────
// The obvious build is `<iframe src="https://alfred.agnex.dev/d/…">` and it cannot work. Six
// representative targets were MEASURED and all six refuse framing outright (github.com,
// developer.mozilla.org, docs.anthropic.com, news.ycombinator.com, stackoverflow.com, and the
// operator's own knowledge.agnex.dev). The operator's own services are worse than the strangers':
// they sit behind Cloudflare Access, Safari blocks third-party cookies, so a cross-origin frame
// would be handed the Access LOGIN page — which itself refuses framing. There is no header this
// repo can set that fixes somebody else's `X-Frame-Options`.
//
// Same-origin is what buys the three things the feature needs: Collie controls the framing headers,
// the Access cookie is first-party so the existing device auth is unchanged, and the app's own
// `default-src 'self'` already permits a same-origin frame with no policy weakened.
//
// ── THE SLUG NEVER BECOMES A PATH ───────────────────────────────────────────────────────────────
// CLAUDE.md allows a client-supplied value to become a path in exactly two places (the journal and
// the Changes view), and this is not a third, by the shape `GET /api/fonts/<basename>` uses: the
// slug is LOOKED UP in agentry's rows, and the path read is the one THAT ROW names — a slug nobody
// wrote is refused before any path exists. The row's path then goes through `containedRealpath`
// against the documents directory anyway, as an independent second check, so a row whose
// `html_path` points (or links) outside it is refused rather than read.
//
// ── NO OUTBOUND CALL, ONE SHORT-LIVED CHILD ─────────────────────────────────────────────────────
// Nothing here opens a socket. The one process spawned is `agentry query`, argv-only (no shell),
// on a deadline and an output cap, the same hygiene `COLLIE_QUOTA_COMMAND` runs under — and it is
// declined by doing nothing: with `COLLIE_AGENTRY_HOME` unset no process is spawned and no route
// answers. `agentry query` itself refuses anything but a read, so even SQL this module got wrong
// could not write; the literals are still built by {@link sqlText} and never spliced raw.
//
// ── WHAT ARRIVES IS A PROGRAM, NOT A PAGE ───────────────────────────────────────────────────────
// An archived document is HTML an AGENT wrote, often out of pages it read on the open web. Served
// same-origin with no policy it could run script in Collie's origin, read `localStorage`, and call
// `/api/*` with the Access header attached by the browser. So the response is dropped into an
// opaque origin — see {@link DOCUMENT_CSP}, which is the containment and is commented as such.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────
// It builds no `Response`. `secure()` in bridge/server.ts is module-private, and every response the
// bridge emits goes through it, so the final object is assembled there beside `muxLogoResponse` and
// `operatorFontResponse` — this file hands over the bytes and the headers those bytes need. It also
// runs no gate: nothing upstream authorises a non-`/api` path (a static asset reaches
// `serveStatic` with no `guard()` at all), so the route is where `guard(req, cfg, "read", pairing)`
// belongs, and forgetting it there is not something this file can catch.

/**
 * The path prefix the bridge answers documents on.
 *
 * UNDER `/api/`, and the prettier `/d/<slug>` was rejected for two concrete reasons. First, the
 * service worker answers every navigation from the precached app shell unless the path is on
 * `NAVIGATION_NETWORK_ONLY` (web/src/lib/sw-routes.ts) — and an iframe's document load IS a
 * navigation — so `/d/` would need a new entry in a list whose own comment reserves it for paths
 * NOBODY CAN MOVE (Cloudflare's `/cdn-cgi/`, Authentik's outpost). `/^\/api\//` is already there.
 * Second, `/api/` is where this repo puts everything that must be gated; `/api/health`'s comment
 * calls itself "the only `/api/*` route that is [ungated]", which is a convention worth joining
 * rather than a coincidence. The operator never reads this URL — it is the `src` of a frame.
 *
 * Spelled here AND as a literal in server.ts's `pathname.startsWith("/api/doc/")`, on purpose: the
 * route golden in solo-baseline.test.ts finds routes by reading server.ts for string literals, so a
 * registration that imports this constant would silently escape the one test whose job is that a
 * route arrives on purpose. The duplication is nine characters and it is pinned by this module's
 * own test; hiding it behind an import would cost the golden.
 *
 * web/src/lib/doc-links.ts spells the same prefix as `DOC_PROXY_PATH` for the client half. Those
 * two must agree or a tap opens the app shell inside the panel, so they are pinned together by
 * bridge/doc-path-contract.test.ts.
 */
export const DOCUMENT_PATH_PREFIX = "/api/doc/";

/**
 * The one grammar a document slug must satisfy, as a source string so a reader can see the whole
 * rule at once. kb's canonical slugs were `^[a-z0-9][a-z0-9-]*$` and every slug agentry holds today
 * still is (agentry itself also admits `.` and `_`, which no document uses); this adds a ceiling.
 *
 * It is an ALLOWLIST checked before anything is built, not a sanitiser run after. The string is
 * quoted into the SQL of an `agentry query` run (through `sqlText`, which would survive a quote
 * anyway), and nothing in `[a-z0-9-]` can end a literal, start a comment or name a path segment —
 * the answer is a closed charset and not only an escaper, because an escaper is a thing that can
 * have a bug.
 *
 * NOTHING IS EVER PERCENT-DECODED on the way here. `URL.pathname` preserves the escapes, `%` is not
 * in the charset, so an encoded separator is refused as the literal characters it arrives as —
 * decoding first is precisely the step that turns `%2f` into a separator, and it never happens.
 */
export const DOCUMENT_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,127}$";

/**
 * True when `value` is a slug this bridge will ask agentry about.
 *
 * The ceiling is 128 characters. The longest live slug is 86 (a medium-digest title), and the number exists
 * so a megabyte of hyphens is refused by the grammar rather than by whatever gives out first.
 */
export function isDocumentSlug(value: string): boolean {
  return new RegExp(DOCUMENT_SLUG_PATTERN, "u").test(value);
}

/**
 * The slug inside `/api/doc/<slug>`, or null when the path is not one this route can answer.
 *
 * Total, pure, and the ONLY place a request path becomes a slug — so the grammar cannot be reached
 * around by a second caller that forgot to ask.
 */
export function documentSlugFromPath(pathname: string): string | null {
  if (!pathname.startsWith(DOCUMENT_PATH_PREFIX)) return null;
  const slug = pathname.slice(DOCUMENT_PATH_PREFIX.length);
  return isDocumentSlug(slug) ? slug : null;
}

/**
 * The policy the document is served under. It is the containment, not decoration, and every
 * directive in it answers a measured fact about these documents.
 *
 * `sandbox` WITH NO TOKENS drops the response into an opaque origin: no scripts, no forms, no
 * popups, no top-level navigation, and — the load-bearing one — no access to Collie's origin. This
 * is `muxLogoResponse`'s posture and it is here for a stronger version of the same reason. An SVG
 * *could* carry script; a kb document *does*: 29 of the operator's 52 live documents contain an
 * inline `<script>`. Without the opaque origin those scripts would run as Collie, with the Access
 * cookie attached to anything they fetched.
 *
 * SCRIPTS STAY OFF, and the alternative was real. kb's own viewer chose the other way
 * (`sandbox="allow-scripts allow-popups allow-forms"`, `allow-same-origin` deliberately withheld),
 * and the opaque origin — not the script ban — is what protects the embedder in both designs. The
 * measured 0 of 52 documents touch `localStorage`, `document.cookie`, `fetch(` or `XMLHttpRequest`;
 * the scripts are anchor shims and one detail-panel toy. So allowing them would probably be safe.
 * It is still declined, because `base-uri` below buys back the one thing those shims exist to fix,
 * and spending the strongest guarantee in the design on a nicety it no longer has to buy is a bad
 * trade to make once and an impossible one to unmake later.
 *
 * `base-uri 'none'` IS THAT BUY-BACK, and it is the least obvious line here. 34 of the 52 documents
 * carry a literal `<base href="about:srcdoc">`, put there because kb's viewer injects them through
 * `srcdoc`, where the base would otherwise be the parent page. Collie loads the document BY URL, so
 * that tag is actively wrong here: every `href="#section"` would resolve to `about:srcdoc#section`
 * and a tapped table-of-contents entry would attempt a navigation instead of a scroll — broken
 * in-page navigation in 28 documents, over half the corpus, and exactly the ones long enough to
 * have a contents list. `base-uri 'none'` makes the browser IGNORE the element, so relative and
 * fragment URLs resolve against `/d/<slug>` and anchors simply work, with no script and without
 * rewriting a byte of what kb holds (which would also cost the sha check below its meaning).
 *
 * `frame-ancestors 'self'` is not redundant with the app's global CSP and is not inherited from it.
 * Reusing that constant would be the instinct and it is the trap: it ends in `frame-ancestors
 * 'none'`, which blocks COLLIE'S OWN panel, and the failure is a blank frame with nothing in the
 * bridge's log. Setting `sandbox` alone is the opposite trap: absent `frame-ancestors` means
 * unrestricted, so the sandboxed document would be framable from any origin on the internet.
 *
 * The fetch directives are `'none'` plus exactly what these documents are made of: base64 `data:`
 * images (the bulk of a median 861 KiB document is inlined WebP) and inline `<style>` blocks.
 * `style-src 'unsafe-inline'` cannot execute code, and it is required — with `default-src 'none'` a
 * document's own `<style>` would be dropped and the page would render as unstyled text. Everything
 * else — an external stylesheet, a tracking pixel, a nested frame — is refused, which matters
 * because the CONTENT of these documents is derived from pages on the open web: 0 of 52 load an
 * external subresource today, and this is what keeps that true tomorrow without anyone re-auditing.
 * A document that inlines a `<video>` will not play it; that is a missing video, not a hole.
 */
export const DOCUMENT_CSP =
  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
  "base-uri 'none'; frame-ancestors 'self'";

/** The headers a served document carries beyond `secure()`'s. Named so the four are visible here. */
export type DocumentHeaders = {
  "content-type": string;
  "cache-control": string;
  "content-security-policy": string;
  etag: string;
  // Intersected with an index signature for the same reason `StaticHeaders` in server.ts is: an
  // INTERFACE has no implicit one, so `new Response(body, { headers })` refuses it as a `HeadersInit`
  // — a named shape and a plain object literal are not the same thing to this check.
} & Record<string, string>;

/**
 * The headers for one served document.
 *
 * `content-type` is the literal, never derived from anything the store said: these bytes are going into a
 * frame as HTML and a sniffed or echoed type could only ever be a way to be wrong. `nosniff` is
 * already on every response (`SECURITY_HEADERS`) and stops a browser re-deciding.
 *
 * Caching follows the house rule for bytes that are not content-addressed (`cacheControlFor`):
 * `no-cache` plus a strong ETag, so a warm client spends a 304 and no body while an edited document
 * is picked up on the next open rather than at the end of some max-age a phone cannot clear.
 * `no-store` was the alternative — these bytes did come from another service — and it is the wrong
 * one here: it is the operator's own knowledge base on the operator's own phone, and it would mean
 * re-downloading a 2 MB document over a mobile link every single time the panel opens.
 */
export function documentResponseHeaders(etag: string): DocumentHeaders {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "content-security-policy": DOCUMENT_CSP,
    etag,
  };
}


/**
 * The largest document this bridge will serve.
 *
 * kb enforced exactly this at push time (`maxHTMLBytes`), and every document agentry holds came
 * through that door or is smaller; restated on the reading side so a store that ever stops
 * enforcing it cannot hand the phone something unbounded. The live corpus runs to 2.2 MiB.
 */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** The most `agentry query` may print before the run is killed: a hundred rows with summaries. */
export const MAX_QUERY_BYTES = 1024 * 1024;

/**
 * How long `agentry query` may take.
 *
 * It answers in ~75 ms (a DuckDB open over parquet). The interesting failure is the SLOW one — a
 * store held by a long compaction — and five seconds is still short enough that the operator gets
 * an answer instead of a spinner.
 */
export const AGENTRY_TIMEOUT_MS = 5_000;

/** Where agentry is, as config states it. Neither value is read here from the environment. */
export interface AgentrySettings {
  /** `$AGENTRY_HOME` — the data directory holding `documents/`. Empty = feature off. */
  home: string;
  /** The `agentry` binary, absolute. Empty = feature off. */
  cli: string;
}

/**
 * The two things this module does to the outside world, injectable so the tests never spawn a
 * process. `run` is the quota command's runner (argv, deadline, cap); `read` reads a file already
 * proved to be inside the documents directory.
 */
export interface AgentryIo {
  run: (argv: readonly string[], deadlineMs: number) => Promise<QuotaRun>;
  read: (path: string) => Promise<Buffer>;
}

export const agentryIo: AgentryIo = {
  run: (argv, deadlineMs) => runQuotaCommand(argv, deadlineMs, MAX_QUERY_BYTES),
  read: (path) => readFile(path),
};

/**
 * The configured home and binary, proved absolute — or null, which means the caller must not run
 * anything. A relative home would resolve against the bridge's cwd, which is nobody's archive.
 */
export function normaliseAgentry(settings: AgentrySettings): { home: string; cli: string } | null {
  const home = settings.home.trim().replace(/\/+$/u, "");
  const cli = settings.cli.trim();
  if (home === "" || cli === "") return null;
  if (!isAbsolute(home) || !isAbsolute(cli)) return null;
  return { home, cli };
}

/** The directory `html_path` is relative to, and the containment root for every read. */
export function documentsDir(home: string): string {
  return join(home, "documents");
}

/**
 * A DuckDB string literal for `value`: single-quoted, with each `'` doubled. DuckDB's standard
 * strings give a backslash no meaning, so the quote is the only character that can end the literal.
 *
 * `agentry query`'s `--param` is a textual `{key}` substitution, not a bound parameter, so it would
 * buy nothing over this — and this is the one function a test can pin.
 */
export function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The argv for one query. No shell; the SQL is one argument. */
export function agentryQueryArgv(conf: { home: string; cli: string }, sql: string): string[] {
  return [conf.cli, "query", "--home", conf.home, "--format", "json", "--no-limit", sql];
}

/**
 * Why a document could not be served. The route turns these into statuses; nothing else reads them.
 *
 * HOUSE POLICY IS ONE ANSWER FOR EVERY REFUSAL (`/api/fonts` gives every failure the same 404 so a
 * client cannot tell "undeclared" from "missing" from "escaped its directory"), and this list is a
 * deliberate, argued departure from it: `bad_slug`, `not_found` and `not_configured` collapse into
 * the same answer at the route, so nothing about which slugs exist is observable beyond "this one
 * opens". What the rest distinguish is "which part of this machine is broken", and a phone that says
 * "not found" when the real answer is "agentry will not start" costs a debugging session every time.
 *
 *  - `bad_slug`       — the path did not carry a slug. Answer it exactly as `not_found` is answered.
 *  - `not_found`      — agentry answered and has no such document.
 *  - `not_configured` — no home/binary, or one this bridge refuses (not absolute). Nothing was run.
 *  - `unreachable`    — `agentry query` could not be run, or did not answer before the deadline.
 *  - `unusable`       — agentry answered, and the answer is not one this module can serve: a failed
 *                       query, output that is not its JSON envelope, a row that is not the document
 *                       contract, a file that is missing or outside the documents directory, a
 *                       document over the ceiling, or bytes that do not hash to what the row says.
 */
export type DocumentFailure = "bad_slug" | "not_found" | "not_configured" | "unreachable" | "unusable";

/** kb's `content_sha256`, now agentry's `html_sha256`: lowercase hex of exactly 32 bytes. */
const CONTENT_SHA256 = /^[0-9a-f]{64}$/u;

/**
 * The ETag for a document whose content hashes to `contentSha256`.
 *
 * agentry records the hash of the exact bytes it wrote to `documents/` (`agentry doc push`), so the
 * row alone is enough to answer a conditional request — a warm phone re-opening a 2 MB document
 * spends one query and a 304.
 *
 * The `d1:` prefix names COLLIE'S representation, not the store's content. Nothing transforms these
 * bytes today, but if this route ever does, bumping the prefix invalidates every cached copy at
 * once. It did not move with the kb → agentry switch on purpose: the bytes are the same bytes (the
 * import copied them one for one), so a phone that cached a document from kb keeps a valid copy.
 *
 * The hex is re-checked before it is returned because an ETag is a HEADER VALUE: a newline in it is
 * response-header injection. Returns null when the field cannot be believed.
 */
export function documentEtag(contentSha256: string): string | null {
  if (!CONTENT_SHA256.test(contentSha256)) return null;
  return `"d1:${contentSha256}"`;
}

/** What the route needs to know about a document besides its bytes. */
export interface DocumentMetadata {
  slug: string;
  /**
   * The document's title, as free text.
   *
   * Here because the panel cannot get it any other way: the frame is an opaque origin by
   * construction, so the parent document cannot read its `document.title`. It is a title an agent
   * wrote, in any language, with any punctuation — it must be rendered as TEXT and must never be
   * put in a response header, where a newline in it would be header injection.
   */
  title: string;
  /** The strong ETag for these bytes, from {@link documentEtag}. */
  etag: string;
  /** agentry's own byte count, checked against the ceiling BEFORE the file is read. */
  sizeBytes: number;
}

/**
 * Total: every failure is a `reason`, never a throw, because the caller is an HTTP handler and a
 * stale link is an ordinary answer rather than an exception.
 *
 * `unchanged` is the conditional-request answer, and it is a first-class outcome rather than an
 * absent `html`, so a caller cannot forget which one it is holding.
 */
export type DocumentResult =
  | { ok: true; unchanged: true; metadata: DocumentMetadata }
  | { ok: true; unchanged: false; metadata: DocumentMetadata; html: string }
  | { ok: false; reason: DocumentFailure };

/** One query's outcome: its rows, or the failure the caller should return unchanged. */
export type QueryResult = { ok: true; rows: JsonObject[] } | { ok: false; reason: DocumentFailure };

/**
 * Run one read against agentry and return its rows.
 *
 * agentry prints `{"ok": true, "data": [...]}` on success and `{"ok": false, "error": {...}}` on a
 * failure (exit 2). Neither the SQL nor agentry's error message reaches `warn`: the code is worth
 * a local line, the message can quote the query, which carries what the operator typed.
 */
export async function agentryQuery(
  sql: string,
  settings: AgentrySettings,
  io: AgentryIo,
  warn: (message: string) => void,
): Promise<QueryResult> {
  const conf = configured(settings, warn);
  if (conf === null) return { ok: false, reason: "not_configured" };
  const run = await io.run(agentryQueryArgv(conf, sql), AGENTRY_TIMEOUT_MS);
  if (run.timedOut) {
    warn(`agentry query did not answer within ${AGENTRY_TIMEOUT_MS}ms`);
    return { ok: false, reason: "unreachable" };
  }
  if (run.code === 127) {
    warn("agentry could not be run — check the configured agentry binary");
    return { ok: false, reason: "unreachable" };
  }
  const envelope = parseRecord(run.stdout);
  if (envelope === null) {
    warn(`agentry query exited ${String(run.code)} without its JSON envelope`);
    return { ok: false, reason: "unusable" };
  }
  if (envelope.ok !== true || !Array.isArray(envelope.data)) {
    const code = jsonStringField(jsonRecord(envelope.error)?.code) ?? "unknown";
    warn(`agentry query failed (${code})`);
    return { ok: false, reason: "unusable" };
  }
  const rows: JsonObject[] = [];
  for (const item of envelope.data) {
    const row = jsonRecord(item);
    if (row !== null) rows.push(row);
  }
  return { ok: true, rows };
}

/** The settings, believed, with the one line an operator who MEANT to switch this on needs. */
function configured(settings: AgentrySettings, warn: (message: string) => void): { home: string; cli: string } | null {
  const conf = normaliseAgentry(settings);
  // Silence when NOTHING is configured — an operator who never wanted this feature must not pay a
  // log line per request for it. A configured-but-refused value is the opposite case.
  if (conf === null && settings.home.trim() !== "") {
    warn("ignoring the configured agentry home — it and the agentry binary must be absolute paths");
  }
  return conf;
}

/** The query for one document's row. `slug` must already have passed {@link isDocumentSlug}. */
export function documentRowSql(slug: string): string {
  return (
    "SELECT slug, title, html_path, html_sha256, html_bytes FROM documents_latest " +
    `WHERE slug = ${sqlText(slug)} LIMIT 1`
  );
}

/** A row, once it has been believed: the parts the route needs plus the parts it checks. */
interface ParsedRow {
  htmlPath: string;
  contentSha256: string;
  document: DocumentMetadata;
}

/**
 * Read one `documents_latest` row, or null when it is not one. Every field is checked before it is
 * used, and two because of where they are ABOUT to go: `html_path` becomes a file read, and the
 * digest becomes a response header value.
 */
function readRow(row: JsonObject): ParsedRow | null {
  const slug = jsonStringField(row.slug);
  const htmlPath = jsonStringField(row.html_path);
  const contentSha256 = jsonStringField(row.html_sha256);
  const sizeBytes = jsonNumberField(row.html_bytes);
  if (slug === null || htmlPath === null || contentSha256 === null || sizeBytes === null) return null;
  if (!isDocumentSlug(slug) || htmlPath === "") return null;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;
  const etag = documentEtag(contentSha256);
  if (etag === null) return null;
  // A document with no title is a cosmetic problem and not a reason to refuse to show it.
  const title = jsonStringField(row.title) ?? "";
  return { htmlPath, contentSha256, document: { slug, title, etag, sizeBytes } };
}

/**
 * One document from agentry, for `GET /api/doc/<slug>`.
 *
 * `ifNoneMatch` is the request's own header: when it matches, this returns after the query and the
 * file is never read, which on a 2 MB document is the difference between a 304 and a re-download
 * over a mobile link.
 */
export async function fetchDocument(
  slug: string,
  settings: AgentrySettings,
  ifNoneMatch: string | null = null,
  io: AgentryIo = agentryIo,
  warn: (message: string) => void = defaultWarn,
): Promise<DocumentResult> {
  // THE GRAMMAR IS FIRST, before the configuration check and before any string is built, so that
  // the rule which must never be skipped is also the one with nothing ahead of it to skip it.
  if (!isDocumentSlug(slug)) return { ok: false, reason: "bad_slug" };
  const conf = configured(settings, warn);
  if (conf === null) return { ok: false, reason: "not_configured" };

  const answer = await agentryQuery(documentRowSql(slug), settings, io, warn);
  if (!answer.ok) return answer;
  const first = answer.rows[0];
  if (first === undefined) return { ok: false, reason: "not_found" };
  const row = readRow(first);
  if (row === null) {
    warn(`agentry's row for ${slug} is not the document contract`);
    return { ok: false, reason: "unusable" };
  }

  // The ceiling is checked against agentry's own byte count BEFORE the file is read.
  if (row.document.sizeBytes > MAX_DOCUMENT_BYTES) {
    warn(`${slug} is ${row.document.sizeBytes} bytes, over the ${MAX_DOCUMENT_BYTES} ceiling — not serving it`);
    return { ok: false, reason: "unusable" };
  }

  if (ifNoneMatch !== null && ifNoneMatch === row.document.etag) {
    return { ok: true, unchanged: true, metadata: row.document };
  }

  // The ROW's path, joined under the documents directory and then proved to still be inside it
  // after every symlink is resolved. A missing file is agentry's index being ahead of its disk —
  // corruption the operator can act on, reported as such rather than flattened into "not found".
  const root = documentsDir(conf.home);
  const real = await containedRealpath(join(root, row.htmlPath), root);
  if (real === null) {
    warn(`${slug}'s html_path is missing or outside the documents directory — not serving it`);
    return { ok: false, reason: "unusable" };
  }
  let bytes: Buffer;
  try {
    bytes = await io.read(real);
  } catch {
    warn(`${slug}'s file could not be read`);
    return { ok: false, reason: "unusable" };
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    warn(`${slug}'s file is over the ${MAX_DOCUMENT_BYTES} ceiling — not serving it`);
    return { ok: false, reason: "unusable" };
  }

  // The hash the row advertised, checked against the bytes actually read. The ETag this bridge
  // publishes is then a fact about the bytes rather than a promise relayed from another process,
  // and a file rewritten behind agentry's back is caught instead of served under a stale tag.
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== row.contentSha256) {
    warn(`${slug} does not hash to the digest agentry recorded — not serving it`);
    return { ok: false, reason: "unusable" };
  }
  // Decoded only after the hash matched, and strictly: a document that is not valid UTF-8 would
  // otherwise be served with replacement characters, as something other than what the store holds.
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    warn(`${slug} is not valid UTF-8 — not serving it`);
    return { ok: false, reason: "unusable" };
  }
  return { ok: true, unchanged: false, metadata: row.document, html };
}

// ── READING agentry's JSON ───────────────────────────────────────────────────────────────────────
// The field readers are IMPORTED from `bridge/stt/` rather than written again here: they are
// feature-agnostic, and `.oxlintrc.json`'s `no-runtime-typeof` override deliberately names the
// readers rather than the feature modules that use them.

/** The JSON object inside `text`, or null when it is not parseable or is not an object. */
export function parseRecord(text: string): JsonObject | null {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` returns a JsonValue by construction, and every field below is read
    // through a narrowing reader before it is believed — this assertion names the type it produces,
    // it does not vouch for anything inside it.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  return jsonRecord(parsed);
}

export function defaultWarn(message: string): void {
  console.warn(`[docs] ${message}`);
}
