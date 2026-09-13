import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { withinRoot } from "./dirs.ts";

// What the agent changed, read off the pane's own working tree — for the phone, read-only.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// Reviewing a change from the phone used to mean asking the agent to paste it into the terminal
// and reading it back off an 84-column mirror. The working tree is on this machine, `git` is on
// this machine, and the pane already tells the bridge its `cwd` — so the bridge can answer "what
// is different" itself, as a file list with counts and, one tap further, one file's unified diff.
//
// ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────────────────────────
// It runs NO write verb. `status`, `diff`, `rev-parse`: three read-only subcommands, each with `--`
// before anything the client named, and nothing that stages, commits, checks out or resets. The
// phone can look; the agent in the pane is the one that acts. A future "revert this file" is a
// different feature with a different gate and a confirm, not an extra branch here.
//
// ── THE SAME JAIL THE FOLDER PICKER HAS ─────────────────────────────────────────────────────────
// The pane's cwd is resolved (`realpath`) and refused unless it lies in the operator's home — the
// rule bridge/dirs.ts states and enforces on the RESOLVED path, reused here rather than restated.
// A path the client names for a patch is checked twice: lexically (no `..`, not absolute, no NUL)
// and then against the repo root after `resolve`, so `--` keeps git honest and the check keeps the
// request honest. Git itself never reads outside the work tree it was pointed at.
//
// ── EVERY SUBPROCESS IS ON A DEADLINE AND A CAP ─────────────────────────────────────────────────
// A pathological repo (a vendored tree, a generated megabyte) must cost the phone a truncated
// answer, never a hung request. Output is read up to {@link DIFF_OUTPUT_CAP} and the process is
// killed past it or past {@link DIFF_TIMEOUT_MS}; both are reported as `truncated` so the UI can
// say so rather than present a partial diff as the whole.

/** How long one `git` call may run. Local disk; a repo that takes longer is one to truncate. */
export const DIFF_TIMEOUT_MS = 5_000;
/** The most bytes of output one call may produce before it is cut and marked `truncated`. */
export const DIFF_OUTPUT_CAP = 512 * 1024;
/** The most files a stat answer carries. A change touching more is not one anybody reviews on a phone. */
export const DIFF_FILE_CAP = 500;
/** Untracked files whose line count is read off disk; past this many they are listed with 0. */
export const UNTRACKED_COUNT_CAP = 50;

/** One `git` invocation's outcome. `code` is null when it was killed (deadline or cap). */
export interface GitRun {
  code: number | null;
  stdout: string;
  /** Output was cut at the cap or the deadline fired mid-stream. */
  truncated: boolean;
}

/**
 * The calls this module makes, injectable so the parsing is exercised under `bun test` against
 * recorded git output and no repo has to be built on disk for each case.
 */
export interface DiffIo {
  git: (args: readonly string[], cwd: string) => Promise<GitRun>;
  realpath: (path: string) => Promise<string>;
  /** The head of one file as text, or null when it is not readable. Used for untracked counts only. */
  readHead: (path: string, cap: number) => Promise<{ text: string; truncated: boolean } | null>;
}

/** Run `git` with the standard hygiene: no optional locks, C locale, a deadline, a byte cap. */
export async function runGit(args: readonly string[], cwd: string): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  let truncated = false;
  const timer = setTimeout(() => {
    truncated = true;
    proc.kill();
  }, DIFF_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > DIFF_OUTPUT_CAP) {
        chunks.push(value.subarray(0, DIFF_OUTPUT_CAP - size));
        size = DIFF_OUTPUT_CAP;
        truncated = true;
        proc.kill();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    truncated = true;
  } finally {
    clearTimeout(timer);
  }
  const code = await proc.exited;
  const stdout = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  return { code: truncated ? null : code, stdout, truncated };
}

async function readHead(path: string, cap: number): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    const slice = size > cap ? file.slice(0, cap) : file;
    return { text: await slice.text(), truncated: size > cap };
  } catch {
    return null;
  }
}

const diskIo: DiffIo = { git: runGit, realpath, readHead };

/** One changed file, as the list draws it. */
export interface DiffFile {
  /** Repo-relative path, the string to hand back for a patch. */
  path: string;
  /** The rename's old path, when the change is a rename. */
  from?: string;
  /**
   * One letter from `git status --porcelain`: `M`odified, `A`dded, `D`eleted, `R`enamed,
   * `?` untracked, `U` unmerged, `T` type change, `C` copied.
   */
  status: string;
  /** Some or all of the change is in the index. */
  staged: boolean;
  additions: number;
  deletions: number;
  /** Git could not count lines (a binary), so the two numbers above are 0 and mean nothing. */
  binary: boolean;
}

