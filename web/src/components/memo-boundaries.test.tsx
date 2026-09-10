import { describe, expect, it } from "vitest";

import { AgentList } from "./agent-list";
import { AnsiOutput } from "./ansi-output";
import { LaunchStrip } from "./launch-strip";
import { PaneStrip } from "./pane-strip";
import { SpaceStrip } from "./space-strip";
import { TabStrip } from "./tab-strip";

// FORK. The components that re-render on every poll tick because they sit under the data root —
// the list on the dashboard and the strips above the mirror — are memo() boundaries, so a tick
// that changes nothing they show costs them nothing. What is pinned here is the BOUNDARY: a
// memo'd export whose props are then handed fresh closures every render is a memo that never
// hits, which is why home.tsx and agent-chat.tsx stabilise what they pass (see their FORK notes).
const MEMO = Symbol.for("react.memo");

describe("memo boundaries under the poll loop", () => {
  it.each([
    ["AgentList", AgentList],
    ["TabStrip", TabStrip],
    ["PaneStrip", PaneStrip],
    ["SpaceStrip", SpaceStrip],
    ["LaunchStrip", LaunchStrip],
    ["AnsiOutput", AnsiOutput],
  ])("%s is a memo() boundary", (_name, component) => {
    // SAFETY: a React element type is an object; `$$typeof` is the field React itself stamps a
    // memo() wrapper with, and reading it off any object is what this test exists to do.
    const wrapper: { $$typeof?: symbol } = component;
    expect(wrapper.$$typeof).toBe(MEMO);
  });
});
