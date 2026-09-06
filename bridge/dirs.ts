import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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
// ── EVERY FILESYSTEM CALL IS ON A DEADLINE ───────────────────────────────────────────────────────
// A listing must not be able to hang, and on a real home directory it can. MEASURED on the
// operator's Mac: `~/git` answered in 3ms and `~` never answered at all, and the difference was one
// symlink — `~/Google Drive`, which resolves into `~/Library/CloudStorage/`, a FileProvider mount.
// From a shell with Full Disk Access that `realpath` takes 61ms; from the bridge, which launchd
// starts without one, it never returns, and Bun closed the connection at its 10s idle timeout with
// the request still pending.
//
// So the shape of the fix is not "special-case CloudStorage" — the next stalled mount will have a
// different name — it is that one unresponsive ENTRY costs its own row and nothing else. Per-entry
// work is bounded and dropped on timeout; the calls that decide the whole listing are bounded too
// and fail it honestly rather than hanging. The entries are also resolved in PARALLEL, so a
// directory of slow-but-answering links costs one deadline rather than N.
//
// ── DOTFILES ARE OMITTED ─────────────────────────────────────────────────────────────────────────
// Not for safety — a caller can still name `~/.config` directly and get its children — but because
// a home directory has dozens of them and none is the project you are looking for. The manual path
// field stays in the sheet for exactly the cases this omission costs.

/**
 * How long one ENTRY's symlink resolution may take before the row is dropped.
 *
 * Generous next to a local `lstat` (microseconds) and short next to a human waiting for a folder
 * list. A row lost to it is a symlink this machine cannot answer for quickly, which is exactly the
 * row a picker should not be offering: tapping it would hand the same stall to the next request.
 */
export const ENTRY_TIMEOUT_MS = 150;

/**
 * How long the calls that decide the WHOLE listing may take — resolving the path, stat'ing it,
 * reading it. Larger than the per-entry budget because there is no partial answer to fall back to:
 * this one either produces the listing or fails it.
 */
export const LISTING_TIMEOUT_MS = 2_000;

/** A sentinel distinguishable from every value the wrapped calls return. */
const TIMED_OUT = Symbol("timed out");

/**
 * `promise`, or {@link TIMED_OUT} if it has not settled within `ms`.
 *
 * The timer is CLEARED when the promise wins — a race that leaves its timer armed keeps a handle
 * alive per call, which on a route is a leak with a listing's cadence. The losing filesystem promise
 * is left pending, which is the part that cannot be fixed here: `fs.promises` has no cancellation,
 * so the only thing in our gift is to stop WAITING on it.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      // `settle`, not `resolve`: `node:path`'s `resolve` is in scope in this file, and shadowing it
      // inside a timing primitive is exactly the confusion nobody needs while reading one.
      new Promise<typeof TIMED_OUT>((settle) => {
        timer = setTimeout(() => settle(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/**
 * Whether `candidate` lies in ANY of `roots` — the containment rule once the operator has declared
 * more than one place the picker may look.
 *
 * Same contract as {@link withinRoot}: everything is already RESOLVED, because a string comparison
 * cannot see through a symlink. Empty roots would mean "nothing is allowed"; callers never pass
 * that (the config falls back to home), and the honest answer here is still `false`.
 */
export function withinAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => withinRoot(candidate, root));
}

/** The little of a `Dirent` this module reads. */
interface DirentLike {
  name: string;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

/**
 * The filesystem calls this module makes, injectable so the rules above are testable without one.
 *
 * Declared as the CALL SHAPES USED rather than as `typeof readdir` and friends. Naming node's
 * functions would drag their whole overload sets in, and then the only way to write a fake — which
 * is how a stalled entry is tested at all, since a real one cannot be held open on purpose — is a
 * cast that throws the type evidence away. Node's own functions satisfy these narrower signatures,
 * so the production value below is checked, not asserted.
 */
export interface DirsIo {
  readdir: (path: string, options: { withFileTypes: true }) => Promise<readonly DirentLike[]>;
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isDirectory: () => boolean }>;
}

const diskIo: DirsIo = { readdir, realpath, stat };

/**
 * Resolve `want` and answer it only if it lands inside the allowed roots — the SAME rule the
 * listing enforces, exported so the create path cannot drift from the browse path.
 *
 * This exists because a boundary only the picker respects is decoration: `POST /api/workspace`
 * takes a `cwd` straight from the client, so without this it would open a shell anywhere on the
 * disk while the folder list politely refused to show it. Returns the RESOLVED path (what the
 * caller should actually use) or `null`.
 *
 * `roots` empty = home, matching {@link listDirs} and upstream's behaviour.
 */
