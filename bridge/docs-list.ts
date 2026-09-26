import type { JsonObject } from "./json.ts";
import {
  agentryIo,
  agentryQuery,
  defaultWarn,
  isDocumentSlug,
  sqlText,
  type AgentryIo,
  type AgentrySettings,
  type DocumentFailure,
} from "./docs.ts";
import { jsonNumberField, jsonStringField } from "./stt/json.ts";

// THE BROWSER: a list and a search, over the same store bridge/docs.ts reads.
//
// The document route opens ONE document whose slug an agent happened to print. That leaves every
// document the agent did not print unreachable from the phone. `GET /api/docs` answers "which
// documents" — the recent list, a search, or one tag's documents — as slugs and titles the panel
// can draw and tap; `GET /api/docs/tags` is the chip row above it. The store is agentry's
// `documents_latest` view since 2026-09-26 (it was kb's HTTP API before; the wire shape the phone
// sees did not change). What the phone TYPED reaches `agentry query` only as a quoted SQL literal
// (`sqlText`), and `agentry query` refuses anything but a read in any case.
//
// A separate module rather than more of docs.ts, because docs.ts is the part with the containment
// argument in it and this part has none to make: nothing here is served as HTML, nothing is framed.

/** A document as the browser lists it: enough to draw a row and open it, and nothing else. */
export interface DocumentSummary {
  slug: string;
  title: string;
  /** The document's own summary, cut to {@link SUMMARY_CAP} — a row's second line, not a page. */
  summary?: string;
  /** ISO-8601, from agentry's `updated_at`. */
  updatedAt?: string;
}

/** One tag with the number of documents under it (descendants included, kb's `<@`). */
export interface DocumentTag {
  path: string;
  count: number;
}

/** `GET /api/docs` — the list. `nextCursor` is present when there may be more. */
export interface DocumentListBody {
  ok: true;
  documents: DocumentSummary[];
  nextCursor?: string;
}

/** `GET /api/docs/tags` — every tag a listed document carries, with counts. */
export interface DocumentTagsBody {
  ok: true;
  tags: DocumentTag[];
}

/** The most characters of a summary a row carries. */
export const SUMMARY_CAP = 280;
/** The most characters of a search query the bridge will carry to agentry. */
export const QUERY_CAP = 200;
/** The most rows one page asks for (kb's own ceiling, kept). */
export const LIST_LIMIT_MAX = 100;
export const LIST_LIMIT_DEFAULT = 30;

/**
 * Tag paths are kb's ltree labels, carried into agentry as they were: `[a-z0-9_]`, dotted. Checked
 * as an allowlist for the reason the slug is — the value is quoted into SQL, and a tag that fails
 * this grammar is one no document carries, so refusing it here costs nothing.
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
  /** The page number for the list; ignored by search, which has no paging. */
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

/**
 * The filter every browsing query shares: drafts stay out of the list, the search and the tag
 * counts, as they did in kb (`lifecycle_status = 'knowledge'`). A draft still OPENS by slug.
 */
const LISTED = "coalesce(kb_status, '') <> 'draft'";

/**
 * A tag and its descendants, the way kb's ltree `<@` counted them: `database` matches `database`
 * and `database.pgvector`, never `databases`. `tag` must already have passed {@link TAG_PATTERN}.
 */
function tagClause(tag: string): string {
  return `EXISTS (SELECT 1 FROM unnest(tags) AS u(t) WHERE t = ${sqlText(tag)} OR starts_with(t, ${sqlText(`${tag}.`)}))`;
}

/**
 * The SQL that answers `query`. Exported so the test can pin what is run.
 *
 * kb searched its chunks by keyword and by (never-populated) embeddings; agentry keeps no text of
 * the HTML in a queryable column, so a search here is a case-insensitive substring over the title,
 * the summary, the slug and the tags. Every value the phone sent reaches the SQL through
 * {@link sqlText} or as a number the query normaliser already bounded.
 */
