import { afterEach, describe, expect, it, vi } from "vitest";

// FORK: the production default is the terminal (lib/pane-view.ts `FORK_CHAT_DEFAULT_ON`). The gate is
// read at import, and tests run with MODE "test", so this re-imports the module under production's MODE.
describe("FORK: the 1.17 chat flip is off in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults a device with no choice to the terminal", async () => {
    vi.stubEnv("MODE", "production");
    vi.resetModules();
    const m = await import("./pane-view");
    expect(m.FORK_CHAT_DEFAULT_ON).toBe(false);
    expect(m.coercePaneView(undefined)).toBe("terminal");
    expect(m.coercePaneView("chat")).toBe("chat");
  });
});
