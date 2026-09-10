import type { JsonObject, JsonValue } from "./json.ts";
// Three generic readers for a field of an untrusted JSON object. They live under `stt/` because
// speech-to-text was their first caller, not because they know anything about it — and they are the
// readers named in .oxlintrc.json's `no-runtime-typeof` boundary override, so reusing them is also
// what keeps this file's parse of kb's JSON lint-clean without widening that list.
import { jsonNumberField, jsonRecord, jsonStringField } from "./stt/json.ts";

// Serving ONE of the operator's knowledge-base documents from Collie's own origin, so a link an
// agent printed in the mirror can open in a panel beside the terminal instead of throwing the
// operator out of the PWA.
//
// ── WHY THIS IS A PROXY AND NOT AN IFRAME OF THE REAL SITE ───────────────────────────────────────
// The obvious build is `<iframe src="https://knowledge.agnex.dev/d/…">` and it cannot work. Six
// representative targets were MEASURED and all six refuse framing outright (github.com,
// developer.mozilla.org, docs.anthropic.com, news.ycombinator.com, stackoverflow.com, and the
// operator's own knowledge.agnex.dev). The operator's own services are worse than the strangers':
// they sit behind Cloudflare Access, Safari blocks third-party cookies, so a cross-origin frame
// would be handed the Access LOGIN page — which itself refuses framing. There is no header this
// repo can set that fixes somebody else's `X-Frame-Options`.
//
// Same-origin is what buys the four things the feature needs: Collie controls the framing headers,
// the Access cookie is first-party so the existing device auth is unchanged, the app's own
// `default-src 'self'` already permits a same-origin frame with no policy weakened, and loopback
// bypasses Cloudflare entirely so no service token exists to leak.
//
// ── THE OUTBOUND CALL, WHICH CLAUDE.md OTHERWISE FORBIDS ─────────────────────────────────────────
// "The bridge makes no outbound call … unless the operator ran `collie stt setup`" — this is the
// second seam of that shape, and it is granted the same three defences rather than an exemption:
// the call is DECLINED BY DOING NOTHING (no origin configured, no route), it opens no egress
// (`normaliseKbOrigin` refuses anything but a loopback host, so a mistyped `COLLIE_KB_ORIGIN`
// cannot turn the bridge into an open proxy for the wider internet), and the credential it carries
// never leaves the machine. Every failure below is careful never to put that credential in a body
// or a log line.
//
// ── WHAT ARRIVES IS A PROGRAM, NOT A PAGE ───────────────────────────────────────────────────────
// A kb document is HTML an AGENT wrote, often out of pages it read on the open web. Served
// same-origin with no policy it could run script in Collie's origin, read `localStorage`, and call
// `/api/*` with the Access header attached by the browser. So the response is dropped into an
// opaque origin — see {@link DOCUMENT_CSP}, which is the containment and is commented as such.
//
// ── TWO HOPS, BECAUSE kb's HTML ROUTE REFUSES A SLUG ─────────────────────────────────────────────
// `GET /api/documents/{id_or_slug}` accepts either; `GET /api/documents/{id}/html` is strictly a
// UUID and answers 400 to a slug (measured). So a slug costs a metadata call first. That turns out
// to pay for itself twice: the metadata carries `content_sha256`, which IS the ETag (below), so a
// warm phone re-opening a 2 MB document spends one ~1 KB JSON call and a 304; and the alias case —
// a renamed slug, answered with a 308 — is absorbed on a hop this module was making anyway.
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
 * rule at once. kb's own canonical slugs are `^[a-z0-9][a-z0-9-]*$`; this adds only a ceiling.
 *
 * It is an ALLOWLIST checked before anything is built, not a sanitiser run after. What an
 * unvalidated slug would buy, concretely: this string is interpolated into the path of a loopback
 * request that carries the bridge's kb credential, so `../../healthz`, `%2e%2e%2f`, a `?` or a `#`
 * would each aim that credentialled request at a different kb endpoint than the one this module
 * means to call, and a `\r\n` would aim it at a different request entirely. None of those can be
 * spelled in `[a-z0-9-]`, which is why the answer is a closed charset and not an escaper: an
 * escaper is a thing that can have a bug.
 *
 * NOTHING IS EVER PERCENT-DECODED on the way here. `URL.pathname` preserves the escapes, `%` is not
 * in the charset, so an encoded separator is refused as the literal characters it arrives as —
 * decoding first is precisely the step that turns `%2f` into a separator, and it never happens.
 */