export function documentListSql(query: DocumentQuery): string {
  const where = [LISTED];
  if (query.tag !== "") where.push(tagClause(query.tag));
  if (query.q !== "") {
    const needle = sqlText(query.q.toLowerCase());
    where.push(
      `(contains(lower(title), ${needle}) OR contains(lower(coalesce(summary, '')), ${needle}) ` +
        `OR contains(slug, ${needle}) OR list_contains(tags, ${needle}))`,
    );
  }
  const offset = query.q === "" ? query.page * query.limit : 0;
  return (
    "SELECT slug, title, summary, epoch_ms(updated_at) AS updated_ms FROM documents_latest " +
    `WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, slug LIMIT ${String(query.limit)} OFFSET ${String(offset)}`
  );
}

/** The SQL behind the tag chips: every listed document's tags, counted on this side. */
export const TAGS_SQL = `SELECT tags FROM documents_latest WHERE ${LISTED}`;

export type DocumentListResult =
  | { ok: true; body: DocumentListBody }
  | { ok: false; reason: DocumentFailure };

export type DocumentTagsResult =
  | { ok: true; body: DocumentTagsBody }
  | { ok: false; reason: DocumentFailure };

/** One row of the list or search answer, believed field by field, or null when it is not one. */
function readSummary(record: JsonObject): DocumentSummary | null {
  const slug = jsonStringField(record.slug);
  if (slug === null || !isDocumentSlug(slug)) return null;
  const title = jsonStringField(record.title) ?? "";
  const row: DocumentSummary = { slug, title };
  const summary = jsonStringField(record.summary);
  if (summary !== null && summary.trim() !== "") {
    row.summary = summary.length > SUMMARY_CAP ? `${summary.slice(0, SUMMARY_CAP - 1)}…` : summary;
  }
  // Epoch milliseconds, turned into ISO-8601 here: DuckDB prints a TIMESTAMPTZ in the session's
  // zone with a space for the `T`, which Safari's `Date` has refused to parse before.
  const updatedMs = jsonNumberField(record.updated_ms);
  if (updatedMs !== null && Number.isFinite(updatedMs)) row.updatedAt = new Date(updatedMs).toISOString();
  return row;
}

/**
 * The documents agentry lists for `query`.
 *
 * Total, like `fetchDocument`: every failure is a `reason`. A row that does not parse is DROPPED
 * rather than failing the page — one odd record must not blank the browser.
 */
export async function listDocuments(
  query: DocumentQuery,
  settings: AgentrySettings,
  io: AgentryIo = agentryIo,
  warn: (message: string) => void = defaultWarn,
): Promise<DocumentListResult> {
  const answer = await agentryQuery(documentListSql(query), settings, io, warn);
  if (!answer.ok) return answer;
  const documents: DocumentSummary[] = [];
  for (const item of answer.rows) {
    const row = readSummary(item);
    if (row !== null) documents.push(row);
  }
  const out: DocumentListBody = { ok: true, documents };
  // A full page is the only signal there may be more. Search is unpaged, as it was in kb.
  if (query.q === "" && answer.rows.length >= query.limit) out.nextCursor = String(query.page + 1);
  return { ok: true, body: out };
}

/**
 * Every tag a listed document carries, with counts, most-used first. A document tagged
 * `database.pgvector` also counts under `database` — kb's `<@` — and once per document however
 * many of its tags sit under the same parent.
 */
export async function listTags(
  settings: AgentrySettings,
  io: AgentryIo = agentryIo,
  warn: (message: string) => void = defaultWarn,
): Promise<DocumentTagsResult> {
  const answer = await agentryQuery(TAGS_SQL, settings, io, warn);
  if (!answer.ok) return answer;
  const tagPattern = new RegExp(TAG_PATTERN, "u");
  const counts = new Map<string, number>();
  for (const row of answer.rows) {
    const list = row.tags;
    if (!Array.isArray(list)) continue;
    const mine = new Set<string>();
    for (const value of list) {
      const path = jsonStringField(value);
      if (path === null || !tagPattern.test(path)) continue;
      const labels = path.split(".");
      for (let i = 1; i <= labels.length; i++) mine.add(labels.slice(0, i).join("."));
    }
    for (const path of mine) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const tags: DocumentTag[] = [...counts].map(([path, count]) => ({ path, count }));
  tags.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return { ok: true, body: { ok: true, tags } };
}
