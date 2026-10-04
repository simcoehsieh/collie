import { describe, expect, test } from "bun:test";

import {
  createOperatorNotifyRules,
  validateOperatorNotifyRules,
  validateOperatorNotifySessions,
} from "./operator-notify.ts";

// FORK — `notify.toml`'s grammar (bridge/operator-notify.ts): one rule per [[panes]] table, in the
// phone's own vocabulary, and the same hold-the-last-good-rows reader every operator file gets.

describe("validateOperatorNotifyRules", () => {
  test("a label rule and an id rule, in file order", () => {
    const warnings: string[] = [];
    const rules = validateOperatorNotifyRules(
      { panes: [{ label: "listener", mode: "blocked" }, { paneId: "w2:p1", mode: "mute" }] },
      (m) => warnings.push(m),
    );
    expect(rules).toEqual([{ label: "listener", mode: "blocked" }, { paneId: "w2:p1", mode: "mute" }]);
    expect(warnings).toEqual([]);
  });

  test("no file section is no rules; a non-array section is refused with one warning", () => {
    expect(validateOperatorNotifyRules(null)).toEqual([]);
    expect(validateOperatorNotifyRules({})).toEqual([]);
    const warnings: string[] = [];
    expect(validateOperatorNotifyRules({ panes: { label: "x" } }, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("must be an array");
  });

  test("a bad row costs that row, never the file, and says why", () => {
    const warnings: string[] = [];
    const rules = validateOperatorNotifyRules(
      {
        panes: [
          "not a table",
          { label: "quiet", mode: "loud" },
          { mode: "mute" },
          { label: "ok", mode: "all", snoozedUntil: 5 },
        ],
      },
      (m) => warnings.push(m),
    );
    expect(rules).toEqual([{ label: "ok", mode: "all" }]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("not a [[panes]] table");
    expect(warnings[1]).toContain("mode is not one of default | all | blocked | mute");
    expect(warnings[2]).toContain("names no pane");
    expect(warnings[3]).toContain("snoozedUntil is ignored");
  });
});

describe("FORK: validateOperatorNotifySessions", () => {
  test("a [[sessions]] row mutes one session by name; [[panes]] rows are not its business", () => {
    const warnings: string[] = [];
    const doc = {
      panes: [{ label: "alfred-chat", mode: "blocked" }],
      sessions: [{ session: "dev", mode: "mute" }],
    };
    expect(validateOperatorNotifySessions(doc, (m) => warnings.push(m))).toEqual([{ session: "dev", mode: "mute" }]);
    expect(validateOperatorNotifyRules(doc, (m) => warnings.push(m))).toEqual([{ label: "alfred-chat", mode: "blocked" }]);
    expect(warnings).toEqual([]);
  });

  test("no section is no rules; a bad row costs that row and says why; the first row for a session stands", () => {
    expect(validateOperatorNotifySessions(null)).toEqual([]);
    expect(validateOperatorNotifySessions({})).toEqual([]);
    const warnings: string[] = [];
    const rules = validateOperatorNotifySessions(
      {
        sessions: [
          "not a table",
          { session: "dev", mode: "quiet" },
          { session: "", mode: "mute" },
          { session: "has space", mode: "mute" },
          { session: " dev ", mode: "mute" },
          { session: "dev", mode: "all" },
        ],
      },
      (m) => warnings.push(m),
    );
    expect(rules).toEqual([{ session: "dev", mode: "mute" }]);
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toContain("not a [[sessions]] table");
    expect(warnings[1]).toContain("mode is not one of");
    expect(warnings[2]).toContain("not a session name");
    expect(warnings[3]).toContain("not a session name");
    expect(warnings[4]).toContain("the first one stands");
    const refused: string[] = [];
    expect(validateOperatorNotifySessions({ sessions: { session: "dev" } }, (m) => refused.push(m))).toEqual([]);
    expect(refused[0]).toContain("must be an array");
  });
});

describe("createOperatorNotifyRules", () => {
  test("reads the file behind an mtime check and keeps the last good rules when it stops parsing", async () => {
    let mtime = 1;
    let text = '[[panes]]\nlabel = "listener"\nmode = "blocked"\n';
    let reads = 0;
    const warnings: string[] = [];
    const read = createOperatorNotifyRules(
      "/cfg/notify.toml",
      {
        mtime: () => Promise.resolve(mtime),
        read: () => {
          reads++;
          return Promise.resolve(text);
        },
      },
      (m) => warnings.push(m),
    );
    expect(await read()).toEqual([{ label: "listener", mode: "blocked" }]);
    expect(await read()).toEqual([{ label: "listener", mode: "blocked" }]);
    expect(reads).toBe(1);
    mtime = 2;
    text = "[[panes]\nlabel = \n";
    expect(await read()).toEqual([{ label: "listener", mode: "blocked" }]);
    expect(warnings.some((w) => w.includes("could not be parsed"))).toBe(true);
  });
});