/** `GET /api/pane/:id/diff` — the file list. */
export interface DiffStatBody {
  ok: true;
  mode: "stat";
  /** The RESOLVED cwd the pane runs in. */
  cwd: string;
  repoRoot: string;
  /** The branch name, or the abbreviated commit when detached. */
  branch: string;
  files: DiffFile[];
  /** The list was cut at {@link DIFF_FILE_CAP}, or a `git` call was cut short. */
  truncated: boolean;
}

/** `GET /api/pane/:id/diff?mode=patch&path=…` — one file's unified diff. */
export interface DiffPatchBody {
  ok: true;
  mode: "patch";
  path: string;
  patch: string;
  truncated: boolean;
}

/** Why an answer could not be produced. The route turns these into statuses; nothing else reads them. */
export type DiffFailure = "not_found" | "outside_root" | "not_a_repo" | "bad_path" | "timeout";

export type DiffStatResult = { ok: true; body: DiffStatBody } | { ok: false; reason: DiffFailure };
export type DiffPatchResult = { ok: true; body: DiffPatchBody } | { ok: false; reason: DiffFailure };

export interface Repo {
  cwd: string;
  repoRoot: string;
  branch: string;
}

/**
 * Resolve the pane's cwd, jail it to home, and find the repo it sits in.
 *
 * EXPORTED so bridge/file-view.ts reads the same jail rather than a second copy of it. The rule it
 * enforces — realpath both ends, refuse outside home, re-check the repo root because a symlinked
 * `.git` walks out one level up — is the whole safety story of every route that turns a pane's cwd
 * into a path on disk, and a second spelling of it is a second thing that can be subtly weaker.
 */
export async function resolveRepo(
  cwd: string,
  home: string,
  io: DiffIo,
): Promise<{ ok: true; repo: Repo } | { ok: false; reason: DiffFailure }> {
  let homeResolved: string;
  let here: string;
  try {
    homeResolved = await io.realpath(home);
    here = await io.realpath(cwd);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!withinRoot(here, homeResolved)) return { ok: false, reason: "outside_root" };
  const top = await io.git(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], here);
  if (top.truncated) return { ok: false, reason: "timeout" };
  if (top.code !== 0) return { ok: false, reason: "not_a_repo" };
  const [rootLine, branchLine] = top.stdout.split("\n");
  if (!rootLine) return { ok: false, reason: "not_a_repo" };
  let repoRoot: string;
  try {
    repoRoot = await io.realpath(rootLine);
  } catch {
    return { ok: false, reason: "not_a_repo" };
  }
  // The repo root has to be inside home too: a cwd inside home whose `.git` is a symlink out of it
  // would otherwise let the jail be walked around one level up.
  if (!withinRoot(repoRoot, homeResolved)) return { ok: false, reason: "outside_root" };
  const branch = (branchLine ?? "").trim() || "HEAD";
  return { ok: true, repo: { cwd: here, repoRoot, branch } };
}

/** The one letter the list draws for a porcelain `XY` pair, and whether the index holds any of it. */
export interface StatusClass {
  status: string;
  staged: boolean;
}

/** The `XY` pair of a porcelain entry, classified. */
export function classifyStatus(xy: string): StatusClass {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" && y === "?") return { status: "?", staged: false };
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return { status: "U", staged: false };
  }
  // The index side names the change when there is one; the work tree side otherwise. Both present
  // (staged then edited again) reads as the index's letter — that is what will be committed.
  const letter = x !== " " ? x : y;
  return { status: letter, staged: x !== " " };
}

/** Parse `git status --porcelain=v1 -z` into rows (renames carry their old path). */
export function parsePorcelain(out: string): { xy: string; path: string; from?: string }[] {
  const parts = out.split("\0");
  const rows: { xy: string; path: string; from?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.length < 4) continue;
    const xy = part.slice(0, 2);
    const path = part.slice(3);
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      // `-z` puts the ORIGINAL path in the next record.
      const from = parts[++i];
      rows.push(from ? { xy, path, from } : { xy, path });
      continue;
    }
    rows.push({ xy, path });
  }
  return rows;
}

/** Parse `git diff --numstat -z` into counts by path. `-` for a binary becomes `binary: true`. */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "") continue;
    const [a, d, rest] = part.split("\t");
    if (a === undefined || d === undefined) continue;
    const binary = a === "-" || d === "-";
    const additions = binary ? 0 : Number.parseInt(a, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(d, 10) || 0;
    let path = rest ?? "";
    if (path === "") {
      // A rename: `add\tdel\t\0old\0new\0` — the new path is the one the list is keyed by.
      i += 2;
      path = parts[i] ?? "";
    }
    if (path !== "") counts.set(path, { additions, deletions, binary });
  }
  return counts;
}

