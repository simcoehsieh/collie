import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { __resetTails, overviewPath, readTail, tailFor, tailOf } from "./overview";

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
