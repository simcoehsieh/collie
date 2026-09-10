import { describe, expect, test } from "vitest";

import { fixtureAgents } from "@/test/handlers";
import type { AgentView, PaneNotifyRule } from "@/lib/types";
import { orphanRules, ruleFor, stableLabel, withMode, withSnooze, without } from "./notify-rules";

const pane = (over: Partial<AgentView> = {}): AgentView => ({ ...fixtureAgents[0]!, ...over });

describe("notify-rules", () => {
  test("ruleFor: id before label, label against every name, case-insensitively", () => {
    const byId: PaneNotifyRule = { paneId: "w1:p1", mode: "mute" };
    const byLabel: PaneNotifyRule = { label: "WEBAPP", mode: "blocked" };
    expect(ruleFor([byLabel, byId], pane())).toBe(byId);
    expect(ruleFor([byLabel], pane())).toBe(byLabel);
    expect(ruleFor([{ label: "nope", mode: "all" }], pane())).toBeNull();
  });

  test("stableLabel: the operator's pane name, else the space — never the tab or the title", () => {
    expect(stableLabel(pane({ paneLabel: "logs", tabLabel: "claude", terminalTitle: "fixing" }))).toBe("logs");
    expect(stableLabel(pane({ tabLabel: "claude", terminalTitle: "fixing" }))).toBe("webapp");
  });

  test("withMode creates a rule carrying the pane's id AND its stable label, and edits it in place", () => {
    const one = withMode([], pane(), "mute", 0);
    expect(one).toEqual([{ paneId: "w1:p1", label: "webapp", mode: "mute" }]);
    const two = withMode(one, pane(), "blocked", 0);
    expect(two).toEqual([{ paneId: "w1:p1", label: "webapp", mode: "blocked" }]);
    // Back to default with nothing else on the rule → the rule goes.
    expect(withMode(two, pane(), "default", 0)).toEqual([]);
    // …but a live snooze keeps it.
    const snoozed = withSnooze(two, pane(), 10_000, 0);
    expect(withMode(snoozed, pane(), "default", 0)).toEqual([
      { paneId: "w1:p1", label: "webapp", mode: "default", snoozedUntil: 10_000 },
    ]);
  });

  test("withSnooze sets and clears the pane's own quiet deadline; an elapsed one is a clear", () => {
    const on = withSnooze([], pane(), 5_000, 0);
    expect(on).toEqual([{ paneId: "w1:p1", label: "webapp", mode: "default", snoozedUntil: 5_000 }]);
    expect(withSnooze(on, pane(), null, 0)).toEqual([]);
    expect(withSnooze(on, pane(), 5_000, 6_000)).toEqual([]);
    // A label hit on someone else's rule does not get edited — the pane gets its own row.
    const other: PaneNotifyRule = { label: "webapp", mode: "mute" };
    expect(withSnooze([other], pane(), 5_000, 0)).toEqual([
      other,
      { paneId: "w1:p1", label: "webapp", mode: "default", snoozedUntil: 5_000 },
    ]);
  });

  test("orphanRules are the rules no listed pane claims; without() drops one", () => {
    const live: PaneNotifyRule = { paneId: "w1:p1", mode: "mute" };
    const gone: PaneNotifyRule = { paneId: "w9:p9", mode: "mute" };
    const label: PaneNotifyRule = { label: "collie", mode: "blocked" };
    expect(orphanRules([live, gone, label], [pane()])).toEqual([gone, label]);
    expect(orphanRules([live, gone, label], fixtureAgents)).toEqual([gone]);
    expect(without([live, gone], gone)).toEqual([live]);
  });
});
