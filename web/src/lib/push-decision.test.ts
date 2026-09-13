import { describe, expect, test } from "vitest";

import {
  ALL_CLEAR_TITLE,
  approveSpec,
  decidePush,
  enforcesUserVisible,
  honouredActions,
  hostSlot,
  notificationPath,
  tagFor,
} from "@/lib/push-decision";
import { scopeSearch } from "@/lib/scope";

describe("decidePush", () => {
  test("a clear retracts the slot regardless of client visibility", () => {
    const expected = { kind: "clear", tag: "collie:herd" };
    expect(decidePush({ type: "clear", tag: "collie:herd" }, false)).toEqual(expected);
    expect(decidePush({ type: "clear", tag: "collie:herd" }, true)).toEqual(expected);
  });

  test("suppresses a show when a Collie tab is visible", () => {
    expect(decidePush({ title: "claude needs you", tag: "collie:herd" }, true)).toEqual({
      kind: "suppress",
    });
  });

  test("shows with the bridge-provided tag, renotify, and deep-link paneId", () => {
    expect(
      decidePush(
        {
          title: "2 agents need you",
          body: "claude, codex",
          tag: "collie:herd",
          renotify: true,
          data: { paneId: "p1" },
        },
        false,
      ),
    ).toEqual({
      kind: "show",
      title: "2 agents need you",
      body: "claude, codex",
      tag: "collie:herd",
      paneId: "p1",
      renotify: true,
    });
  });

  test("falls back to a per-pane tag, default title, empty body, and renotify off", () => {
    expect(decidePush({ data: { paneId: "test" } }, false)).toEqual({
      kind: "show",
      title: "Collie",
      body: "",
      tag: "collie:test",
      paneId: "test",
      renotify: false,
    });
  });

  test("a push with no paneId and no tag shares the generic 'collie' slot", () => {
    expect(decidePush({ title: "hi" }, false)).toMatchObject({
      kind: "show",
      tag: "collie",
      paneId: undefined,
    });
  });

  test("carries a settings target through so the tap can route there", () => {
    expect(
      decidePush(
        {
          title: "Collie 0.12.0 available",
          body: "collie-ctl.sh update",
          data: { target: "settings" },
        },
        false,
      ),
    ).toMatchObject({
      kind: "show",
      title: "Collie 0.12.0 available",
      target: "settings",
      paneId: undefined,
    });
  });

  test("carries a peer's host through to the show decision, for the deep-link", () => {
    expect(
      decidePush(
        {
          title: "claude needs you",
          tag: "collie:herd@box2",
          data: { paneId: "w1:p1", host: "box2", session: "demo" },
        },
        false,
      ),
    ).toMatchObject({ kind: "show", tag: "collie:herd@box2", paneId: "w1:p1", host: "box2", session: "demo" });
  });

  test("a lead push carries no host — the pre-crew decision, unchanged", () => {
    const decision = decidePush({ title: "claude needs you", data: { paneId: "w1:p1" } }, false);
    // SAFETY: the case asserts a field the union's "show" arm does not declare — that ABSENCE is
    // the invariant (a lead push carries no host), so it has to be read off the value to be pinned.
    expect((decision as { host?: string }).host).toBeUndefined();
  });

  // The only new way to strand a notification forever: a retraction computing a different slot than
  // the render did leaves it on the lock screen with nothing left that can ever close it.
  test("a clear resolves the same host-qualified slot its render produced", () => {
    const data = { paneId: "w1:p1", host: "box2" };
    const shown = decidePush({ title: "claude needs you", data }, false);
    const cleared = decidePush({ type: "clear", data }, true);
    // SAFETY: `shown` is the "show" decision produced two lines above (the input carried a title,
    // not `type: "clear"`), and every show decision carries a `tag`.
    expect(cleared).toEqual({ kind: "clear", tag: (shown as { tag: string }).tag });
    expect(cleared).toEqual({ kind: "clear", tag: "collie@box2:w1:p1" });
    // …and the bridge-supplied tag still wins over the fallback, in both directions.
    expect(decidePush({ type: "clear", tag: "collie:herd@box2", data }, false)).toEqual({
      kind: "clear",
      tag: "collie:herd@box2",
    });
  });

  test("an agent push carries no target (defaults to the pane deep-link path)", () => {
    const decision = decidePush({ title: "claude needs you", data: { paneId: "p1" } }, false);
    expect(decision).toMatchObject({ kind: "show", paneId: "p1" });
    // SAFETY: as above — the absence of `target` is what the case pins, so it must be read.
    expect((decision as { target?: string }).target).toBeUndefined();
  });
});

