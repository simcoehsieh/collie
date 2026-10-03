import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandPathsPresent, commandRunnable, missingCommandPaths } from "./command-paths.ts";

describe("missingCommandPaths", () => {
  test("names the absolute paths that are gone, and only those", () => {
    const there = new Set(["/opt/tools/collie_shot/main.py"]);
    const argv = ["uv", "run", "--project", "/home/me/git/retired", "python", "/opt/tools/collie_shot/main.py"];
    expect(missingCommandPaths(argv, (p) => there.has(p))).toEqual(["/home/me/git/retired"]);
  });

  test("leaves bare words alone — a path check is not a PATH lookup", () => {
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

/** Put PATH back exactly: assigning `undefined` to an env var stores the string "undefined". */
function restorePath(saved: string | undefined): void {
  if (saved === undefined) delete process.env.PATH;
  else process.env.PATH = saved;
}

describe("commandRunnable — could the configured command start here?", () => {
  const everywhere = { exists: () => true, which: (program: string) => `/usr/bin/${program}` };

  test("a program the PATH cannot find refuses, even with every file present", () => {
    expect(commandRunnable(["collie-shot", "/opt/tools/main.py"], { ...everywhere, which: () => null })).toBe(false);
  });

  test("a found program with a file gone still refuses", () => {
    const there = (p: string) => p !== "/home/me/git/retired";
    expect(commandRunnable(["uv", "run", "--project", "/home/me/git/retired"], { ...everywhere, exists: there })).toBe(false);
  });

  test("a found program with every file present is runnable", () => {
    expect(commandRunnable(["uv", "run", "--project", "/opt/tools", "python", "/opt/tools/main.py"], everywhere)).toBe(true);
  });

  test("only argv[0] is looked up — a subcommand, a flag or a module name is an argument", () => {
    const asked: string[] = [];
    const which = (program: string) => {
      asked.push(program);
      return program === "uv" ? "/usr/local/bin/uv" : null;
    };
    expect(commandRunnable(["uv", "run", "--project", "/opt/tools", "python", "-m", "shot"], { ...everywhere, which })).toBe(true);
    expect(asked).toEqual(["uv"]);
  });

  test("an empty argv is no command at all", () => {
    expect(commandRunnable([], everywhere)).toBe(false);
  });

  // The default probe, for real: the PATH the spawn would use, read at the moment of asking. Nothing
  // here is executed — the file is created, looked up and deleted.
  test("asks the bridge's own PATH, as it is now, by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-command-paths-bin-"));
    const program = "collie-command-paths-probe";
    const saved = process.env.PATH;
    try {
      writeFileSync(join(dir, program), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, program), 0o755);
      writeFileSync(join(dir, "not-executable"), "plain text\n");

      process.env.PATH = `${dir}:${saved ?? ""}`;
      expect(commandRunnable([program])).toBe(true);
      expect(commandRunnable(["not-executable"])).toBe(false);
      expect(commandRunnable([join(dir, program)])).toBe(true);

      restorePath(saved);
      expect(commandRunnable([program])).toBe(false);
    } finally {
      restorePath(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
