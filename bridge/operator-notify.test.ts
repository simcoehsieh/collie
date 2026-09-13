import { describe, expect, test } from "bun:test";

import { createOperatorNotifyRules, validateOperatorNotifyRules } from "./operator-notify.ts";

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
