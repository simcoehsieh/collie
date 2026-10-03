import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

// FORK — IS A CONFIGURED SEAM STILL THERE?
//
// Two of this fork's seams run something outside the checkout: annotate-and-ask spawns
// `COLLIE_SHOT_COMMAND`, and the document panel spawns `agentry query` against `COLLIE_AGENTRY_HOME`.
// Both were advertised to the phone on the strength of the setting being NON-EMPTY, and a setting can
// outlive the thing it names: on 2026-10-03 the shot command still pointed into a repository that had
// been retired a week earlier, so the pane menu offered a row that could only fail, and four weeks of
// zero use meant nobody noticed.
//
// So a seam is advertised when what it runs is there, not merely when it is named. The check is
// PASSIVE: a stat per absolute path, a PATH lookup for the program, nothing spawned, nothing read — a
// spawn per `/api/config` is exactly the cost this must not have. Re-asked on every config read, so
// putting the files back brings the row back on the next boot of the page, with no restart.

/** Every token of `argv` that is an absolute path and is not there. Empty means "nothing missing". */
export function missingCommandPaths(
  argv: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  return argv.filter((token) => isAbsolute(token) && !exists(token));
}

/** Whether every absolute path a configured command names is on disk. */
export function commandPathsPresent(argv: readonly string[], exists?: (path: string) => boolean): boolean {
  return missingCommandPaths(argv, exists).length === 0;
}

/**
 * Where the bridge's own spawn would find `program`, or null where it would fail with "Executable not
 * found in $PATH".
 *
 * The PATH is the one the spawn uses, read NOW: the shot runner hands its child `process.env`
 * (bridge/shot.ts), and Bun resolves a bare name through the PATH in the env it is given. A bare
 * `Bun.which(program)` would not do — it keeps the PATH the process STARTED with — and neither
 * would `findTool` (bridge/tools.ts), whose fallback directories would find a `uv` in
 * `/opt/homebrew/bin` that a launchd PATH without that directory never reaches. `Bun.which` stats
 * the PATH's directories for an executable file; it runs nothing.
 */
export function resolveOnBridgePath(program: string): string | null {
  return Bun.which(program, { PATH: process.env.PATH ?? "" });
}

/** The two questions a readiness check asks the machine, replaceable so a test can answer them. */
export interface CommandProbe {
  /** Whether an absolute path is on disk. Defaults to the real disk. */
  exists?: (path: string) => boolean;
  /** Where the spawn would find a program. Defaults to {@link resolveOnBridgePath}. */
  which?: (program: string) => string | null;
}

/**
 * Whether a configured command could START here: its program (`argv[0]`) resolves the way the spawn
 * resolves it, and every absolute path among its arguments is on disk.
 *
 * Only `argv[0]` is looked up. Every later token is an argument — `run` in `uv run`, a flag, a
 * module name — and resolving those as programs would refuse commands that work.
 */
export function commandRunnable(argv: readonly string[], probe: CommandProbe = {}): boolean {
  const [program, ...args] = argv;
  if (program === undefined) return false;
  if ((probe.which ?? resolveOnBridgePath)(program) === null) return false;
  return commandPathsPresent(args, probe.exists);
}
