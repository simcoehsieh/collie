
// Pure, injectable HTTP cache helpers: ETag + conditional GET + gzip JSON.
//
// Kept separate from server.ts so they can be exercised under `bun test` without
// needing Bun.serve or the Herdr socket — all functions are synchronous or return
// a plain Response, with no I/O.

import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

// Only compress if serialised body is at least this many bytes; below this the
// deflate overhead and header cost outweigh the savings.
const GZIP_MIN_BYTES = 256;

/**
 * The content-codings this module can produce, in the order they are preferred when a client
 * accepts several. Brotli first: on the leg that matters (a phone on cellular, through a tunnel) a
 * JSON pane body is 15–20 % smaller as `br` than as `gzip` at the same wall-clock cost, and every
 * browser that installs a PWA sends `br` in its Accept-Encoding.
 */
export type Encoding = "br" | "gzip";

/**
 * Brotli quality for an API body. Compressed PER REQUEST, on the hot path, so this is the cheap end
 * of the dial: at 4 the encoder is in the same cost band as gzip's default while still beating it on
 * size. Static assets are compressed once and cached (`compressStatic`) and can afford the top.
 */
const BR_API_QUALITY = 4;
const BR_STATIC_QUALITY = 11;

/**
 * Which coding to answer with for an Accept-Encoding header, or null for identity.
 *
 * Token-parsed, not substring-matched: `identity;q=0, br` and `gzip;q=0` must be read for what they
 * say. A `q=0` refuses the coding; anything else accepts it and the module's own preference
 * (`br` over `gzip`) breaks the tie rather than the client's q-values — the two are close enough in
 * cost that the smaller body is the better answer whenever both are on the table.
 */
export function pickEncoding(acceptEncoding: string | null): Encoding | null {
  if (acceptEncoding === null || acceptEncoding === "") return null;
  const accepted = new Set<string>();
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = (rawName ?? "").trim().toLowerCase();
    if (name === "") continue;
    const q = params
      .map((p) => p.trim())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    if (q !== undefined && Number.parseFloat(q) === 0) continue;
    accepted.add(name);
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip") || accepted.has("*")) return "gzip";
  return null;
}

/** Compress `body` with `encoding`. `quality` is brotli's only; gzip takes its default. */
export function compress(
  body: Uint8Array,
  encoding: Encoding,
  quality = BR_API_QUALITY,
): Uint8Array<ArrayBuffer> {
  const bytes = asOwnBuffer(body);
  if (encoding === "gzip") return asOwnBuffer(Bun.gzipSync(bytes));
  const out = brotliCompressSync(bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  });
  return asOwnBuffer(out);
}

/** The static-asset variant of {@link compress}: slow and small, because it runs once per file. */
export function compressStatic(body: Uint8Array, encoding: Encoding): Uint8Array<ArrayBuffer> {
  return compress(body, encoding, BR_STATIC_QUALITY);
}

/** A view over a plain ArrayBuffer — what `Response` accepts; a zlib Buffer may sit on a pool. */
function asOwnBuffer(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(view.byteLength));
  copy.set(view);
  return copy;
}

/**
 * Compute a strong ETag for the given response body.
 * Uses Bun.hash (Wyhash) — fast and deterministic within a process.
 * Returns a quoted ETag value as required by RFC 7232.
 *
 * Takes BYTES as well as a string because not every body the bridge validates is text: an operator's
 * font file is a woff2, and hashing its content is what makes the tag strong rather than a guess
 * assembled from a size and an mtime.
 */
export function computeEtag(body: string | Uint8Array): string {
  // toString(16) works for both number and bigint, which covers all Bun.hash overloads.
  return `"${Bun.hash(body).toString(16)}"`;
}

/**
 * Return true when the request's If-None-Match header equals the computed ETag,
 * meaning the client already holds the current representation.
 * Returns false for a null header (no previous ETag known to the client).
 */
export function notModified(ifNoneMatch: string | null, etag: string): boolean {
  return ifNoneMatch !== null && ifNoneMatch === etag;
}

/**
 * Build a JSON Response, gzip-compressing the body when the client signals gzip
 * support via Accept-Encoding and the serialised body is large enough to benefit.
 *
 * Behaviour:
 * - Always sets `content-type: application/json` and `cache-control: no-store`.
 * - When compressed: adds `content-encoding: gzip` and `vary: accept-encoding`.
 * - `extraHeaders` are merged in after the standard headers so callers can attach
 *   an ETag or other fields (e.g. `{ etag: '"abc"' }`).
 */
/**
 * The headers this module composes: the two it always sets, the two the gzip branch adds, and
 * whatever the caller attached. Named rather than a bare `Record<string, string>` so the four keys
 * this function owns are visible in the type.
 */
type ResponseHeaders = {
  "content-type": string;
  "cache-control": string;
  "content-encoding"?: string;
  vary?: string;
} & Record<string, string>;

export function gzipJsonResponse<TBody>(
  data: TBody,
  acceptEncoding: string | null,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonBodyResponse(JSON.stringify(data), acceptEncoding, extraHeaders);
}

/**
 * The same as {@link gzipJsonResponse}, for a caller that already holds the serialised body — the
 * pane read and the snapshot both hash the string for an ETag first, and serialising it twice for
 * one response is pure waste on a route polled every second.
 *
 * `br` is answered when the client accepts it, `gzip` otherwise (the name of the function predates
 * brotli and is kept so its callers do not churn).
 */
export function jsonBodyResponse(
  body: string,
  acceptEncoding: string | null,
  extraHeaders: Record<string, string> = {},
): Response {
  const encoding = body.length >= GZIP_MIN_BYTES ? pickEncoding(acceptEncoding) : null;

  const headers: ResponseHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };

  if (encoding !== null) {
    headers["content-encoding"] = encoding;
    headers["vary"] = "accept-encoding";
    return new Response(compress(new TextEncoder().encode(body), encoding), { headers });
  }

  return new Response(body, { headers });
}