export async function resolveWithinRoots(
  want: string,
  home: string,
  configuredRoots: readonly string[] = [],
  io: DirsIo = diskIo,
): Promise<string | null> {
  const bounded = async <T>(call: () => Promise<T>): Promise<T | null> => {
    try {
      const value = await withDeadline(call(), LISTING_TIMEOUT_MS);
      return value === TIMED_OUT ? null : value;
    } catch {
      return null;
    }
  };
  const homeResolved = await bounded(() => io.realpath(home));
  if (homeResolved === null) return null;
  const resolvedRoots: string[] = [];
  for (const declared of configuredRoots) {
    const r = await bounded(() => io.realpath(expandHome(declared, home)));
    if (r !== null && !resolvedRoots.includes(r)) resolvedRoots.push(r);
  }
  const roots = resolvedRoots.length > 0 ? resolvedRoots : [homeResolved];
  // An empty ask means "the default", and with roots declared the default is the first root rather
  // than home — home is not a place this bridge may open a shell in any more.
  const asked = want.trim();
  const target =
    asked === "" || asked === "~"
      ? resolvedRoots.length > 0
        ? roots[0]!
        : homeResolved
      : expandHome(asked, home);
  const here = await bounded(() => io.realpath(target));
  if (here === null) return null;
  return withinAnyRoot(here, roots) ? here : null;
}

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
  configuredRoots: readonly string[] = [],
): Promise<DirsResult> {
  /** Run one of the whole-listing calls under {@link LISTING_TIMEOUT_MS}; a throw or a stall is null. */
  const bounded = async <T>(call: () => Promise<T>): Promise<T | null> => {
    try {
      const value = await withDeadline(call(), LISTING_TIMEOUT_MS);
      return value === TIMED_OUT ? null : value;
    } catch {
      return null;
    }
  };

  // A home directory that cannot be resolved is not a client error, but there is nothing to list and
  // nothing useful to say beyond that.
  const homeResolved = await bounded(() => io.realpath(home));
  if (homeResolved === null) return { ok: false, reason: "not_found" };

  // THE ROOTS ARE RESOLVED TOO, and for the same reason every other path here is: the containment
  // test below is a string comparison, so a root reached through a symlink would never match the
  // resolved path of anything inside it. A configured root that cannot be resolved (a typo, an
  // unmounted disk) is DROPPED rather than fatal — one bad line in the operator's config must not
  // take the picker down — and if that leaves nothing, home is the fallback, which is exactly the
  // upstream behaviour this feature narrows.
  const resolvedRoots: string[] = [];
  for (const declared of configuredRoots) {
    const r = await bounded(() => io.realpath(expandHome(declared, home)));
    if (r !== null && !resolvedRoots.includes(r)) resolvedRoots.push(r);
  }
  const roots: string[] = resolvedRoots.length > 0 ? resolvedRoots : [homeResolved];
  const declaredRoots = resolvedRoots.length > 0;

  // ── THE VIRTUAL TOP ──────────────────────────────────────────────────────────────────────────
  // With several roots there is no single directory above them that the operator is allowed to see,
  // so "the top" is not a place on disk: it is the list of roots themselves. `path: ""` says so —
  // it is the one listing whose `path` is not a resolved directory, and `parent: null` stops the up
  // arrow there. Asking for "" with a SINGLE root is not this case: that root IS the top, and
  // answering with a one-row virtual level would make the operator tap twice to reach it.
  const asked = want.trim();
  const atTop = asked === "" || asked === "~";
  if (atTop && declaredRoots && roots.length > 1) {
    const entries = roots
      .map((r) => ({ name: basename(r), path: r }))
      .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return {
      ok: true,
      body: { ok: true, path: "", parent: null, home: homeResolved, entries, truncated: false },
    };
  }

  // With roots declared, "" means the FIRST one rather than home — home is not somewhere this
  // picker may look any more, so resolving the default there would open on a 403.
  const startAt = atTop && declaredRoots ? roots[0]! : expandHome(want, home);
  const here = await bounded(() => io.realpath(startAt));
  if (here === null) return { ok: false, reason: "not_found" };
  // AFTER realpath, never before: `..` and symlinks are both gone by now, so this compares the place
  // the read would actually happen.
  if (!withinAnyRoot(here, roots)) return { ok: false, reason: "outside_root" };

  const stats = await bounded(() => io.stat(here));
  if (stats === null) return { ok: false, reason: "not_found" };
  if (!stats.isDirectory()) return { ok: false, reason: "not_a_directory" };

  // Present but unreadable — a permission wall is not a missing directory, but the picker's move is
  // the same either way: stay where you are and say the listing failed.
  const names = await bounded(() => io.readdir(here, { withFileTypes: true }));
  if (names === null) return { ok: false, reason: "not_found" };

  const entries: DirEntry[] = [];
  /** The symlinks worth following, resolved together rather than one after another. */
  const links: string[] = [];
  for (const dirent of names) {
    if (dirent.name.startsWith(".")) continue;
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: join(here, dirent.name) });
      continue;
    }
    // A symlink is not a directory to `readdir`, and a home directory full of symlinked repos is an
    // ordinary shape. Following one costs a stat and a realpath, and the realpath is not optional:
    // a link inside home may point anywhere, and this list is what the next request will ask for.
    if (dirent.isSymbolicLink()) links.push(dirent.name);
  }

  const followed = await Promise.all(
    links.map(async (name): Promise<DirEntry | null> => {
      const full = join(here, name);
      try {
        // ONE deadline over both calls, not one each: what is being bounded is "how long this row
        // may hold up the listing", and a link that spends the whole budget in `stat` has already
        // spent it. A stall, a throw (a dangling link) and a non-directory all drop the row — one
        // bad entry must never cost the operator the directory.
        const target = await withDeadline(io.stat(full), ENTRY_TIMEOUT_MS);
        if (target === TIMED_OUT || !target.isDirectory()) return null;
        const resolved = await withDeadline(io.realpath(full), ENTRY_TIMEOUT_MS);
        if (resolved === TIMED_OUT || !withinAnyRoot(resolved, roots)) return null;
        return { name, path: full };
      } catch {
        return null;
      }
    }),
  );
  for (const entry of followed) {
    if (entry !== null) entries.push(entry);
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
      // Null at ANY root, not just at home: each declared root is a top the operator may not step
      // above, and offering an up arrow there would only produce a refusal.
      parent: roots.includes(here) ? null : dirname(here),
      home: homeResolved,
      entries: truncated ? entries.slice(0, DIR_ENTRY_CAP) : entries,
      truncated,
    },
  };
}
