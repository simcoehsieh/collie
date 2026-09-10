import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIFF_FILE_CAP,
  classifyStatus,
  diffPatch,
  diffStat,
  isRepoRelativePath,
  parseNumstat,
  parsePorcelain,
  runGit,
  type DiffIo,
  type GitRun,
} from "./diff.ts";

// The parsers are exercised against recorded git output; the two entry points are exercised twice —
// against a fake `DiffIo` for the rules (the jail, the caps, the refusals), and against a REAL
// temporary repo for the one thing a fake cannot prove, which is that the argv this module builds
// is what git actually accepts.

describe("classifyStatus", () => {
  test("untracked, staged, unstaged, both, unmerged", () => {
    expect(classifyStatus("??")).toEqual({ status: "?", staged: false });
    expect(classifyStatus("M ")).toEqual({ status: "M", staged: true });
    expect(classifyStatus(" M")).toEqual({ status: "M", staged: false });
    expect(classifyStatus("MM")).toEqual({ status: "M", staged: true });
    expect(classifyStatus("A ")).toEqual({ status: "A", staged: true });
    expect(classifyStatus(" D")).toEqual({ status: "D", staged: false });
    expect(classifyStatus("UU")).toEqual({ status: "U", staged: false });
    expect(classifyStatus("AA")).toEqual({ status: "U", staged: false });
  });
});

describe("parsePorcelain", () => {
  test("plain rows, and a rename carrying its old path in the next record", () => {
    const out = " M a.ts\u0000?? new.txt\u0000R  new-name.ts\u0000old-name.ts\u0000";
    expect(parsePorcelain(out)).toEqual([
      { xy: " M", path: "a.ts" },
      { xy: "??", path: "new.txt" },
      { xy: "R ", path: "new-name.ts", from: "old-name.ts" },
    ]);
  });

  test("empty output is no rows", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});

describe("parseNumstat", () => {
  test("counts, a binary, and a rename's three records", () => {
    const out = "3\t1\ta.ts\u0000-\t-\tlogo.png\u00005\t0\t\u0000old.ts\u0000new.ts\u0000";
    const counts = parseNumstat(out);
    expect(counts.get("a.ts")).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(counts.get("logo.png")).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(counts.get("new.ts")).toEqual({ additions: 5, deletions: 0, binary: false });
    expect(counts.has("old.ts")).toBe(false);
  });
});

describe("isRepoRelativePath", () => {
  test("refuses what git would be handed by a hostile client", () => {
    expect(isRepoRelativePath("")).toBe(false);
    expect(isRepoRelativePath("/etc/passwd")).toBe(false);
    expect(isRepoRelativePath("../secrets")).toBe(false);
    expect(isRepoRelativePath("a/../../b")).toBe(false);
    expect(isRepoRelativePath("--output=x")).toBe(false);
    expect(isRepoRelativePath(".git/config")).toBe(false);
    expect(isRepoRelativePath("a\u0000b")).toBe(false);
  });

  test("accepts an ordinary repo path, dots in names included", () => {
    expect(isRepoRelativePath("web/src/a.test.ts")).toBe(true);
    expect(isRepoRelativePath(".gitignore")).toBe(true);
    expect(isRepoRelativePath("dir.with.dots/file")).toBe(true);
  });
});

// ── The rules, against a fake io ─────────────────────────────────────────────────────────────────

function fakeIo(answers: Record<string, GitRun>, paths: Record<string, string> = {}): DiffIo & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    git: async (args) => {
      calls.push([...args]);
      const key = args.join(" ");
      return (
        answers[key] ??
        Object.entries(answers).find(([k]) => key.startsWith(k))?.[1] ??
        ({ code: 128, stdout: "", truncated: false } satisfies GitRun)
      );
    },
    realpath: async (p) => {
      const mapped = paths[p];
      if (mapped === undefined) throw new Error(`ENOENT ${p}`);
      return mapped;
    },
    readHead: async () => ({ text: "one\ntwo\nthree", truncated: false }),
  };
}

const HOME = "/home/op";
const REPO = "/home/op/git/proj";
const OK_TOP: GitRun = { code: 0, stdout: `${REPO}\nmain\n`, truncated: false };