// Apple revokes a subscription after three pushes that show nothing, so on that push service the
// two silent outcomes above have to become visible ones. Every case here pins the SAME slot the
// silent path used, because the replacement is what closes the alert it retracts.
describe("decidePush under a user-visible-only push service", () => {
  test("a retraction becomes a quiet replacement in the same slot", () => {
    expect(decidePush({ type: "clear", tag: "collie:herd" }, false, true)).toEqual({
      kind: "show",
      title: ALL_CLEAR_TITLE,
      body: "",
      tag: "collie:herd",
      renotify: false,
    });
  });

  test("the replacement drops the paneId — a settled agent is not a tap target", () => {
    const decision = decidePush({ type: "clear", data: { paneId: "w1:p1" } }, false, true);
    expect(decision).toMatchObject({ kind: "show", tag: "collie:w1:p1" });
    // SAFETY: pinned by the assertion above — a show decision, whose `paneId` is what this reads.
    expect((decision as { paneId?: string }).paneId).toBeUndefined();
  });

  test("a retraction still routes to the host and session it came from", () => {
    expect(
      decidePush({ type: "clear", data: { host: "box2", session: "work" } }, false, true),
    ).toMatchObject({ kind: "show", tag: "collie@box2", host: "box2", session: "work" });
  });

  test("bridge-supplied copy wins over the built-in all-clear text", () => {
    expect(
      decidePush({ type: "clear", tag: "collie:herd", title: "All done", body: "3 handled" }, false, true),
    ).toMatchObject({ kind: "show", title: "All done", body: "3 handled" });
  });

  test("a visible tab no longer suppresses — it shows without re-alerting", () => {
    expect(
      decidePush({ title: "claude needs you", tag: "collie:herd", renotify: true }, true, true),
    ).toEqual({
      kind: "show",
      title: "claude needs you",
      body: "",
      tag: "collie:herd",
      renotify: false,
    });
  });

  test("with no visible tab the alert is unchanged — renotify still buzzes", () => {
    expect(
      decidePush({ title: "claude needs you", tag: "collie:herd", renotify: true }, false, true),
    ).toMatchObject({ kind: "show", renotify: true });
  });

  // The flag is opt-in: every existing deployment keeps the silent paths it was written against.
  test("omitting the flag leaves both silent outcomes exactly as they were", () => {
    expect(decidePush({ type: "clear", tag: "collie:herd" }, false)).toEqual({
      kind: "clear",
      tag: "collie:herd",
    });
    expect(decidePush({ title: "claude needs you" }, true)).toEqual({ kind: "suppress" });
  });
});

