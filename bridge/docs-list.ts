import type { JsonValue } from "./json.ts";
import {
  ask,
  body,
  defaultWarn,
  isDocumentSlug,
  networkIo,
  normaliseKbOrigin,
  parseRecord,
  type DocumentFailure,
  type KbIo,
  type KbSettings,
} from "./docs.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "./stt/json.ts";

// THE BROWSER: a list and a search, through the same door bridge/docs.ts opened.
//
// The document route opens ONE document whose slug an agent happened to print. That leaves every
// document the agent did not print unreachable from the phone, and the operator's knowledge base
// has hundreds. `GET /api/docs` answers "which documents" — kb's recent list, its search, or one
// tag's documents — as slugs and titles the panel can draw and tap; `GET /api/docs/tags` is the
// chip row above it. Same loopback-only origin rule, same credential discipline (the token never
// reaches a body or a log line), same deadline. The only new thing is that a QUERY the phone typed
// is carried to kb, and it is carried as a query PARAMETER built by `URLSearchParams`, never
// spliced into a path — so nothing the operator types can aim the credentialled request anywhere
// but the two endpoints named here.
//
// A separate module rather than more of docs.ts, because docs.ts is the part with the containment
// argument in it and this part has none to make: nothing here is served as HTML, nothing is framed.

/** A document as the browser lists it: enough to draw a row and open it, and nothing else. */
export interface DocumentSummary {
  slug: string;
  title: string;
  /** kb's own summary, cut to {@link SUMMARY_CAP} — a row's second line, not a page. */
  summary?: string;
  /** ISO-8601, from kb's `updated_at`; absent on a search hit (kb's search does not carry it). */
  updatedAt?: string;
}

/** One tag with the number of documents under it (descendants included, kb's `<@`). */
export interface DocumentTag {
  path: string;
  count: number;
}

/** `GET /api/docs` — the list. `nextCursor` is present when kb may have more. */
export interface DocumentListBody {
  ok: true;
  documents: DocumentSummary[];
  nextCursor?: string;
}

/** `GET /api/docs/tags` — every tag kb knows, with counts. */
export interface DocumentTagsBody {
  ok: true;
  tags: DocumentTag[];
}

/** The most characters of a summary a row carries. */
export const SUMMARY_CAP = 280;
/** The most characters of a search query the bridge will carry to kb. */
export const QUERY_CAP = 200;
/** The most rows one page asks kb for; kb's own ceiling is 100. */
export const LIST_LIMIT_MAX = 100;
export const LIST_LIMIT_DEFAULT = 30;

/**
 * kb's tag paths are ltree labels: `[a-z0-9_]`, dotted. Checked as an allowlist for the reason the
 * slug is — the value is a query parameter, so it cannot escape the URL, but a tag that fails this
 * grammar is one kb will refuse anyway, and refusing it here costs no round trip.
 */
export const TAG_PATTERN = "^[a-z0-9_]+(\\.[a-z0-9_]+)*$";

/** True when `value` holds a control character, which a typed search never does. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** What the browser may ask for, once the request's parameters have been believed. */
export interface DocumentQuery {
  /** Free text; empty means "the recent list". */
  q: string;
  /** A tag path, or empty. */
  tag: string;
  limit: number;
  /** kb's page number for the list; ignored by search, which has no paging. */
  page: number;
}

/**
 * The request's parameters as a {@link DocumentQuery}, or null when one of them is not something
 * this bridge will carry. Control characters in `q` are refused rather than stripped: a search
 * with a newline in it is not a search anybody typed.
 */
export function normaliseDocumentQuery(params: URLSearchParams): DocumentQuery | null {
  const q = (params.get("q") ?? "").trim();
  if (q.length > QUERY_CAP) return null;
  if (hasControlCharacter(q)) return null;
  const tag = (params.get("tag") ?? "").trim();
  if (tag !== "" && !new RegExp(TAG_PATTERN, "u").test(tag)) return null;
  const limitRaw = params.get("limit");
  let limit = LIST_LIMIT_DEFAULT;
  if (limitRaw !== null) {
    if (!/^\d{1,3}$/u.test(limitRaw)) return null;
    limit = Math.min(Math.max(Number(limitRaw), 1), LIST_LIMIT_MAX);
  }
  const cursor = params.get("cursor");
  let page = 0;
  if (cursor !== null && cursor !== "") {
    if (!/^\d{1,4}$/u.test(cursor)) return null;
    page = Number(cursor);
  }
  return { q, tag, limit, page };
}

/** The URL of the kb call that answers `query`. Exported so the test can pin what is sent. */
export function kbListUrl(origin: string, query: DocumentQuery): string {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit));
  if (query.q !== "") {
    params.set("q", query.q);
    if (query.tag !== "") params.set("tag", query.tag);
    return `${origin}/api/search?${params.toString()}`;
  }
  if (query.tag !== "") params.set("tag", query.tag);
  if (query.page > 0) params.set("page", String(query.page));
  return `${origin}/api/documents?${params.toString()}`;
}

