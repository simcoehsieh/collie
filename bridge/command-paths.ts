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
// So a seam is advertised when its own files are on disk, not merely when it is named. The check is
// PASSIVE: a stat per absolute path, nothing spawned, nothing read. A bare word (`uv`, `python`, a
// flag) is the PATH's business and is left alone, because only a spawn can prove it — and a spawn per
// `/api/config` is exactly the cost this must not have. Re-asked on every config read, so putting the
// files back brings the row back on the next boot of the page, with no restart.

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
