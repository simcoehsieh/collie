import { describe, expect, test } from "bun:test";

import { parseStatusLine, sanitizeStatusLine } from "./parse.ts";
import {
  readStatusLine,
  statusLineFileName,
  statusLineIsStale,
  statusLineKey,
  statusLinesDir,
  STATUS_LINE_FRESH_MS,
  STATUS_LINE_MAX_CHARS,
  STATUS_LINE_SCHEMA_VERSION,
  STATUS_LINE_TTL_MS,
  type StatusLineDirectory,
} from "./status-line.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import type { JsonObject } from "../json.ts";

// The agent-authored status line. Everything here is the ADR 0024 boundary in test form: what the
// reader will accept off disk, what it refuses, and the fact that nothing it produces is more than
// a sentence.

const SESSION: AgentSessionRef = { kind: "id", value: "5f3a2b1c-0000-4000-8000-abcdefabcdef" };
const NOW = 1_757_000_000_000;

const record = (over: JsonObject = {}) =>
  JSON.stringify({
    schemaVersion: STATUS_LINE_SCHEMA_VERSION,
    session: SESSION,
    line: "rewriting the journal adapter",
    writtenMs: NOW - 1000,
    ...over,
  });

/** A directory holding exactly one file, by name. Everything else answers "nothing here". */
function oneFile(name: string, text: string): StatusLineDirectory {
  return { read: async (asked) => (asked === name ? text : null) };
}

describe("statusLineKey", () => {
  test("is stable, short and hex", () => {
    expect(statusLineKey(SESSION)).toMatch(/^[0-9a-f]{16}$/u);
    expect(statusLineKey(SESSION)).toBe(statusLineKey({ ...SESSION }));
  });

  test("an id and a path spelling the same string are different keys", () => {
    expect(statusLineKey({ kind: "id", value: "x" })).not.toBe(statusLineKey({ kind: "path", value: "x" }));
  });

  test("the file name carries no separator, whatever the ref looked like", () => {
    const name = statusLineFileName(statusLineKey({ kind: "path", value: "/home/s/../etc/passwd" }));
    expect(name).toMatch(/^[0-9a-f]{16}\.json$/u);
  });
});

describe("statusLinesDir", () => {
  test("is a folder INSIDE the beacon directory, so the beacon sweep's listing skips it", () => {
    expect(statusLinesDir("/tmp/state")).toBe("/tmp/state/beacons/status");
  });
});

describe("sanitizeStatusLine", () => {
  test("flattens a sentence onto one line", () => {
    expect(sanitizeStatusLine("running\tthe\n migration  now ")).toBe("running the migration now");
  });

  test("strips control characters, so a terminal escape never reaches a phone", () => {
    expect(sanitizeStatusLine(`before${String.fromCodePoint(0x1b)}[31mafter`)).toBe("before [31mafter");
  });

  test("clamps a long line rather than refusing it", () => {
    expect(sanitizeStatusLine("z".repeat(400))).toHaveLength(STATUS_LINE_MAX_CHARS);
  });
});

describe("parseStatusLine", () => {
  test("reads a well-formed record", () => {
    expect(parseStatusLine(record())).toEqual({
      schemaVersion: STATUS_LINE_SCHEMA_VERSION,
      session: SESSION,
      line: "rewriting the journal adapter",
      writtenMs: NOW - 1000,
    });
  });

  test("is total over garbage", () => {
    expect(parseStatusLine("")).toBeNull();
    expect(parseStatusLine("{oops")).toBeNull();
    expect(parseStatusLine("null")).toBeNull();
    expect(parseStatusLine("[]")).toBeNull();
    expect(parseStatusLine('"a string"')).toBeNull();
  });

  test("a newer schema is skipped rather than guessed at", () => {
    expect(parseStatusLine(record({ schemaVersion: 2 }))).toBeNull();
  });

  test("a missing or malformed field is no record at all", () => {
    expect(parseStatusLine(record({ session: { kind: "wat", value: "x" } }))).toBeNull();
    expect(parseStatusLine(record({ line: 42 }))).toBeNull();
    expect(parseStatusLine(record({ writtenMs: "soon" }))).toBeNull();
  });

  test("a line that sanitises away is not a line", () => {
    expect(parseStatusLine(record({ line: "   \n\t " }))).toBeNull();
  });

  test("sanitises on the way OUT too — a file already on disk was written by an older writer", () => {
    const parsed = parseStatusLine(record({ line: "two\nlines" }));
    expect(parsed?.line).toBe("two lines");
  });
});

describe("readStatusLine", () => {
  const name = statusLineFileName(statusLineKey(SESSION));

  test("answers the line for its own session", async () => {
    const reading = await readStatusLine(SESSION, {
      directory: oneFile(name, record()),
      now: () => NOW,
    });
    expect(reading).toEqual({ line: "rewriting the journal adapter", writtenMs: NOW - 1000 });
  });

  test("null when there is no file", async () => {
    expect(await readStatusLine(SESSION, { directory: { read: async () => null }, now: () => NOW })).toBeNull();
  });

  test("a throw from the directory is nothing here, not an error", async () => {
    const directory: StatusLineDirectory = {
      read: () => Promise.reject(new Error("state dir gone")),
    };
    expect(await readStatusLine(SESSION, { directory, now: () => NOW })).toBeNull();
  });

  // The file's name is derived from its OWN ref, so contents that disagree with the name are not
  // this session's — which is what stops a file copied onto another key decorating a stranger.
  test("refuses a record whose session disagrees with the name it is under", async () => {
    const foreign = record({ session: { kind: "id", value: "someone-else" } });
    expect(await readStatusLine(SESSION, { directory: oneFile(name, foreign), now: () => NOW })).toBeNull();
  });

  test("a line older than the TTL is gone, not merely old", async () => {
    const ancient = record({ writtenMs: NOW - STATUS_LINE_TTL_MS - 1 });
    expect(await readStatusLine(SESSION, { directory: oneFile(name, ancient), now: () => NOW })).toBeNull();
  });
});

describe("statusLineIsStale", () => {
  test("fifteen minutes is the line between full strength and dimmed", () => {
    expect(statusLineIsStale(NOW - STATUS_LINE_FRESH_MS + 1, NOW)).toBe(false);
    expect(statusLineIsStale(NOW - STATUS_LINE_FRESH_MS - 1, NOW)).toBe(true);
  });
});