export function kbTagsUrl(origin: string): string {
  return `${origin}/api/tags`;
}

export type DocumentListResult =
  | { ok: true; body: DocumentListBody }
  | { ok: false; reason: DocumentFailure };

export type DocumentTagsResult =
  | { ok: true; body: DocumentTagsBody }
  | { ok: false; reason: DocumentFailure };

/** The largest list answer worth reading: a hundred rows of metadata with summaries. */
export const MAX_LIST_BYTES = 1024 * 1024;

function settings(kb: KbSettings, warn: (message: string) => void): { origin: string; token: string } | null {
  const origin = normaliseKbOrigin(kb.origin);
  const token = kb.token.trim();
  if (origin === null || token === "") {
    if (kb.origin.trim() !== "" && origin === null) {
      warn("ignoring the configured document origin — it must be a loopback base URL with no path");
    }
    return null;
  }
  return { origin, token };
}

/** One row of kb's list or search answer, believed field by field, or null when it is not one. */
function readSummary(value: JsonValue): DocumentSummary | null {
  const record = jsonRecord(value);
  if (record === null) return null;
  const slug = jsonStringField(record.slug);
  if (slug === null || !isDocumentSlug(slug)) return null;
  const title = jsonStringField(record.title) ?? "";
  const row: DocumentSummary = { slug, title };
  const summary = jsonStringField(record.summary);
  if (summary !== null && summary.trim() !== "") {
    row.summary = summary.length > SUMMARY_CAP ? `${summary.slice(0, SUMMARY_CAP - 1)}…` : summary;
  }
  const updatedAt = jsonStringField(record.updated_at);
  if (updatedAt !== null) row.updatedAt = updatedAt;
  return row;
}

/** kb's `{results: [...]}` envelope, or null when the answer is not one. */
async function results(
  answer: Awaited<ReturnType<KbIo["fetch"]>>,
  warn: (message: string) => void,
): Promise<JsonValue[] | null> {
  if (answer.status !== 200) return null;
  const text = await body(answer, MAX_LIST_BYTES);
  if (text === null) return null;
  const record = parseRecord(text);
  const rows = record === null ? null : record.results;
  if (!Array.isArray(rows)) {
    warn("kb answered a list with something that is not `{results: [...]}`");
    return null;
  }
  return rows;
}

/**
 * The documents kb lists for `query`, over loopback.
 *
 * Total, like `fetchDocument`: every failure is a `reason`. A row that does not parse is DROPPED
 * rather than failing the page — one odd record in kb must not blank the browser.
 */
export async function listDocuments(
  query: DocumentQuery,
  kb: KbSettings,
  io: KbIo = networkIo,
  warn: (message: string) => void = defaultWarn,
): Promise<DocumentListResult> {
  const conf = settings(kb, warn);
  if (conf === null) return { ok: false, reason: "not_configured" };
  const hop = await ask(kbListUrl(conf.origin, query), conf.token, "application/json", io, warn);
  if (!hop.ok) return hop;
  const rows = await results(hop.answer, warn);
  if (rows === null) return { ok: false, reason: "unusable" };
  const documents: DocumentSummary[] = [];
  for (const item of rows) {
    const row = readSummary(item);
    if (row !== null) documents.push(row);
  }
  const out: DocumentListBody = { ok: true, documents };
  // kb pages the LIST by number and offers nothing past the last page but an empty one; a full page
  // is the only signal there may be more. Search is unpaged.
  if (query.q === "" && rows.length >= query.limit) out.nextCursor = String(query.page + 1);
  return { ok: true, body: out };
}

/** Every tag kb knows, with counts, most-used first. */
export async function listTags(
  kb: KbSettings,
  io: KbIo = networkIo,
  warn: (message: string) => void = defaultWarn,
): Promise<DocumentTagsResult> {
  const conf = settings(kb, warn);
  if (conf === null) return { ok: false, reason: "not_configured" };
  const hop = await ask(kbTagsUrl(conf.origin), conf.token, "application/json", io, warn);
  if (!hop.ok) return hop;
  const rows = await results(hop.answer, warn);
  if (rows === null) return { ok: false, reason: "unusable" };
  const tagPattern = new RegExp(TAG_PATTERN, "u");
  const tags: DocumentTag[] = [];
  for (const item of rows) {
    const row = jsonRecord(item);
    if (row === null) continue;
    const path = jsonStringField(row.path);
    if (path === null || !tagPattern.test(path)) continue;
    const count = jsonNumberField(row.doc_count) ?? 0;
    tags.push({ path, count });
  }
  tags.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return { ok: true, body: { ok: true, tags } };
}
