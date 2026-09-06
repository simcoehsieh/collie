import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { DIR_ENTRY_CAP, expandHome, listDirs, withinRoot, type DirsIo } from "./dirs.ts";

// The folder picker's read. Driven against a REAL temporary tree rather than a fake io, and that is
// deliberate: the whole rule this module carries is "resolve first, compare second", and a fake
// filesystem is exactly the thing that cannot tell you whether a symlink or a `..` really resolved
// the way the check assumes. The pure helpers are unit-tested beside it.

describe("expandHome", () => {
  const home = "/home/op";

  test("empty and bare ~ are the home directory", () => {
    expect(expandHome("", home)).toBe(home);
    expect(expandHome("   ", home)).toBe(home);
    expect(expandHome("~", home)).toBe(home);
  });

  test("~/x is relative to home, and a bare relative path is too", () => {
    expect(expandHome("~/git/collie", home)).toBe("/home/op/git/collie");
    expect(expandHome("git/collie", home)).toBe("/home/op/git/collie");
  });

  test("an absolute path is kept, normalised", () => {
    expect(expandHome("/var/log/../tmp", home)).toBe("/var/tmp");
  });

  test("it does NOT enforce containment — that is the resolved check's job", () => {
    // Stated as a test because the temptation is to "harden" this function, which would leave two
    // containment rules, the weaker of which runs first and can be fooled by a symlink.
    expect(expandHome("~/../../etc", home)).toBe("/etc");
  });
});

describe("withinRoot", () => {
  test("the root itself is inside it", () => {
    expect(withinRoot("/home/op", "/home/op")).toBe(true);
  });

  test("a descendant is inside it", () => {
    expect(withinRoot("/home/op/git/collie", "/home/op")).toBe(true);
  });

  test("a SIBLING SHARING THE NAME'S PREFIX is not", () => {
    // The reason the separator is appended. `/home/simone` starts with `/home/simon`.
    expect(withinRoot("/home/opal", "/home/op")).toBe(false);
  });

  test("an ancestor and an unrelated path are not", () => {
    expect(withinRoot("/home", "/home/op")).toBe(false);
    expect(withinRoot("/etc", "/home/op")).toBe(false);
  });
});

