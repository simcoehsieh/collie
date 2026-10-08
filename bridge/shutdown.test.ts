import { describe, expect, test } from "bun:test";

import { stopWithin, type StoppableServer } from "./shutdown.ts";

// FORK: a graceful stop must not wait on the live feed forever (bridge/shutdown.ts).
function fakeServer(drainsOnItsOwn: boolean): StoppableServer & { calls: boolean[] } {
  const calls: boolean[] = [];
  let release: () => void = () => {};
  const graceful = new Promise<void>((r) => {
    release = r;
    if (drainsOnItsOwn) r();
  });
  return {
    calls,
    stop(force = false) {
      calls.push(force);
      if (force) {
        release();
        return Promise.resolve();
      }
      return graceful;
    },
  };
}

describe("stopWithin", () => {
  test("a server that drains in time is stopped gracefully and never forced", async () => {
    const server = fakeServer(true);
    expect(await stopWithin(server, 1000, () => new Promise(() => {}))).toBe(false);
    expect(server.calls).toEqual([false]);
  });

  test("a stream that never ends is closed once the window passes", async () => {
    const server = fakeServer(false);
    expect(await stopWithin(server, 1000, () => Promise.resolve())).toBe(true);
    expect(server.calls).toEqual([false, true]);
  });
});
