import { describe, expect, test } from "bun:test";

import type { AgentryIo } from "./docs.ts";
import type { QuotaRun } from "./quota.ts";
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  QUERY_CAP,
  SUMMARY_CAP,
  TAGS_SQL,
  documentListSql,
  listDocuments,
  listTags,
  normaliseDocumentQuery,
} from "./docs-list.ts";

// The browser's two reads. `agentry query` is replaced by a scripted `run` that records the SQL it
// was handed, so every case can assert both what was asked and what came back.

const STORE = { home: "/Users/op/agentry-data", cli: "/Users/op/.local/bin/agentry" };

function envelope(rows: object[]): QuotaRun {
  return { code: 0, stdout: JSON.stringify({ ok: true, data: rows }), timedOut: false };
}

function fakeAgentry(reply: (sql: string) => QuotaRun): AgentryIo & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    run: async (argv) => {
      const text = argv[argv.length - 1] ?? "";
      sql.push(text);
      return reply(text);
    },
    read: async () => {
      throw new Error("the browser reads no document file");
    },
  };
}

const params = (s: string) => new URLSearchParams(s);

describe("normaliseDocumentQuery", () => {
  test("empty is the recent list at the default page size", () => {
    expect(normaliseDocumentQuery(params(""))).toEqual({ q: "", tag: "", limit: LIST_LIMIT_DEFAULT, page: 0 });
  });

  test("a query, a tag, a limit and a cursor are carried; the limit is clamped", () => {
    expect(normaliseDocumentQuery(params("q=collie%20push&tag=ai.llm&limit=500&cursor=3"))).toEqual({
      q: "collie push",
      tag: "ai.llm",
      limit: LIST_LIMIT_MAX,
      page: 3,
    });
  });

  test("refuses a control character, an over-long query, a bad tag, a bad cursor", () => {
    expect(normaliseDocumentQuery(params("q=a%0Ab"))).toBeNull();
    expect(normaliseDocumentQuery(params(`q=${"x".repeat(QUERY_CAP + 1)}`))).toBeNull();
    expect(normaliseDocumentQuery(params("tag=Claude-Ops"))).toBeNull();
    expect(normaliseDocumentQuery(params("tag=../x"))).toBeNull();
    expect(normaliseDocumentQuery(params("cursor=abc"))).toBeNull();
    expect(normaliseDocumentQuery(params("limit=-1"))).toBeNull();
  });
});

describe("documentListSql", () => {
  test("the recent list: drafts out, newest first, paged by OFFSET", () => {
    expect(documentListSql({ q: "", tag: "", limit: 30, page: 2 })).toBe(
      "SELECT slug, title, summary, epoch_ms(updated_at) AS updated_ms FROM documents_latest " +
        "WHERE coalesce(kb_status, '') <> 'draft' ORDER BY updated_at DESC, slug LIMIT 30 OFFSET 60",
    );
  });

  test("a tag matches itself and its descendants, the way kb's ltree <@ did", () => {
    const sql = documentListSql({ q: "", tag: "database", limit: 10, page: 0 });
    expect(sql).toContain("t = 'database' OR starts_with(t, 'database.')");
  });

  test("a search is a lower-cased substring over title, summary, slug and tags, and is unpaged", () => {
    const sql = documentListSql({ q: "Herdr", tag: "", limit: 10, page: 3 });
    expect(sql).toContain("contains(lower(title), 'herdr')");
    expect(sql).toContain("contains(lower(coalesce(summary, '')), 'herdr')");
    expect(sql).toContain("contains(slug, 'herdr')");
    expect(sql).toContain("list_contains(tags, 'herdr')");
    expect(sql).toEndWith("LIMIT 10 OFFSET 0");
  });

  test("what the phone typed stays inside its literal — a quote cannot end it", () => {
    const sql = documentListSql({ q: "x') OR 1=1 --", tag: "", limit: 5, page: 0 });
    expect(sql).toContain("'x'') or 1=1 --'");
    expect(sql).not.toContain("'x')");
  });
});

describe("listDocuments", () => {
  test("rows are read field by field; a summary is capped; the date becomes ISO-8601", async () => {
    const io = fakeAgentry(() =>
      envelope([
        { slug: "a-doc", title: "A", summary: "s".repeat(SUMMARY_CAP + 10), updated_ms: Date.parse("2026-09-06T13:46:34Z") },
        { slug: "b-doc", title: "B", summary: null, updated_ms: null },
        { slug: "Bad Slug", title: "dropped" },
      ]),
    );
    const res = await listDocuments({ q: "", tag: "", limit: 30, page: 0 }, STORE, io, () => {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.documents).toHaveLength(2);
    expect(res.body.documents[0]?.slug).toBe("a-doc");
    expect(res.body.documents[0]?.summary?.length).toBe(SUMMARY_CAP);
    expect(res.body.documents[0]?.updatedAt).toBe("2026-09-06T13:46:34.000Z");
    expect(res.body.documents[1]).toEqual({ slug: "b-doc", title: "B" });
    expect(res.body.nextCursor).toBeUndefined();
    expect(io.sql).toEqual([documentListSql({ q: "", tag: "", limit: 30, page: 0 })]);
  });

  test("a full page of the list offers the next cursor; a search never does", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ slug: `d-${i}`, title: `${i}` }));
    const io = fakeAgentry(() => envelope(rows));
    const list = await listDocuments({ q: "", tag: "", limit: 5, page: 1 }, STORE, io, () => {});
    expect(list.ok && list.body.nextCursor).toBe("2");
    const search = await listDocuments({ q: "x", tag: "", limit: 5, page: 0 }, STORE, io, () => {});
    expect(search.ok && search.body.nextCursor).toBeUndefined();
  });

  test("off when nothing is configured, without running agentry", async () => {
    const io = fakeAgentry(() => envelope([]));
    expect(await listDocuments({ q: "", tag: "", limit: 5, page: 0 }, { home: "", cli: STORE.cli }, io)).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(io.sql).toHaveLength(0);
  });

  test("agentry's error is unusable; a deadline is unreachable", async () => {
    const failed = fakeAgentry(() => ({ code: 2, stdout: JSON.stringify({ ok: false, error: { code: "USAGE" } }), timedOut: false }));
    expect(await listDocuments({ q: "", tag: "", limit: 5, page: 0 }, STORE, failed, () => {})).toEqual({ ok: false, reason: "unusable" });
    const slow = fakeAgentry(() => ({ code: null, stdout: "", timedOut: true }));
    expect(await listDocuments({ q: "", tag: "", limit: 5, page: 0 }, STORE, slow, () => {})).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("listTags", () => {
  test("a document counts once under each tag and each ancestor of one, most-used first", async () => {
    const io = fakeAgentry(() =>
      envelope([
        { tags: ["database.pgvector", "database.postgres", "ai"] },
        { tags: ["database"] },
        { tags: ["ai", "Bad-Tag"] },
        { tags: null },
      ]),
    );
    const res = await listTags(STORE, io, () => {});
    expect(res.ok && res.body.tags).toEqual([
      { path: "ai", count: 2 },
      { path: "database", count: 2 },
      { path: "database.pgvector", count: 1 },
      { path: "database.postgres", count: 1 },
    ]);
    expect(io.sql).toEqual([TAGS_SQL]);
  });
});