describe("listDirs", () => {
  let root = "";
  let outside = "";

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "collie-dirs-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "collie-outside-")));
    await mkdir(join(root, "git", "collie"), { recursive: true });
    await mkdir(join(root, "git", "ai-stock"), { recursive: true });
    await mkdir(join(root, ".config"), { recursive: true });
    await writeFile(join(root, "git", "notes.md"), "not a directory");
    await mkdir(join(outside, "secrets"), { recursive: true });
    await symlink(join(outside, "secrets"), join(root, "git", "escape"));
    await symlink(join(root, "git", "collie"), join(root, "git", "linked"));
    await symlink(join(root, "git", "nowhere"), join(root, "git", "dangling"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("lists directories only — no files, no dotfiles", async () => {
    const res = await listDirs("~/git", root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const names = res.body.entries.map((e) => e.name);
    expect(names).toContain("collie");
    expect(names).toContain("ai-stock");
    expect(names).not.toContain("notes.md");

    const top = await listDirs("", root);
    expect(top.ok).toBe(true);
    if (!top.ok) return;
    expect(top.body.entries.map((e) => e.name)).not.toContain(".config");
  });

  test("a dotted directory is reachable by NAME even though it is not listed", async () => {
    // The omission is tidiness, not a boundary — and a boundary is what someone will assume it is
    // unless this says otherwise.
    const res = await listDirs("~/.config", root);
    expect(res.ok).toBe(true);
  });

  test("follows a symlink that lands inside the root", async () => {
    const res = await listDirs("~/git", root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.entries.map((e) => e.name)).toContain("linked");
  });

  test("DROPS a symlink that lands outside it, and refuses to be walked through one", async () => {
    // Both halves matter: hiding the row is not the boundary, refusing the read is.
    const listing = await listDirs("~/git", root);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.body.entries.map((e) => e.name)).not.toContain("escape");

    const walked = await listDirs(join(root, "git", "escape"), root);
    expect(walked).toEqual({ ok: false, reason: "outside_root" });
  });

  test("drops a dangling symlink without dropping the directory", async () => {
    const res = await listDirs("~/git", root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.entries.map((e) => e.name)).not.toContain("dangling");
    expect(res.body.entries.length).toBeGreaterThan(0);
  });

  test("refuses to escape with `..`, however it is spelled", async () => {
    expect(await listDirs("~/../..", root)).toEqual({ ok: false, reason: "outside_root" });
    expect(await listDirs("/etc", root)).toEqual({ ok: false, reason: "outside_root" });
    expect(await listDirs(join(root, "git", "..", "..", ""), root)).toEqual({
      ok: false,
      reason: "outside_root",
    });
  });

  test("a file is 'not a directory' and a missing path is 'not found'", async () => {
    expect(await listDirs("~/git/notes.md", root)).toEqual({ ok: false, reason: "not_a_directory" });
    expect(await listDirs("~/git/nope", root)).toEqual({ ok: false, reason: "not_found" });
  });

  test("parent is null at the root and the directory above otherwise", async () => {
    const top = await listDirs("", root);
    expect(top.ok && top.body.parent).toBeNull();
    const inner = await listDirs("~/git/collie", root);
    expect(inner.ok && inner.body.parent).toBe(join(root, "git"));
  });

  test("reports the RESOLVED path, not the one asked for", async () => {
    const res = await listDirs("~/git/linked", root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.path).toBe(join(root, "git", "collie"));
  });

  test("caps a huge directory and says that it did", async () => {
    const many = join(root, "many");
    await mkdir(many, { recursive: true });
    await Promise.all(
      Array.from({ length: DIR_ENTRY_CAP + 5 }, (_, i) =>
        mkdir(join(many, `d${String(i).padStart(4, "0")}`), { recursive: true }),
      ),
    );
    const res = await listDirs("~/many", root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.entries.length).toBe(DIR_ENTRY_CAP);
    expect(res.body.truncated).toBe(true);
    await rm(many, { recursive: true, force: true });
  });

  test("home is reported resolved, so the client can shorten a path against it", async () => {
    const res = await listDirs("~/git", root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.home).toBe(root);
    expect(res.body.path.startsWith(root + sep)).toBe(true);
  });
});

// ── A STALLED ENTRY COSTS ITS OWN ROW AND NOTHING ELSE ──────────────────────────────────────────
// The defect this bounds is not hypothetical and not exotic: the operator's own `~` never answered,
// because one symlink in it resolves into a cloud FileProvider mount the bridge has no permission
// for, and `fs.promises` has no cancellation. `~/git` answered in 3ms the whole time. These drive
// the injected io, which is the only way to hold a filesystem call open on purpose.

/** An io whose calls answer normally except for the named path, which never settles. */
function stallingIo(stallOn: string, tree: Record<string, string[]>): DirsIo {
  const never = new Promise<never>(() => {});
  const dirent = (name: string, kind: "dir" | "link") => ({
    name,
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
  });
  return {
    realpath: async (p) => (p === stallOn ? never : p),
    stat: async (p) => (p === stallOn ? never : { isDirectory: () => true }),
    readdir: async (p) =>
      (tree[p] ?? []).map((r) => (r.startsWith("@") ? dirent(r.slice(1), "link") : dirent(r, "dir"))),
  };
}

describe("listDirs — deadlines", () => {
  test("a symlink that never resolves is DROPPED, and the rest of the listing still answers", async () => {
    const io = stallingIo("/home/op/cloud", { "/home/op": ["git", "@cloud", "src"] });
    const started = Date.now();
    const res = await listDirs("", "/home/op", io);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.entries.map((e) => e.name)).toEqual(["git", "src"]);
    // And it answered — the whole point. Bounded by the per-entry budget, not by Bun's idle timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("two stalled links cost ONE deadline, not two — they are resolved in parallel", async () => {
    const io = stallingIo("/home/op/a", { "/home/op": ["@a", "@b", "keep"] });
    // `stallOn` is one path, so `b` resolves; the claim is about the wall clock either way, and a
    // serial implementation of three entries would spend three budgets on the stalled one alone.
    const started = Date.now();
    const res = await listDirs("", "/home/op", io);
    expect(res.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("a directory whose READ never returns fails the listing instead of hanging", async () => {
    const io: DirsIo = {
      realpath: async (p) => p,
      stat: async () => ({ isDirectory: () => true }),
      readdir: () => new Promise<never>(() => {}),
    };
    const started = Date.now();
    expect(await listDirs("", "/home/op", io)).toEqual({ ok: false, reason: "not_found" });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