export const DOCUMENT_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,127}$";

/**
 * True when `value` is a slug this bridge will ask kb about.
 *
 * The ceiling is 128 characters. kb's longest live slug is a third of that, and the number exists
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
 * `content-type` is the literal, never derived from anything kb said: these bytes are going into a
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
 * kb enforces exactly this at push time (`maxHTMLBytes`, mirroring a DB CHECK), so this is not a
 * policy Collie invents — it is the same ceiling, restated on the reading side so a kb that ever
 * stops enforcing it cannot hand the phone something unbounded. The live corpus runs to 2.2 MiB.
 */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** The largest metadata answer worth reading. kb's is ~1 KB; this is room for a hundred of them. */
export const MAX_METADATA_BYTES = 64 * 1024;

/**
 * How long either hop may take.
 *
 * Loopback makes the interesting failure the SLOW one, not the absent one: nothing listening on
 * 127.0.0.1 is refused in under a millisecond and arrives here as a throw, while an API container
 * that is alive but wedged (exhausted DB pool, lagging healthcheck) would otherwise hang until
 * Bun's own idle timeout closed the phone's connection with nothing said. Five seconds is roughly
 * 250× the measured cost of the largest document in the corpus (2.3 MB in 18 ms) and still short
 * enough that the operator gets an answer instead of a spinner.
 */
export const KB_TIMEOUT_MS = 5_000;

/** Where kb is, and what proves the bridge may ask it. Both come from config; neither is read here. */
export interface KbSettings {
  /** The loopback base URL of kb's API host, e.g. `http://127.0.0.1:8082`. Empty = feature off. */
  origin: string;
  /** kb's internal token, sent as `x-internal-token`. Empty = feature off. */
  token: string;
}

/**
 * The hostnames this module will dial. A twin of server.ts's `LOOPBACK_HOST`, which is private to
 * that module and asks a different question anyway (that one reads a `Host` HEADER, this one reads
 * a configured URL's hostname). Exact forms only: the point is not to enumerate 127.0.0.0/8, it is
 * that anything the operator did not obviously mean is refused. The IPv6 form carries its brackets
 * because that is what `URL.hostname` hands back for `http://[::1]:8082`.
 */
const KB_LOOPBACK_HOSTNAME = /^(localhost|127\.0\.0\.1|\[::1\])$/u;

/**
 * The configured origin, trimmed of a trailing slash and proved to be loopback — or null, which
 * means the caller must not dial anything.
 *
 * THIS IS THE EGRESS BOUNDARY, and it is a validation rather than a doc note because the difference
 * between "the bridge reads a container on this machine" and "the bridge is an open proxy that
 * fetches arbitrary internet content into its own origin, with a sandbox as the only thing standing
 * between that content and the operator" is one typo in an env var. A path is refused for a duller
 * reason: `http://127.0.0.1:8082/api` would build `…/api/api/documents/x`, and a 404 from a doubled
 * prefix is a bad way to learn about a config mistake.
 */
export function normaliseKbOrigin(origin: string): string | null {
  const trimmed = origin.trim().replace(/\/+$/u, "");
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!KB_LOOPBACK_HOSTNAME.test(parsed.hostname)) return null;
  // `new URL("http://h:1").pathname` is "/", so "no path" is the only thing that passes, and the
  // credential-bearing request below is built from a base nobody has added a segment to.
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  return trimmed;
}

/**
 * The metadata hop's URL. `origin` must be through {@link normaliseKbOrigin} and `slug` through
 * {@link isDocumentSlug} — this function checks neither, which is why it is three lines and why
 * both callers are in this file.
 */
export function kbMetadataUrl(origin: string, slug: string): string {
  return `${origin}/api/documents/${slug}`;
}

/** The HTML hop's URL. `id` must be through {@link isKbDocumentId}, for the same reason. */
export function kbDocumentHtmlUrl(origin: string, id: string): string {
  return `${origin}/api/documents/${id}/html`;
}

/**
 * The headers the bridge presents to kb.
 *
 * The name is `x-internal-token` exactly — kb's middleware matches that header and nothing else,
 * and it runs BEFORE routing, which is the property the failure classification below leans on.
 * `accept` is passed per hop rather than assumed: the two endpoints answer different media, and
 * saying which one is expected is what makes a wrong answer detectable instead of merely odd.
 */
export function kbHeaders(token: string, accept: string) {
  // `satisfies`, not an annotation: the two keys stay visible in the type (a caller reading this
  // sees which headers exist), while the check still says they are all plain string values.
  return { "x-internal-token": token, accept } satisfies Record<string, string>;
}