describe("enforcesUserVisible", () => {
  test("Apple's push service does", () => {
    expect(enforcesUserVisible("https://web.push.apple.com/QF1ax7…")).toBe(true);
    expect(enforcesUserVisible("https://push.apple.com/QF1ax7…")).toBe(true);
  });

  test("the push services that keep a silent-push budget do not", () => {
    expect(enforcesUserVisible("https://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(enforcesUserVisible("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(false);
  });

  // Suffix matching on the HOSTNAME, never on the string: `push.apple.com.evil.test` is a different
  // host that a naive `includes()` would have handed Apple's stricter behaviour to.
  test("a lookalike host is not Apple", () => {
    expect(enforcesUserVisible("https://push.apple.com.evil.test/x")).toBe(false);
    expect(enforcesUserVisible("https://notpush.apple.com.other.test/x")).toBe(false);
  });

  // Fail SAFE, not fail quiet: an unreadable endpoint costs one extra notification, while guessing
  // "lenient" wrong costs the subscription — silently, and permanently.
  test("an absent or unparseable endpoint is treated as strict", () => {
    expect(enforcesUserVisible(undefined)).toBe(true);
    expect(enforcesUserVisible(null)).toBe(true);
    expect(enforcesUserVisible("")).toBe(true);
    expect(enforcesUserVisible("not a url")).toBe(true);
  });
});

describe("tagFor", () => {
  test("per-pane vs generic slot", () => {
    expect(tagFor("p1")).toBe("collie:p1");
    expect(tagFor(undefined)).toBe("collie");
  });

  // Two machines' identical pane ids must not coalesce into one slot, where a peer's alert would
  // silently replace the lead's.
  test("a peer's fallback slot is host-qualified; the lead's is untouched", () => {
    expect(tagFor("p1", "box2")).toBe("collie@box2:p1");
    expect(tagFor(undefined, "box2")).toBe("collie@box2");
    expect(tagFor("p1", undefined)).toBe("collie:p1");
    expect(tagFor("p1", "box2")).not.toBe(tagFor("p1", "box3"));
  });
});

// The frontend half of bridge/crew/tags.ts. The bridge writes the tag on a render and this file
// re-derives it on a fallback and on a retraction, so the two derivations must agree by
// construction, not by two string templates that happen to match today.
describe("hostSlot", () => {
  test("reproduces the bridge's crew herd slots exactly", () => {
    expect(hostSlot("collie:herd")).toBe("collie:herd"); // the lead's own — must never move
    expect(hostSlot("collie:herd", "laptop")).toBe("collie:herd@laptop");
    expect(`${hostSlot("collie:herd", "laptop")}:demo`).toBe("collie:herd@laptop:demo");
  });

  // The injectivity argument from bridge/crew/tags.ts, as a test: a member id can hold neither `@`
  // nor `:`, so the character after the base discriminates a peer's slot from a local session's.
  test("a local session cleverly named like a host cannot collide with that host's slot", () => {
    expect(`${hostSlot("collie:herd")}:@laptop`).not.toBe(hostSlot("collie:herd", "laptop"));
  });
});

describe("notificationPath — where a tap lands", () => {
  test("a peer's pane deep-links to that machine, in the canonical param order", () => {
    expect(notificationPath({ paneId: "w1:p1", host: "box2", session: "demo" })).toBe(
      "/pane/w1%3Ap1?h=box2&s=demo",
    );
    expect(notificationPath({ paneId: "w1:p1", host: "box2" })).toBe("/pane/w1%3Ap1?h=box2");
  });

  // The whole backward-compatibility story in one assertion: nothing about a lead-only crew changed.
  test("the lead emits today's bytes — no host param anywhere", () => {
    expect(notificationPath({ paneId: "w1:p1" })).toBe("/pane/w1%3Ap1");
    expect(notificationPath({ paneId: "w1:p1", session: "demo" })).toBe("/pane/w1%3Ap1?s=demo");
    expect(notificationPath({})).toBe("/");
    expect(notificationPath({ paneId: "test" })).toBe("/"); // the push-test payload
  });

  // The update push opens the UPDATES page, not Settings — that is where the check, the card, the
  // peers and the one button live (M16/01). Unscoped on purpose: an update is about the machine
  // the phone is talking to, and `host` must not send the tap somewhere else.
  test("update push opens updates, unscoped", () => {
    expect(notificationPath({ target: "settings", host: "box2" })).toBe("/settings/updates");
  });

  // The WIRE value stays `"settings"` while the destination moves. An old cached service worker
  // holds its own copy of this function and lands on `/settings`, one row from the page it wanted;
  // renaming the field would have sent it to `/` instead.
  test("the wire spelling is unchanged, so an old SW degrades one row away", () => {
    expect(notificationPath({ target: "settings" })).toBe("/settings/updates");
    expect(notificationPath({ target: "updates" })).toBe("/");
  });

  // sw.ts compares the URL it builds against an open client's URL (`client.url !== url`) and
  // navigates when they differ. A differently-ordered but semantically identical query would make
  // every tap on an already-open pane re-navigate it, so the SW must not have its own builder — this
  // pins that the query half IS scopeSearch's output.
  test("the query is lib/scope's, byte for byte — no second builder in the SW", () => {
    for (const scope of [
      {},
      { session: "demo" },
      { host: "box2" },
      { host: "box2", session: "demo" },
      { host: "a b", session: "c&d" },
    ]) {
      expect(notificationPath({ paneId: "w1:p1", ...scope })).toBe(
        `/pane/w1%3Ap1${scopeSearch(scope)}`,
      );
    }
  });
});

describe("decidePush — Yes/No buttons", () => {
  const yesNo = [
    { action: "yes", title: "Yes" },
    { action: "no", title: "No" },
  ];
  const approve = { yes: ["1"], no: ["3"], region: "Do you want to proceed?\n❯ 1. Yes\n  3. No" };

  test("carries the bridge's Yes/No, their binding and the pane's agent through to the show decision", () => {
    expect(
      decidePush(
        {
          title: "claude needs you",
          tag: "collie:herd",
          actions: yesNo,
          data: { paneId: "p1", agent: "claude", approve },
        },
        false,
      ),
    ).toMatchObject({ kind: "show", paneId: "p1", agent: "claude", actions: yesNo, approve });
  });

  test("buttons without a binding, or a binding without buttons, show neither", () => {
    const unbound = decidePush({ title: "t", tag: "collie:herd", actions: yesNo, data: { paneId: "p1" } }, false);
    expect("actions" in unbound).toBe(false);
    expect("approve" in unbound).toBe(false);
    const buttonless = decidePush({ title: "t", tag: "collie:herd", data: { paneId: "p1", approve } }, false);
    expect("actions" in buttonless).toBe(false);
    expect("approve" in buttonless).toBe(false);
    // A half binding is no binding.
    expect(approveSpec({ yes: [], no: ["3"], region: "x" })).toBeUndefined();
    expect(approveSpec({ yes: ["1"], no: ["3"], region: "" })).toBeUndefined();
    expect(approveSpec(approve)).toEqual(approve);
  });

  test("an agent push without buttons, or without a pane, shows exactly as before", () => {
    const plain = decidePush({ title: "t", tag: "collie:herd", data: { paneId: "p1" } }, false);
    expect("actions" in plain).toBe(false);
    expect("agent" in plain).toBe(false);
    const noPane = decidePush({ title: "3 agents need you", tag: "collie:herd", actions: yesNo, data: { approve } }, false);
    expect("actions" in noPane).toBe(false);
  });

  test("buttons the handler cannot honour are dropped whole, never partially", () => {
    expect(honouredActions([{ action: "yes", title: "Yes" }, { action: "later", title: "Later" }], "p1")).toBeUndefined();
    expect(honouredActions([...yesNo, { action: "no", title: "Nope" }], "p1")).toBeUndefined();
    expect(honouredActions([], "p1")).toBeUndefined();
    expect(honouredActions(yesNo, undefined)).toBeUndefined();
    expect(honouredActions([{ action: "yes", title: "Yes" }], "p1")).toEqual([{ action: "yes", title: "Yes" }]);
  });

  test("a retraction never carries buttons — there is nothing left to answer", () => {
    const quiet = decidePush(
      { type: "clear", tag: "collie:herd", actions: yesNo, data: { paneId: "p1", approve } },
      false,
      true,
    );
    expect(quiet.kind).toBe("show");
    expect("actions" in quiet).toBe(false);
  });
});

// FORK: the app icon's badge rides through every decision that can carry one, and is absent —
// never zero — when the payload had none, so the worker leaves the dot alone.
describe("decidePush — badge", () => {
  test("passes the count through on a show, a quiet replacement and a clear; omits it when absent", () => {
    expect(decidePush({ title: "x", badge: 3 }, false)).toMatchObject({ kind: "show", badge: 3 });
    expect("badge" in decidePush({ title: "x" }, false)).toBe(false);
    expect(decidePush({ type: "clear", badge: 0 }, false)).toEqual({ kind: "clear", tag: "collie", badge: 0 });
    expect(decidePush({ type: "clear" }, false)).toEqual({ kind: "clear", tag: "collie" });
    expect(decidePush({ type: "clear", badge: 0 }, false, true)).toMatchObject({ kind: "show", badge: 0 });
  });
});
