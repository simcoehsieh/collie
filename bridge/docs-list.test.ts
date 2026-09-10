import { describe, expect, test } from "bun:test";

import type { KbAnswer, KbIo, KbRequestInit } from "./docs.ts";
import type { JsonValue } from "./json.ts";
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  QUERY_CAP,
  SUMMARY_CAP,
  kbListUrl,
  listDocuments,
  listTags,
  normaliseDocumentQuery,
} from "./docs-list.ts";

// The browser's two proxies. Everything runs through the injected `KbIo`, so nothing opens a
// socket; the token is a sentinel so the last test can prove it never reaches a body.

const TOKEN = "sentinel-token-must-never-escape";
const ORIGIN = "http://127.0.0.1:8082";
const KB = { origin: ORIGIN, token: TOKEN };

function answer(status: number, json: JsonValue): KbAnswer {
  const text = JSON.stringify(json);
  const headers = new Map<string, string>([
    ["content-length", String(Buffer.byteLength(text, "utf8"))],
    ["content-type", "application/json; charset=utf-8"],
  ]);
  return { status, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, text: async () => text };
}

function fakeKb(reply: (url: string, init: KbRequestInit) => KbAnswer): KbIo & { calls: { url: string; init: KbRequestInit }[] } {
  const calls: { url: string; init: KbRequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return reply(url, init);
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

describe("kbListUrl", () => {
  test("a query goes to search, with the tag alongside; no query goes to the list with a page", () => {
    expect(kbListUrl(ORIGIN, { q: "a b", tag: "ai", limit: 10, page: 0 })).toBe(`${ORIGIN}/api/search?limit=10&q=a+b&tag=ai`);
    expect(kbListUrl(ORIGIN, { q: "", tag: "ai", limit: 10, page: 2 })).toBe(`${ORIGIN}/api/documents?limit=10&tag=ai&page=2`);
    expect(kbListUrl(ORIGIN, { q: "", tag: "", limit: 30, page: 0 })).toBe(`${ORIGIN}/api/documents?limit=30`);
  });

  test("a query is a parameter, so a path-shaped one cannot leave the endpoint", () => {
    const url = kbListUrl(ORIGIN, { q: "../../healthz?x", tag: "", limit: 5, page: 0 });
    expect(new URL(url).pathname).toBe("/api/search");
  });
});

describe("listDocuments", () => {
  test("rows are read field by field; a summary is capped; a search hit carries no date", async () => {
    const io = fakeKb(() =>
      answer(200, {
        results: [
          { slug: "a-doc", title: "A", summary: "s".repeat(SUMMARY_CAP + 10), updated_at: "2026-09-06T13:46:34Z" },
          { slug: "b-doc", title: "B" },
          { slug: "Bad Slug", title: "dropped" },
          "not a record",
        ],
      }),
    );
    const res = await listDocuments({ q: "", tag: "", limit: 30, page: 0 }, KB, io, () => {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.documents).toHaveLength(2);
    expect(res.body.documents[0]?.slug).toBe("a-doc");
    expect(res.body.documents[0]?.summary?.length).toBe(SUMMARY_CAP);
    expect(res.body.documents[0]?.updatedAt).toBe("2026-09-06T13:46:34Z");
    expect(res.body.documents[1]).toEqual({ slug: "b-doc", title: "B" });
    expect(res.body.nextCursor).toBeUndefined();
    expect(io.calls[0]?.init.headers["x-internal-token"]).toBe(TOKEN);
    expect(io.calls[0]?.init.redirect).toBe("manual");
  });

  test("a full page of the list offers the next cursor; a search never does", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ slug: `d-${i}`, title: `${i}` }));
    const io = fakeKb(() => answer(200, { results: rows }));
    const list = await listDocuments({ q: "", tag: "", limit: 5, page: 1 }, KB, io, () => {});
    expect(list.ok && list.body.nextCursor).toBe("2");
    const search = await listDocuments({ q: "x", tag: "", limit: 5, page: 0 }, KB, io, () => {});
    expect(search.ok && search.body.nextCursor).toBeUndefined();
  });

  test("off when nothing is configured, without dialling", async () => {
    const io = fakeKb(() => answer(200, { results: [] }));
    expect(await listDocuments({ q: "", tag: "", limit: 5, page: 0 }, { origin: "", token: "" }, io)).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(io.calls).toHaveLength(0);
  });

  test("kb's 401 is the bridge's own misconfiguration, and the token is not in the warning", async () => {
    const warnings: string[] = [];
    const io = fakeKb(() => answer(401, { error: "unauthorized" }));
    const res = await listDocuments({ q: "", tag: "", limit: 5, page: 0 }, KB, io, (m) => warnings.push(m));
    expect(res).toEqual({ ok: false, reason: "unauthorised" });
    expect(warnings.join("\n")).not.toContain(TOKEN);
  });

  test("an answer that is not the envelope is unusable, and a throw is unreachable", async () => {
    const odd = fakeKb(() => answer(200, { documents: [] }));
    expect(await listDocuments({ q: "", tag: "", limit: 5, page: 0 }, KB, odd, () => {})).toEqual({ ok: false, reason: "unusable" });
    const down: KbIo = {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    expect(await listDocuments({ q: "", tag: "", limit: 5, page: 0 }, KB, down, () => {})).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("listTags", () => {
  test("tags come back most-used first, with an ill-formed path dropped", async () => {
    const io = fakeKb(() =>
      answer(200, {
        results: [
          { path: "ai", doc_count: 4 },
          { path: "ai_agent", doc_count: 20 },
          { path: "Bad-Tag", doc_count: 99 },
          { path: "airflow" },
        ],
      }),
    );
    const res = await listTags(KB, io, () => {});
    expect(res.ok && res.body.tags).toEqual([
      { path: "ai_agent", count: 20 },
      { path: "ai", count: 4 },
      { path: "airflow", count: 0 },
    ]);
    expect(io.calls[0]?.url).toBe(`${ORIGIN}/api/tags`);
  });
});