/** kb ids are UUIDs, and the id is interpolated into a path exactly as the slug was. */
const KB_DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * True when `value` is a document id this module will put in a URL.
 *
 * Applied to a string kb itself just sent, deliberately. That it came from kb rather than from the
 * phone is not a reason to skip the grammar: the whole rule the slug check exists to state is that
 * no string from outside this process is built into a request path unvalidated, and a rule with an
 * exception for "a trusted source" is a rule that stops being checkable the day the source changes.
 */
export function isKbDocumentId(value: string): boolean {
  return KB_DOCUMENT_ID.test(value);
}

/** kb's `content_sha256` is lowercase hex of exactly 32 bytes. Anything else is not that field. */
const CONTENT_SHA256 = /^[0-9a-f]{64}$/u;

/**
 * The ETag for a document whose content hashes to `contentSha256`.
 *
 * kb computes that hash over THE EXACT BYTES its `/html` route returns — verified: the served body
 * hashes to the advertised value and `Content-Length` equals `html_size_bytes`. So the metadata hop
 * alone is enough to answer a conditional request, which is the whole reason a two-hop design is
 * cheap rather than expensive.
 *
 * The `d1:` prefix names COLLIE'S representation, not kb's content. Nothing transforms these bytes
 * today, but if this route ever does, bumping the prefix invalidates every cached copy at once —
 * without it, a phone would hold the old representation under an ETag that still matched.
 *
 * The hex is re-checked before it is returned because an ETag is a HEADER VALUE: a newline in it is
 * response-header injection, and "kb only ever sends hex" is a fact about today's kb, not a
 * property of this function. Returns null when the field cannot be believed.
 */
export function documentEtag(contentSha256: string): string | null {
  if (!CONTENT_SHA256.test(contentSha256)) return null;
  return `"d1:${contentSha256}"`;
}

/** The little of an HTTP answer this module reads. */
export interface KbAnswer {
  readonly status: number;
  readonly headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}

/** The init this module sends. `redirect` is pinned to the only value it may ever have — see below. */
export interface KbRequestInit {
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
}

/**
 * The one call this module makes, injectable so the tests never open a socket.
 *
 * Declared as the CALL this module makes rather than as `typeof fetch`, for the reason `DirsIo` in
 * bridge/dirs.ts gives: naming the global drags its whole overload set in, and the only way to
 * write a fake against that is a cast, which throws the type evidence away. Bun's `fetch` satisfies
 * this narrower signature, so the production value below is checked, not asserted.
 */
export interface KbIo {
  fetch: (url: string, init: KbRequestInit) => Promise<KbAnswer>;
}

export const networkIo: KbIo = { fetch: (url, init) => fetch(url, init) };

/**
 * Why a document could not be served. The route turns these into statuses; nothing else reads them.
 *
 * HOUSE POLICY IS ONE ANSWER FOR EVERY REFUSAL (`/api/fonts` gives every failure the same 404 so a
 * client cannot tell "undeclared" from "missing" from "escaped its directory"), and this list is a
 * deliberate, argued departure from it. There, the distinctions were all answers about the
 * operator's DISK, addressable by a path the client supplies — telling them apart hands out an
 * oracle. Here there is no path space to probe: `bad_slug` and `not_found` collapse into the same
 * answer precisely so that nothing about which slugs are syntactically special is observable. What
 * the rest distinguish is not "which document" but "which machine is broken", and those are the two
 * different things the operator would have to do next — restart the containers, or fix a token, or
 * accept that the link in months-old scrollback is dead. A phone that says "not found" when the
 * real answer is "the kb container is down" costs a debugging session every time.
 *
 *  - `bad_slug`      — the path did not carry a slug. Answer it exactly as `not_found` is answered.
 *  - `not_found`     — kb ACCEPTED the credential and says there is no such live document (or it is
 *                      soft-deleted). Never confusable with the auth failure: kb's 401 comes from
 *                      middleware that runs before routing, so a bad token against a non-existent
 *                      slug answers 401, not 404 — verified against the running binary.
 *  - `not_configured`— no origin/token, or an origin this bridge refuses to dial. The feature is
 *                      off, or it is misconfigured; either way nothing was asked of kb.
 *  - `unauthorised`  — kb rejected the bridge's credential. ALWAYS a misconfiguration on this side
 *                      (or a kb that lost its own secret), NEVER a missing document, and never to
 *                      be reported to the phone as one.
 *  - `unreachable`   — the call threw: containers down (connect refused, sub-millisecond) or wedged
 *                      past the deadline. A throw and a resolved 404 are categorically different
 *                      events, which is what makes this distinction free rather than a guess.
 *  - `unusable`      — kb answered, and the answer is not one this module can serve: a status it
 *                      does not know, a body that is not the document contract, a document larger
 *                      than the ceiling, or bytes that do not hash to what the metadata promised.
 */
