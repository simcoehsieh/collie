import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandPathsPresent, missingCommandPaths } from "./command-paths.ts";

describe("missingCommandPaths", () => {
  test("names the absolute paths that are gone, and only those", () => {
    const there = new Set(["/opt/tools/collie_shot/main.py"]);
    const argv = ["uv", "run", "--project", "/home/me/git/retired", "python", "/opt/tools/collie_shot/main.py"];
    expect(missingCommandPaths(argv, (p) => there.has(p))).toEqual(["/home/me/git/retired"]);
  });

  test("leaves bare words to the PATH — only a spawn could prove them, and this never spawns", () => {
    expect(missingCommandPaths(["uv", "run", "--project", "python"], () => false)).toEqual([]);
  });

  test("asks the real disk by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-command-paths-"));
    try {
      const script = join(dir, "main.py");
      writeFileSync(script, "print('hi')\n");
      expect(commandPathsPresent(["python3", script])).toBe(true);
      expect(commandPathsPresent(["python3", join(dir, "gone.py")])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
