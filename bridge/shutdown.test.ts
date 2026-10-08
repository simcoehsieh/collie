import { describe, expect, test } from "bun:test";

import { armShutdownDeadline, stopWithin, type StoppableServer } from "./shutdown.ts";

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

describe("armShutdownDeadline", () => {
  test("exits once the deadline passes, and says so", async () => {
    const exits: number[] = [];
    const lines: string[] = [];
    armShutdownDeadline(5, (code) => exits.push(code), (line) => lines.push(line));
    await new Promise((r) => setTimeout(r, 30));
    expect(exits).toEqual([0]);
    expect(lines[0]).toContain("still running after 5 ms");
  });

  test("a shutdown that finishes first can clear it", async () => {
    const exits: number[] = [];
    clearTimeout(armShutdownDeadline(20, (code) => exits.push(code), () => {}));
    await new Promise((r) => setTimeout(r, 40));
    expect(exits).toEqual([]);
  });
});