export type DocumentFailure =
  | "bad_slug"
  | "not_found"
  | "not_configured"
  | "unauthorised"
  | "unreachable"
  | "unusable";

/** What the route needs to know about a document besides its bytes. */
export interface DocumentMetadata {
  /** kb's canonical slug, which is NOT always the one that was asked for — see the 308 case. */
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
  /** kb's own byte count, checked against the ceiling BEFORE the body is asked for. */
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

/**
 * Fetch one document from kb, over loopback, for `GET /d/<slug>`.
 *
 * `ifNoneMatch` is the request's own header: when it matches, this returns after ONE hop and the
 * body is never asked for, which on a 2 MB document is the difference between a 304 and a
 * re-download over a mobile link.
 */
export async function fetchDocument(
  slug: string,
  kb: KbSettings,
  ifNoneMatch: string | null = null,
  io: KbIo = networkIo,
  warn: (message: string) => void = defaultWarn,
): Promise<DocumentResult> {
  // THE GRAMMAR IS FIRST, before the configuration check and before any string is concatenated, so
  // that the rule which must never be skipped is also the one with nothing ahead of it to skip it.
  if (!isDocumentSlug(slug)) return { ok: false, reason: "bad_slug" };

  const origin = normaliseKbOrigin(kb.origin);
  const token = kb.token.trim();
  if (origin === null || token === "") {
    // Silence when NOTHING is configured — an operator who never wanted this feature must not pay a
    // log line per request for it. A configured-but-refused origin is the opposite case: they meant
    // to switch it on and it is off for a reason only this line will tell them.
    if (kb.origin.trim() !== "" && origin === null) {
      warn("ignoring the configured document origin — it must be a loopback base URL with no path");
    }
    return { ok: false, reason: "not_configured" };
  }

  const first = await ask(kbMetadataUrl(origin, slug), token, "application/json", io, warn);
  if (!first.ok) return first;

  // ── THE RENAMED-SLUG CASE ──────────────────────────────────────────────────────────────────────
  // kb answers a stale slug with 308 and a body of exactly `{"canonical_slug":"…"}` — no id, so
  // there is no shortcut to the HTML hop from here. Bun's `fetch` would follow this on its own and
  // it is asked NOT to, because a redirect-follower re-sends every header it was given: the fetch
  // spec strips `Authorization`, `Cookie` and `Proxy-Authorization` across origins and says nothing
  // about a CUSTOM header, so `x-internal-token` would travel to whatever host a `Location` named.
  // Loopback kb only ever emits a relative same-origin one today; the whole safety story of this
  // module is that the credential never leaves the machine, and "today's kb behaves" is not that
  // story. One hop, re-validated through the same grammar, and never a second.
  let answer = first.answer;
  if (answer.status === 308) {
    const redirect = await body(answer, MAX_METADATA_BYTES);
    const record = redirect === null ? null : parseRecord(redirect);
    const canonical = record === null ? null : jsonStringField(record.canonical_slug);
    if (canonical === null || !isDocumentSlug(canonical)) return { ok: false, reason: "unusable" };
    const second = await ask(kbMetadataUrl(origin, canonical), token, "application/json", io, warn);
    if (!second.ok) return second;
    // A 308 to a 308 is not an alias chain kb creates; it is kb behaving in a way this module has
    // no model of, and following it forever is the one outcome that must not be possible.
    if (second.answer.status === 308) return { ok: false, reason: "unusable" };
    answer = second.answer;
  }

  const classified = classify(answer.status);
  if (classified !== null) return { ok: false, reason: classified };

  const metadata = await readMetadata(answer, warn);
  if (metadata === null) return { ok: false, reason: "unusable" };

  // The ceiling is checked against kb's own byte count BEFORE the body is requested, so an
  // oversized document costs a 1 KB JSON answer rather than a download that is then thrown away.
  if (metadata.document.sizeBytes > MAX_DOCUMENT_BYTES) {
    const { slug: over, sizeBytes } = metadata.document;
    warn(`${over} is ${sizeBytes} bytes, over the ${MAX_DOCUMENT_BYTES} ceiling — not serving it`);
    return { ok: false, reason: "unusable" };
  }

  if (ifNoneMatch !== null && ifNoneMatch === metadata.document.etag) {
    return { ok: true, unchanged: true, metadata: metadata.document };
  }

  const htmlAnswer = await ask(kbDocumentHtmlUrl(origin, metadata.id), token, "text/html", io, warn);
  if (!htmlAnswer.ok) return htmlAnswer;
  const htmlStatus = htmlAnswer.answer.status;
  if (htmlStatus === 401) return { ok: false, reason: "unauthorised" };
  if (htmlStatus !== 200) {
    // A 404 HERE is not the 404 the first hop means. The metadata resolved a millisecond ago, so
    // this is kb's DB being ahead of its filesystem (its own handler names the case: a row whose
    // file went missing after a failed rename) — a corruption the operator can act on, reported as
    // such rather than flattened into "no such document". The cost is that a document genuinely
    // deleted BETWEEN the two hops is reported as broken kb instead of a stale link; that race
    // resolves itself on the retry, and quietly mislabelling real corruption would not.
    warn(`kb answered ${htmlStatus} for ${metadata.document.slug}'s HTML after resolving its metadata`);
    return { ok: false, reason: "unusable" };
  }

  const contentType = htmlAnswer.answer.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("text/html")) {
    // These bytes are about to be labelled `text/html` by this bridge on its own origin. If kb sent
    // something else, the honest move is to refuse rather than to relabel it and find out later.
    warn(`kb answered ${metadata.document.slug} as ${contentType || "an unnamed type"}, not HTML`);
    return { ok: false, reason: "unusable" };
  }