describe("diffStat rules", () => {
  test("a cwd outside home is refused before git is asked anything", async () => {
    const io = fakeIo({}, { [HOME]: HOME, "/tmp/x": "/tmp/x" });
    const res = await diffStat("/tmp/x", HOME, io);
    expect(res).toEqual({ ok: false, reason: "outside_root" });
    expect(io.calls).toEqual([]);
  });

  test("a cwd that does not resolve is not_found", async () => {
    const io = fakeIo({}, { [HOME]: HOME });
    expect(await diffStat("/home/op/gone", HOME, io)).toEqual({ ok: false, reason: "not_found" });
  });

  test("not a repo when rev-parse fails", async () => {
    const io = fakeIo({ "rev-parse": { code: 128, stdout: "", truncated: false } }, { [HOME]: HOME, [REPO]: REPO });
    expect(await diffStat(REPO, HOME, io)).toEqual({ ok: false, reason: "not_a_repo" });
  });

  test("a repo root that resolves OUTSIDE home is refused even when the cwd is inside", async () => {
    const io = fakeIo(
      { "rev-parse": { code: 0, stdout: "/srv/elsewhere\nmain\n", truncated: false } },
      { [HOME]: HOME, [REPO]: REPO, "/srv/elsewhere": "/srv/elsewhere" },
    );
    expect(await diffStat(REPO, HOME, io)).toEqual({ ok: false, reason: "outside_root" });
  });

  test("the file list joins status rows to numstat counts, and counts an untracked file off disk", async () => {
    const io = fakeIo(
      {
        "rev-parse": OK_TOP,
        "status --porcelain=v1 -z --untracked-files=all --": {
          code: 0,
          stdout: " M a.ts\u0000A  b.ts\u0000?? c.txt\u0000-\t-\tx\u0000".replace("-\t-\tx\u0000", ""),
          truncated: false,
        },
        "diff --numstat -z HEAD --": { code: 0, stdout: "3\t1\ta.ts\u00009\t0\tb.ts\u0000", truncated: false },
      },
      { [HOME]: HOME, [REPO]: REPO },
    );
    const res = await diffStat(REPO, HOME, io);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.branch).toBe("main");
    expect(res.body.repoRoot).toBe(REPO);
    expect(res.body.files).toEqual([
      { path: "a.ts", status: "M", staged: false, additions: 3, deletions: 1, binary: false },
      { path: "b.ts", status: "A", staged: true, additions: 9, deletions: 0, binary: false },
      { path: "c.txt", status: "?", staged: false, additions: 3, deletions: 0, binary: false },
    ]);
    expect(res.body.truncated).toBe(false);
    // Every git call carried `--` (or is rev-parse), and every one ran in the repo root.
    for (const call of io.calls) {
      expect(call[0] === "rev-parse" || call.includes("--")).toBe(true);
    }
  });

  test("an unborn HEAD falls back to the cached numstat", async () => {
    const io = fakeIo(
      {
        "rev-parse": OK_TOP,
        "status": { code: 0, stdout: "A  first.ts\u0000", truncated: false },
        "diff --numstat -z HEAD --": { code: 128, stdout: "", truncated: false },
        "diff --numstat -z --cached --": { code: 0, stdout: "12\t0\tfirst.ts\u0000", truncated: false },
      },
      { [HOME]: HOME, [REPO]: REPO },
    );
    const res = await diffStat(REPO, HOME, io);
    expect(res.ok && res.body.files[0]?.additions).toBe(12);
  });

  test("the list is cut at the cap and says so", async () => {
    const rows = Array.from({ length: DIFF_FILE_CAP + 5 }, (_, i) => `?? f${i}.txt\u0000`).join("");
    const io = fakeIo(
      { "rev-parse": OK_TOP, status: { code: 0, stdout: rows, truncated: false }, diff: { code: 0, stdout: "", truncated: false } },
      { [HOME]: HOME, [REPO]: REPO },
    );
    const res = await diffStat(REPO, HOME, io);
    expect(res.ok && res.body.files.length).toBe(DIFF_FILE_CAP);
    expect(res.ok && res.body.truncated).toBe(true);
  });

  test("a git call cut by the deadline is reported as truncated, not as a failure", async () => {
    const io = fakeIo(
      {
        "rev-parse": OK_TOP,
        status: { code: null, stdout: " M a.ts\u0000", truncated: true },
        diff: { code: 0, stdout: "", truncated: false },
      },
      { [HOME]: HOME, [REPO]: REPO },
    );
    const res = await diffStat(REPO, HOME, io);
    expect(res.ok && res.body.truncated).toBe(true);
    expect(res.ok && res.body.files.length).toBe(1);
  });
});