/** The file list for the repo the pane's cwd sits in. */
export async function diffStat(cwd: string, home: string, io: DiffIo = diskIo): Promise<DiffStatResult> {
  const resolved = await resolveRepo(cwd, home, io);
  if (!resolved.ok) return resolved;
  const { repo } = resolved;
  let truncated = false;

  const status = await io.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"], repo.repoRoot);
  if (status.code !== 0 && !status.truncated) return { ok: false, reason: "not_a_repo" };
  truncated ||= status.truncated;
  const rows = parsePorcelain(status.stdout);

  // Counts for tracked changes come from ONE numstat against HEAD (index and work tree together —
  // what a `git diff HEAD` shows). On an unborn branch HEAD does not resolve; the cached numstat is
  // the closest honest answer there.
  let numstat = await io.git(["diff", "--numstat", "-z", "HEAD", "--"], repo.repoRoot);
  if (numstat.code !== 0 && !numstat.truncated) {
    numstat = await io.git(["diff", "--numstat", "-z", "--cached", "--"], repo.repoRoot);
  }
  truncated ||= numstat.truncated;
  const counts = parseNumstat(numstat.stdout);

  const files: DiffFile[] = [];
  let untrackedCounted = 0;
  for (const row of rows) {
    if (files.length >= DIFF_FILE_CAP) {
      truncated = true;
      break;
    }
    const { status: letter, staged } = classifyStatus(row.xy);
    const file: DiffFile = {
      path: row.path,
      status: letter,
      staged,
      additions: 0,
      deletions: 0,
      binary: false,
    };
    if (row.from) file.from = row.from;
    const known = counts.get(row.path);
    if (known) {
      file.additions = known.additions;
      file.deletions = known.deletions;
      file.binary = known.binary;
    } else if (letter === "?" && untrackedCounted < UNTRACKED_COUNT_CAP) {
      // Untracked files are not in any diff, so their "additions" are their line count, read off
      // the disk under the same cap a patch has. A NUL in the head is a binary.
      untrackedCounted += 1;
      const head = await io.readHead(resolve(repo.repoRoot, row.path), DIFF_OUTPUT_CAP);
      if (head === null) {
        // unreadable — leave the zeros
      } else if (head.text.includes("\0")) {
        file.binary = true;
      } else {
        let lines = 0;
        for (let i = 0; i < head.text.length; i++) if (head.text.charCodeAt(i) === 10) lines += 1;
        if (head.text.length > 0 && !head.text.endsWith("\n")) lines += 1;
        file.additions = lines;
      }
    }
    files.push(file);
  }

  return {
    ok: true,
    body: {
      ok: true,
      mode: "stat",
      cwd: repo.cwd,
      repoRoot: repo.repoRoot,
      branch: repo.branch,
      files,
      truncated,
    },
  };
}

/**
 * Whether `path` is a repo-relative path this module will hand to git.
 *
 * Lexical: no NUL, not absolute, no `..` segment, no leading `-` (an option in disguise even behind
 * `--`, for a reader). The resolved containment check is done again against the repo root by the
 * caller, so this is the cheap first gate, not the only one.
 */
export function isRepoRelativePath(path: string): boolean {
  if (path === "" || path.includes("\0")) return false;
  if (isAbsolute(path) || path.startsWith("-")) return false;
  // `.git` is refused as a segment: nothing under it is a change the agent made, and a diff of its
  // contents is not a thing the phone needs to be able to ask for.
  return !path.split(/[\\/]/u).some((segment) => segment === ".." || segment === ".git");
}

/** One file's unified diff against HEAD (or, untracked, against nothing). */
export async function diffPatch(
  cwd: string,
  path: string,
  home: string,
  io: DiffIo = diskIo,
): Promise<DiffPatchResult> {
  if (!isRepoRelativePath(path)) return { ok: false, reason: "bad_path" };
  const resolved = await resolveRepo(cwd, home, io);
  if (!resolved.ok) return resolved;
  const { repo } = resolved;
  const target = resolve(repo.repoRoot, path);
  if (!withinRoot(target, repo.repoRoot) || target === repo.repoRoot) return { ok: false, reason: "bad_path" };

  const status = await io.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path], repo.repoRoot);
  if (status.truncated) return { ok: false, reason: "timeout" };
  const row = parsePorcelain(status.stdout).find((r) => r.path === path);
  if (row === undefined) return { ok: false, reason: "not_found" };

  let run: GitRun;
  if (row.xy === "??") {
    // `--no-index` exits 1 when the two sides differ, which for a new file is every time.
    run = await io.git(["diff", "--no-index", "--", "/dev/null", path], repo.repoRoot);
    if (!run.truncated && run.code !== 0 && run.code !== 1) return { ok: false, reason: "not_found" };
  } else {
    run = await io.git(["diff", "HEAD", "--", path], repo.repoRoot);
    if (!run.truncated && run.code !== 0) {
      run = await io.git(["diff", "--cached", "--", path], repo.repoRoot);
      if (!run.truncated && run.code !== 0) return { ok: false, reason: "not_found" };
    }
  }
  return {
    ok: true,
    body: { ok: true, mode: "patch", path, patch: run.stdout, truncated: run.truncated },
  };
}
