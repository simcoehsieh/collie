import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { withinRoot } from "./dirs.ts";
import { isRepoRelativePath, resolveRepo, runGit, type DiffFailure, type DiffIo } from "./diff.ts";

// FORK. One file of the pane's own working tree, read-only, for the phone.
//
// ── WHY THIS EXISTS BESIDE bridge/diff.ts RATHER THAN INSIDE IT ─────────────────────────────────
// The diff sheet answers "what changed"; half the time the next question is "what does the rest of
// that file say" — the twenty lines above the hunk, a file the agent mentioned but did not touch, a
// config the change assumes. `git diff` cannot answer either: an unchanged file has no patch, and a
// hunk's context is three lines by construction. So this is a different question against the same
// jail, and it is a different module for the reason bridge/diff.ts's own header gives about write
// verbs — one module, one question, so the surface each one exposes stays enumerable.
//
// ── THE JAIL IS NOT RE-WRITTEN HERE, IT IS IMPORTED ─────────────────────────────────────────────
// {@link resolveRepo} (the pane's cwd realpath'd and refused outside the operator's home, plus the
// repo root re-checked so a symlinked `.git` cannot walk out one level up) and
// {@link isRepoRelativePath} (no NUL, not absolute, no `..`, no leading `-`, no `.git` segment) are
// bridge/diff.ts's, verbatim, and the resolved containment check after `resolve` is run AGAIN here
// against the repo root. Three checks, none of them new, and the reason none of them is new is that
// a second spelling of a path jail is a second thing that can be subtly weaker than the first.
//
// ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────────────────────────
// It serves the WORKING TREE — the bytes on disk right now, which is what the operator is looking
// at the diff of — and never `git show HEAD:<path>`. A file the agent has not committed is the
// common case here, and an answer that silently showed the committed version of an edited file
// would be worse than no answer. It also serves TEXT only: a binary is refused rather than
// base64'd, because nothing on the phone would do anything with the bytes (a picture an agent wrote
// already has its own route, `/api/blobs/<hash>`), and it writes nothing, ever.

/**
 * The most bytes of one file this route will read.
 *
 * The same number as `DIFF_OUTPUT_CAP` in bridge/diff.ts, and the same number on purpose: a
 * patch and a file are the same kind of payload arriving at the same sheet over the same mobile
 * link, so two different ceilings would only be two different surprises. Past it the file is served
 * TRUNCATED rather than refused — a 600 KB lockfile whose first 512 KiB answers the question is a
 * better answer than a 413, and `truncated` is what stops the bound being silent.
 */
export const FILE_VIEW_CAP = 512 * 1024;

/**
 * How many leading bytes decide "binary".
 *
 * A NUL in the head is what `git` itself uses and what bridge/diff.ts already uses for an untracked
 * file's line count. It is checked over a bounded head rather than the whole slice because a file
 * whose first 8 KiB is clean text and whose middle is not is not a file this sniff has to catch:
 * the UTF-8 validation below sees every byte that is about to be served and refuses it anyway.
 */
export const BINARY_SNIFF_BYTES = 8192;

/** Why a file could not be served. The route turns these into statuses; nothing else reads them. */
export type FileViewFailure = DiffFailure | "binary";

/** `GET /api/pane/:id/file?path=…` — one file of the work tree, as text. */
export interface FileViewBody {
  ok: true;
  mode: "file";
  /** The repo-relative path that was asked for, echoed so a client cannot mismatch body to request. */
  path: string;
  /** The file's text. Never markup, never highlighted — see web/src/components/file-sheet.tsx. */
  text: string;
  /** The file's real size on disk, so the sheet can say what a truncated view is a view OF. */
  bytes: number;
  /** The read stopped at {@link FILE_VIEW_CAP}; what is here is a prefix, not the file. */
  truncated: boolean;
}

export type FileViewResult = { ok: true; body: FileViewBody } | { ok: false; reason: FileViewFailure };

/** The head of one file as BYTES, plus the size it was read from. Null when it is not readable. */
export interface FileBytes {
  bytes: Uint8Array;
  /** The file's size on disk — which is larger than `bytes.byteLength` exactly when it was capped. */
  size: number;
}

