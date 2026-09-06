import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

// Directory listing, for the "pick a folder" half of creating a space. It exists because the
// alternative was typing an absolute path on a phone keyboard, into a field whose only feedback for
// a typo is a shell that opens somewhere else.
//
// ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────────────────────────
// It is not a file browser. It answers with DIRECTORY NAMES and nothing else: no file names, no
// sizes, no mtimes, no contents. The one question it can answer is "what folders are under here",
// which is the whole of what a folder picker needs, and every answer it cannot give is a question
// nobody can ask it later by accident.
//
// ── THE ROOT IS THE OPERATOR'S HOME, AND IT IS ENFORCED ON THE RESOLVED PATH ──────────────────────
// A client may ask for any path; the bridge resolves it (`realpath`, which follows every symlink and
// eats every `..`) and refuses anything that is not the home directory or inside it. Checking the
// REQUESTED path would be theatre — `~/x/../../etc` normalises away and a symlink resolves away —
// so nothing is compared until the kernel has told us where the path actually lands. The same rule
// is applied a second time to each ENTRY, because a symlink inside home can point outside it.
//
// This is a smaller promise than "the phone is trusted": the route is gated on WRITE, not read,
// even though it writes nothing. A device that may not create a space has no use for the list, and
// the narrower gate is free.
//
// ── DOTFILES ARE OMITTED ─────────────────────────────────────────────────────────────────────────
// Not for safety — a caller can still name `~/.config` directly and get its children — but because
// a home directory has dozens of them and none is the project you are looking for. The manual path
// field stays in the sheet for exactly the cases this omission costs.

/** One directory, as the picker needs it: what to draw, and what to ask for next. */
export interface DirEntry {
  name: string;
  path: string;
}

/** The listing of one directory. `parent` is null at the root, where there is nowhere up to go. */
export interface DirsBody {
  ok: true;
  /** The RESOLVED directory this listing is of — never the string the client asked with. */
  path: string;
  parent: string | null;
  /** So the client can render `~/git` without knowing which machine answered. */
  home: string;
  entries: DirEntry[];
  /** True when the cap below cut the list short, so the UI can say so rather than lie by omission. */
  truncated: boolean;
}

/**
 * The most entries one listing may carry.
 *
 * A cap rather than pagination: a directory with more than this many subdirectories is not one
 * anybody scrolls through on a phone to find a project, so the useful answer there is the manual
 * path field, not page 7. The number exists to bound the response, and `truncated` is what stops
 * the bound from being silent.
 */
export const DIR_ENTRY_CAP = 500;

/**
 * Expand a leading `~` and resolve to an absolute path, against `home`.
 *
 * Pure, and it does NOT decide anything about safety — `~/../etc` resolves to a real path outside
 * home here and is refused later, by the check that runs after the kernel has resolved symlinks
 * too. Doing containment here as well would be a second, weaker copy of that rule.
 */
export function expandHome(input: string, home: string): string {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "~") return home;
  if (trimmed === "~/" || trimmed.startsWith(`~${sep}`)) return resolve(home, trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(home, trimmed);
}

/**
 * Whether `candidate` is `root` itself or lies inside it.
 *
 * Both must already be RESOLVED — this is a string comparison and cannot see through a symlink or a
 * `..`, which is why every caller here realpaths first. The separator is appended so `/home/simon`
 * does not contain `/home/simone`.
 */
export function withinRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/** The filesystem calls this module makes, injectable so the rules above are testable without one. */
export interface DirsIo {
  readdir: typeof readdir;
  realpath: typeof realpath;
  stat: typeof stat;
}

const diskIo: DirsIo = { readdir, realpath, stat };

/** Why a listing could not be produced. The route turns these into statuses; nothing else reads them. */
export type DirsFailure = "not_found" | "outside_root" | "not_a_directory";

export type DirsResult = { ok: true; body: DirsBody } | { ok: false; reason: DirsFailure };

/**
 * List the directories under `want`, rooted at `home`.
 *
 * Total: every failure is a `reason`, never a throw, because the caller is an HTTP handler and a
 * missing directory is an ordinary answer rather than an exception.
 */
export async function listDirs(
  want: string,
  home: string,
  io: DirsIo = diskIo,
): Promise<DirsResult> {
  let root: string;
  try {
    root = await io.realpath(home);
  } catch {
    // A home directory that cannot be resolved is not a client error, but there is nothing to list
    // and nothing useful to say beyond that.
    return { ok: false, reason: "not_found" };
  }

  let here: string;
  try {
    here = await io.realpath(expandHome(want, home));
  } catch {
    return { ok: false, reason: "not_found" };
  }
  // AFTER realpath, never before: `..` and symlinks are both gone by now, so this compares the place
  // the read would actually happen.
  if (!withinRoot(here, root)) return { ok: false, reason: "outside_root" };

  let stats;
  try {
    stats = await io.stat(here);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!stats.isDirectory()) return { ok: false, reason: "not_a_directory" };

  let names;
  try {
    names = await io.readdir(here, { withFileTypes: true });
  } catch {
    // Present but unreadable — a permission wall is not a missing directory, but the picker's move
    // is the same either way: stay where you are and say the listing failed.
    return { ok: false, reason: "not_found" };
  }

  const entries: DirEntry[] = [];
  for (const dirent of names) {
    if (dirent.name.startsWith(".")) continue;
    const full = join(here, dirent.name);
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: full });
      continue;
    }
    // A symlink is not a directory to `readdir`, and a home directory full of symlinked repos is an
    // ordinary shape. Following one costs a stat and a realpath, and the realpath is not optional:
    // a link inside home may point anywhere, and this list is what the next request will ask for.
    if (!dirent.isSymbolicLink()) continue;
    try {
      const target = await io.stat(full);
      if (!target.isDirectory()) continue;
      const resolved = await io.realpath(full);
      if (!withinRoot(resolved, root)) continue;
      entries.push({ name: dirent.name, path: full });
    } catch {
      // A broken link. Drop the row; one dangling symlink must not cost the operator the directory.
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const truncated = entries.length > DIR_ENTRY_CAP;

  return {
    ok: true,
    body: {
      ok: true,
      path: here,
      // Nowhere up to go from the root, and saying so is what keeps the UI from offering a step it
      // would then have to refuse.
      parent: here === root ? null : dirname(here),
      home: root,
      entries: truncated ? entries.slice(0, DIR_ENTRY_CAP) : entries,
      truncated,
    },
  };
}