  const html = await body(htmlAnswer.answer, MAX_DOCUMENT_BYTES);
  if (html === null) return { ok: false, reason: "unusable" };

  // The hash kb advertised, checked against the bytes it actually sent. Two things fall out of it:
  // the ETag this bridge publishes is then a fact about the bytes rather than a promise relayed
  // from another process (a client cached against a wrong ETag stays wrong until it clears its own
  // storage, which a phone does not do on request), and a document that is not valid UTF-8 is
  // caught here — decoding it replaced bytes, so what would be served is not what kb holds.
  const digest = new Bun.CryptoHasher("sha256").update(html).digest("hex");
  if (digest !== metadata.contentSha256) {
    warn(`${metadata.document.slug} does not hash to the digest kb advertised — not serving it`);
    return { ok: false, reason: "unusable" };
  }

  return { ok: true, unchanged: false, metadata: metadata.document, html };
}

/** One hop's outcome: the answer, or the failure the caller should return unchanged. */
type Hop = { ok: true; answer: KbAnswer } | { ok: false; reason: DocumentFailure };

/**
 * One request to kb.
 *
 * EVERY THROW IS "UNREACHABLE" AND EVERY RESOLVED RESPONSE IS A REAL ANSWER — the distinction needs
 * no status inspection because nothing is listening means a refused TCP connect, which `fetch`
 * surfaces as a rejection, while a 404 is a perfectly resolved response. The deadline lands in the
 * same bucket by design: an alive-but-wedged container is unreachable in every sense the caller has
 * a move for.
 *
 * Neither the token nor an upstream body ever reaches `warn`. The status is worth a local line; the
 * body is not, and an error body from another service can name a host, an account or a path.
 */