describe("diffPatch rules", () => {
  test("a bad path never reaches git", async () => {
    const io = fakeIo({}, { [HOME]: HOME, [REPO]: REPO });
    expect(await diffPatch(REPO, "../x", HOME, io)).toEqual({ ok: false, reason: "bad_path" });
    expect(await diffPatch(REPO, "/etc/passwd", HOME, io)).toEqual({ ok: false, reason: "bad_path" });
    expect(await diffPatch(REPO, ".git/config", HOME, io)).toEqual({ ok: false, reason: "bad_path" });
    expect(io.calls).toEqual([]);
  });

  test("a path git does not list as changed is not_found", async () => {
    const io = fakeIo(
      { "rev-parse": OK_TOP, status: { code: 0, stdout: "", truncated: false } },
      { [HOME]: HOME, [REPO]: REPO },
    );
    expect(await diffPatch(REPO, "clean.ts", HOME, io)).toEqual({ ok: false, reason: "not_found" });
  });

  test("a tracked change is diffed against HEAD with the path behind `--`", async () => {
    const io = fakeIo(
      {
        "rev-parse": OK_TOP,
        status: { code: 0, stdout: " M a.ts\u0000", truncated: false },
        "diff HEAD -- a.ts": { code: 0, stdout: "diff --git a/a.ts b/a.ts\n-x\n+y\n", truncated: false },
      },
      { [HOME]: HOME, [REPO]: REPO },
    );
    const res = await diffPatch(REPO, "a.ts", HOME, io);
    expect(res).toEqual({
      ok: true,
      body: { ok: true, mode: "patch", path: "a.ts", patch: "diff --git a/a.ts b/a.ts\n-x\n+y\n", truncated: false },
    });
    expect(io.calls.at(-1)).toEqual(["diff", "HEAD", "--", "a.ts"]);
  });

  test("an untracked file is diffed against /dev/null, and git's exit 1 there is success", async () => {
    const io = fakeIo(
      {
        "rev-parse": OK_TOP,
        status: { code: 0, stdout: "?? n.txt\u0000", truncated: false },
        "diff --no-index -- /dev/null n.txt": { code: 1, stdout: "+++ b/n.txt\n+hello\n", truncated: false },
      },
      { [HOME]: HOME, [REPO]: REPO },
    );
    const res = await diffPatch(REPO, "n.txt", HOME, io);
    expect(res.ok && res.body.patch).toContain("+hello");
  });
});

// ── The argv, against a real repo ────────────────────────────────────────────────────────────────

describe("against a real repository", () => {
  let root = "";
  let home = "";
  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "collie-diff-")));
    root = join(home, "proj");
    await mkdir(root);
    const git = (...args: string[]) => runGit(args, root);
    expect((await git("init", "-q", "-b", "main")).code).toBe(0);
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await writeFile(join(root, "a.txt"), "one\ntwo\n");
    await git("add", "a.txt");
    expect((await git("commit", "-q", "-m", "first")).code).toBe(0);
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n");
    await writeFile(join(root, "new.txt"), "fresh\n");
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("stat lists the modified and the untracked file with real counts", async () => {
    const res = await diffStat(root, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.branch).toBe("main");
    expect(res.body.files).toEqual([
      { path: "a.txt", status: "M", staged: false, additions: 1, deletions: 0, binary: false },
      { path: "new.txt", status: "?", staged: false, additions: 1, deletions: 0, binary: false },
    ]);
  });

  test("patch for a tracked file and for an untracked one", async () => {
    const tracked = await diffPatch(root, "a.txt", home);
    expect(tracked.ok && tracked.body.patch).toContain("+three");
    const fresh = await diffPatch(root, "new.txt", home);
    expect(fresh.ok && fresh.body.patch).toContain("+fresh");
  });

  test("a cwd that is a subdirectory answers for the repo above it", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    const res = await diffStat(join(root, "sub"), home);
    expect(res.ok && res.body.repoRoot).toBe(root);
    expect(res.ok && res.body.cwd).toBe(join(root, "sub"));
  });

  test("a directory that is not a repo is refused as one", async () => {
    const plain = join(home, "plain");
    await mkdir(plain);
    expect(await diffStat(plain, home)).toEqual({ ok: false, reason: "not_a_repo" });
  });
});