/**
 * The calls this module makes: bridge/diff.ts's three (so {@link resolveRepo} can be handed this
 * same object) plus a byte read of its own.
 *
 * `readBytes` rather than diff.ts's `readHead`, and the difference is the whole binary story:
 * `readHead` hands back a string, so the bytes have already been through a lossy UTF-8 decode by
 * the time anyone could ask whether they WERE UTF-8. A `\xff` becomes U+FFFD and looks like text.
 */
export interface FileViewIo extends DiffIo {
  readBytes: (path: string, cap: number) => Promise<FileBytes | null>;
}

async function readBytes(path: string, cap: number): Promise<FileBytes | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    // A directory (or anything else without a byte length) is not a file this route can answer for.
    if (!Number.isFinite(size) || size < 0) return null;
    const slice = size > cap ? file.slice(0, cap) : file;
    return { bytes: new Uint8Array(await slice.arrayBuffer()), size };
  } catch {
    return null;
  }
}

const diskIo: FileViewIo = {
  git: runGit,
  realpath,
  // Never called — {@link resolveRepo} does not use it — but present because `FileViewIo` is a
  // `DiffIo` and a partial one would be a cast.
  readHead: async () => null,
  readBytes,
};

/**
 * `bytes` as text, or null when these bytes are not text this route will serve.
 *
 * TWO refusals, and they are different questions. A NUL in the head is the classic binary sniff and
 * it is cheap. The strict decode is the real check: `fatal: true` throws on any byte sequence that
 * is not valid UTF-8, so a latin-1 CSV, a JPEG and a UTF-16 file are all refused here rather than
 * arriving at the phone as a screenful of U+FFFD that looks like corruption Collie caused.
 *
 * `truncated` buys the one exception the strictness needs: a cap that lands in the middle of a
 * multi-byte character produces an incomplete sequence at the END, which is an artefact of the cut
 * and not evidence about the file. Up to three trailing bytes are dropped and the decode is retried
 * — three because that is the longest incomplete prefix a 4-byte sequence can leave.
 */
export function decodeFileText(bytes: Uint8Array, truncated: boolean): string | null {
  const head = bytes.subarray(0, BINARY_SNIFF_BYTES);
  for (const b of head) if (b === 0) return null;
  const strict = new TextDecoder("utf-8", { fatal: true });
  try {
    return strict.decode(bytes);
  } catch {
    if (!truncated) return null;
  }
  for (let drop = 1; drop <= 3; drop++) {
    if (drop >= bytes.byteLength) break;
    try {
      return strict.decode(bytes.subarray(0, bytes.byteLength - drop));
    } catch {
      // keep trimming
    }
  }
  return null;
}

/**
 * One file of the work tree the pane's cwd sits in.
 *
 * Total: every failure is a `reason`, never a throw, because the caller is an HTTP handler and a
 * path that has since been deleted is an ordinary answer rather than an exception.
 *
 * THE GRAMMAR IS FIRST, before the repo is resolved and before any string is joined — the same
 * ordering bridge/docs.ts states for its slug, and for the same reason: the rule that must never be
 * skipped is the one with nothing ahead of it that could skip it.
 */
export async function fileView(
  cwd: string,
  path: string,
  home: string,
  io: FileViewIo = diskIo,
): Promise<FileViewResult> {
  if (!isRepoRelativePath(path)) return { ok: false, reason: "bad_path" };
  const resolved = await resolveRepo(cwd, home, io);
  if (!resolved.ok) return resolved;
  const { repo } = resolved;
  const target = resolve(repo.repoRoot, path);
  // AFTER `resolve`, exactly as bridge/diff.ts's patch path does it: the lexical check above cannot
  // see a symlink, and this one cannot see a `..` — neither is redundant and neither is enough.
  if (!withinRoot(target, repo.repoRoot) || target === repo.repoRoot) {
    return { ok: false, reason: "bad_path" };
  }
  // And a THIRD time, on the real path, because every check so far has been about the string. A
  // tracked symlink pointing at `/etc/passwd` passes both of them and lands here.
  let real: string;
  try {
    real = await io.realpath(target);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!withinRoot(real, repo.repoRoot)) return { ok: false, reason: "outside_root" };

  const read = await io.readBytes(real, FILE_VIEW_CAP);
  if (read === null) return { ok: false, reason: "not_found" };
  const truncated = read.size > FILE_VIEW_CAP;
  const text = decodeFileText(read.bytes, truncated);
  if (text === null) return { ok: false, reason: "binary" };
  return { ok: true, body: { ok: true, mode: "file", path, text, bytes: read.size, truncated } };
}
