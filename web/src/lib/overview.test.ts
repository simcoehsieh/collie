import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import {
  __resetTails,
  deliverTailPoke,
  overviewPath,
  readTail,
  replyLines,
  restingPane,
  tailFor,
  tailOf,
} from "./overview";
import type { AgentView } from "@/lib/types";

// FORK: the overview's reads — plain text tails, and a read that must NOT count as looking.

afterEach(() => __resetTails());

const ESC = String.fromCharCode(27);

describe("tailOf", () => {
  it("strips ANSI, drops trailing blank rows and keeps the last rows", () => {
    const text = `${ESC}[32mok${ESC}[0m\nrow 2   \nrow 3\nrow 4\nrow 5\nrow 6\nrow 7\n\n\n`;
    expect(tailOf(text)).toEqual(["row 2", "row 3", "row 4", "row 5", "row 6", "row 7"]);
    expect(tailOf(text, 2)).toEqual(["row 6", "row 7"]);
  });

  it("an empty mirror is an empty tail", () => {
    expect(tailOf("")).toEqual([]);
    expect(tailOf("\n\n")).toEqual([]);
  });
});

describe("readTail", () => {
  it("reads WITHOUT the seen header, and keeps the tail on a 304", async () => {
    const seen: (string | null)[] = [];
    let calls = 0;
    server.use(
      http.get("/api/pane/:paneId", ({ request }) => {
        calls++;
        seen.push(request.headers.get("x-collie-seen"));
        if (request.headers.get("if-none-match") === '"t1"') {
          return new HttpResponse(null, { status: 304 });
        }
        return HttpResponse.json(
          { paneId: "w1:p1", text: "a\nb\nc", truncated: false, revision: 1 },
          { headers: { etag: '"t1"' } },
        );
      }),
    );
    await readTail("w1:p1", undefined);
    expect(tailFor(undefined, "w1:p1")?.lines).toEqual(["a", "b", "c"]);
    await readTail("w1:p1", undefined);
    expect(calls).toBe(2);
    // The overview never marks a pane seen — that is the dashboard's "Ready · unseen" it would clear.
    expect(seen).toEqual([null, null]);
    expect(tailFor(undefined, "w1:p1")?.lines).toEqual(["a", "b", "c"]);
  });

  it("a failed read leaves the previous tail in place", async () => {
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json({ paneId: "w1:p1", text: "kept", truncated: false, revision: 1 }),
      ),
    );
    await readTail("w1:p1", undefined);
    server.use(http.get("/api/pane/:paneId", () => new HttpResponse(null, { status: 500 })));
    await readTail("w1:p1", undefined);
    expect(tailFor(undefined, "w1:p1")?.lines).toEqual(["kept"]);
  });
});

describe("overviewPath", () => {
  it("carries the scope like the other path helpers", () => {
    expect(overviewPath()).toBe("/overview");
    expect(overviewPath({ session: "work" })).toBe("/overview?s=work");
  });
});

// ── FORK (2026-09-11) ─────────────────────────────────────────────────────────────────────────

describe("restingPane — which cards are read for what they SAID", () => {
  const pane = (over: Partial<AgentView>): AgentView => ({
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "done",
    cwd: "/",
    focused: false,
    ...over,
  });

  it("a finished or idle agent rests; working, blocked and a shell never do", () => {
    expect(restingPane(pane({ status: "done" }))).toBe(true);
    expect(restingPane(pane({ status: "idle" }))).toBe(true);
    // A card quoting the last reply mid-answer would be showing the previous message.
    expect(restingPane(pane({ status: "working" }))).toBe(false);
    // A blocked pane's QUESTION is on its screen — quoting what came before it buries the ask.
    expect(restingPane(pane({ status: "blocked" }))).toBe(false);
    // A shell has no journal; its mirror IS the content.
    expect(restingPane(pane({ status: "idle", kind: "shell" }))).toBe(false);
  });
});

describe("replyLines — what a card has room for", () => {
  it("keeps the FIRST rows, not the last: a reply is read from its opening", () => {
    expect(replyLines("one\ntwo\nthree\nfour\nfive\nsix\nseven")).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
  });
  it("collapses runs of blank rows and trims trailing space", () => {
    expect(replyLines("one   \n\n\ntwo")).toEqual(["one", "", "two"]);
  });
});

describe("readTail — the reply for a resting pane", () => {
  /** A mirror that never moves, plus a journal with one spoken turn. */
  function stubBridge() {
    const counts = { history: 0 };
    server.use(
      http.get("/api/pane/:paneId/history", () => {
        counts.history++;
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: [
            {
              uuid: "u1",
              ts: "2026-09-11T00:00:00.000Z",
              role: "assistant",
              parts: [{ kind: "text", text: "All four tests pass now." }],
            },
          ],
          hasMore: false,
          total: 1,
          fileTruncated: false,
        });
      }),
      http.get("/api/pane/:paneId", ({ request }) =>
        request.headers.get("if-none-match") === '"t1"'
          ? new HttpResponse(null, { status: 304 })
          : HttpResponse.json(
              { paneId: "w1:p1", text: "❯ \n───", truncated: false, revision: 1 },
              { headers: { etag: '"t1"' } },
            ),
      ),
    );
    return counts;
  }

  it("the FIRST read only takes the tail — the mirror has not settled yet", async () => {
    const counts = stubBridge();
    await readTail("w1:p1", undefined, undefined, true);
    expect(tailFor(undefined, "w1:p1")?.reply).toBeUndefined();
    expect(counts.history).toBe(0);
  });

  it("an UNCHANGED read is the settle signal, and the journal is read exactly once", async () => {
    const counts = stubBridge();
    await readTail("w1:p1", undefined, undefined, true);
    await readTail("w1:p1", undefined, undefined, true);
    expect(tailFor(undefined, "w1:p1")?.reply).toEqual(["All four tests pass now."]);
    expect(counts.history).toBe(1);
    // Held, not re-fetched: the reply is about a screen that has not moved.
    await readTail("w1:p1", undefined, undefined, true);
    expect(counts.history).toBe(1);
  });

  it("a pane that is NOT resting never touches its journal", async () => {
    const counts = stubBridge();
    await readTail("w1:p1", undefined, undefined, false);
    await readTail("w1:p1", undefined, undefined, false);
    expect(tailFor(undefined, "w1:p1")?.reply).toBeUndefined();
    expect(counts.history).toBe(0);
  });

  it("a mirror that MOVES throws the quoted reply away", async () => {
    const counts = stubBridge();
    await readTail("w1:p1", undefined, undefined, true);
    await readTail("w1:p1", undefined, undefined, true);
    expect(tailFor(undefined, "w1:p1")?.reply).toBeDefined();
    void counts;
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json(
          { paneId: "w1:p1", text: "working…", truncated: false, revision: 2 },
          { headers: { etag: '"t2"' } },
        ),
      ),
    );
    await readTail("w1:p1", undefined, undefined, true);
    expect(tailFor(undefined, "w1:p1")?.reply).toBeUndefined();
    expect(tailFor(undefined, "w1:p1")?.lines).toEqual(["working…"]);
  });
});

describe("deliverTailPoke — a pane poke this screen claims", () => {
  it("is refused for a pane the grid is not showing", () => {
    expect(deliverTailPoke("w9:p9")).toBe(false);
  });
});