export async function ask(
  url: string,
  token: string,
  accept: string,
  io: KbIo,
  warn: (message: string) => void,
): Promise<Hop> {
  try {
    const answer = await io.fetch(url, {
      headers: kbHeaders(token, accept),
      redirect: "manual",
      signal: AbortSignal.timeout(KB_TIMEOUT_MS),
    });
    if (answer.status === 401) {
      // Loud, because it is silent otherwise and it is always a configuration fault: kb's auth
      // middleware runs before routing, so this can never be a missing document. The token is not
      // named, not fingerprinted and not logged — a length or a prefix in a log file is a head start.
      warn("kb rejected this bridge's credential — check the configured document token");
      return { ok: false, reason: "unauthorised" };
    }
    return { ok: true, answer };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    warn(
      timedOut
        ? `kb did not answer within ${KB_TIMEOUT_MS}ms — the API container may be wedged`
        : "kb could not be reached — its containers may be down",
    );
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * A response body as text, refused when it declares more than `limit` or measures more than it.
 *
 * The DECLARED length is checked first and an ABSENT one is refused rather than read: kb sends a
 * `Content-Length` on every answer (measured, both endpoints), so an answer without one is not the
 * thing this module was pointed at, and refusing costs nothing while buffering an undeclared body
 * costs whatever the peer feels like sending.
 *
 * This is not the streamed cap `bridge/stt/transcript.ts` uses, and the difference is the threat
 * model, not an oversight: that peer is an operator-configured endpoint anywhere on the internet,
 * this one is pinned to loopback by {@link normaliseKbOrigin} and is a container the operator runs.
 * The declared-length refusal is what makes a BROKEN kb cheap. If the loopback restriction is ever
 * relaxed, this must become a streamed read — `readCapped` is the existing example.
 */
export async function body(answer: KbAnswer, limit: number): Promise<string | null> {
  const declared = answer.headers.get("content-length");
  if (declared === null || !/^\d+$/u.test(declared)) return null;
  if (Number(declared) > limit) return null;
  let text: string;
  try {
    text = await answer.text();
  } catch {
    // A body that dies mid-read — the deadline firing, the container going away — is the same
    // "kb did not deliver" the caller already handles, and there is nothing here to say about it.
    return null;
  }
  // The declared length was a claim; this is the measurement. Bytes, not characters: one CJK glyph
  // in a title is three of the bytes the ceiling is written in, and these documents are full of them.
  return Buffer.byteLength(text, "utf8") > limit ? null : text;
}

/** kb's metadata, once it has been believed: the parts the route needs plus the parts it checks. */
interface ParsedMetadata {
  id: string;
  contentSha256: string;
  document: DocumentMetadata;
}

/**
 * Read the metadata answer, or null when it is not one.
 *
 * Every field is checked before it is used, and two of them are checked because of where they are
 * ABOUT to go rather than because kb is doubted: `id` is interpolated into a URL path, and the
 * digest becomes a response header value. `summary`, `source_session` and the rest are omitted by
 * kb whenever they are empty, which is why nothing here reads a field it does not need.
 */
async function readMetadata(
  answer: KbAnswer,
  warn: (message: string) => void,
): Promise<ParsedMetadata | null> {
  const text = await body(answer, MAX_METADATA_BYTES);
  if (text === null) return null;
  const record = parseRecord(text);
  if (record === null) {
    warn("kb answered the document metadata with something that is not a JSON object");
    return null;
  }
  const id = jsonStringField(record.id);
  const slug = jsonStringField(record.slug);
  const contentSha256 = jsonStringField(record.content_sha256);
  const sizeBytes = jsonNumberField(record.html_size_bytes);
  if (id === null || slug === null || contentSha256 === null || sizeBytes === null) return null;
  if (!isKbDocumentId(id) || !isDocumentSlug(slug)) return null;
  // A byte count that is fractional, negative, or past the safe-integer range is not kb's
  // `html_size_bytes` — and this number decides whether the body is fetched at all.
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;
  const etag = documentEtag(contentSha256);
  if (etag === null) return null;
  // `title` is required by kb's contract, but a document with no title is a cosmetic problem and
  // not a reason to refuse to show it — the empty string is a caption the panel can decide about.
  const title = jsonStringField(record.title) ?? "";
  return { id, contentSha256, document: { slug, title, etag, sizeBytes } };
}

/**
 * Which failure a metadata status is, or null when it is the success this module can continue from.
 *
 * 401 is handled earlier, on every hop, because it is the one answer that means "this bridge is
 * misconfigured" no matter which endpoint produced it.
 */
function classify(status: number): DocumentFailure | null {
  if (status === 200) return null;
  if (status === 404) return "not_found";
  return "unusable";
}

// ── READING kb's JSON ────────────────────────────────────────────────────────────────────────────
// The field readers are IMPORTED rather than written again here, and the import path is the one
// wart in this module: they live under `bridge/stt/` because that is where the repo's second JSON
// boundary happened to be built. They are feature-agnostic — they know no vendor, no URL and no
// credential — and `.oxlintrc.json`'s own note on them says the override deliberately "names the
// readers rather than the two feature modules". So the two alternatives were both worse: a fourth
// hand-written copy of a three-line narrowing is how two parsers end up disagreeing about what a
// string is, and naming `bridge/docs.ts` in the `no-runtime-typeof` override would grow exactly the
// list that note is trying to keep small. Moving that file to a neutral path is a rename this
// module would welcome.

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
