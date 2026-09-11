import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "../bridge/artifacts.ts";
import {
  artifactPhoneUrl,
  cmdArtifactAdd,
  cmdArtifactList,
  cmdArtifactPromote,
  parseArtifactAddArgs,
  parseArtifactPromoteArgs,
} from "./artifact.ts";
import { capture, context, fakeExec } from "./fakes.ts";
import { EXIT } from "./io.ts";

// `collie artifact add` / `list` (cli/artifact.ts). The verb is a thin door onto bridge/artifacts.ts,
// so what is pinned here is the door: the flag grammar, which pane it says it is from (the beacon's
// environment read, and its refusal for a subagent), the byte cap's refusal text, and the two lines
// an agent reads back.

const dirs: string[] = [];
async function freshStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-artifact-cli-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const SESSION = "0f9b1e3c-0000-4000-8000-00000000abcd";

function files(seed: Record<string, string>, cwd = "/work") {
  return {
    readBytes: (p: string) => (p in seed ? new TextEncoder().encode(seed[p]!) : null),
    cwd: () => cwd,
  };
}

describe("parseArtifactAddArgs", () => {
  test("one positional, flags in both spellings, repeatable --tag", () => {
    expect(parseArtifactAddArgs(["out.html", "--title", "A plan", "--tag=meow", "--tag", "ui", "--slug", "plan-v1"])).toEqual({
      file: "out.html",
      title: "A plan",
      slug: "plan-v1",
      tags: ["meow", "ui"],
      origin: null,
    });
  });

  test("refuses two files, a valueless flag, a bad slug and an unknown flag — each in a sentence", () => {
    expect(parseArtifactAddArgs(["a.html", "b.html"])).toEqual({ error: 'one file at a time (got "a.html" and "b.html")' });
    expect(parseArtifactAddArgs(["a.html", "--title"])).toEqual({ error: "--title needs a value" });
    expect(parseArtifactAddArgs(["a.html", "--slug", "Not A Slug"])).toMatchObject({ error: expect.stringContaining("--slug must match") });
    expect(parseArtifactAddArgs(["a.html", "--wat", "x"])).toEqual({ error: "unknown flag --wat" });
    expect(parseArtifactAddArgs([])).toEqual({ error: "which file? `collie artifact add <file>`" });
  });
});

describe("cmdArtifactAdd", () => {
  test("registers the file under this agent's session and prints the id and the phone's address", async () => {
    const stateDir = await freshStateDir();
    const io = capture();
    const ctx = context({ CLAUDE_CODE_SESSION_ID: SESSION, COLLIE_PUBLIC_HOSTS: "meow.example.dev,other" }, { stateDir });
    const store = new ArtifactStore(stateDir, { now: () => 1_757_600_000_000, random: () => "abcdef01" });
    const code = await cmdArtifactAdd(
      { ctx, io, files: files({ "/work/out/report.html": "<p>hi</p>" }), store },
      ["out/report.html", "--title", "Q3 report", "--tag", "finance"],
    );
    expect(code).toBe(EXIT.OK);
    const [record] = await store.list();
    expect(record).toMatchObject({
      title: "Q3 report",
      slug: "q3-report",
      kind: "html",
      tags: ["finance"],
      harness: "claude",
      session: { kind: "id", value: SESSION },
      sourcePath: "/work/out/report.html",
      pane: null,
    });
    expect(io.stdout[0]).toBe(`artifact ${record!.id} · v1 · html · 9 B · "Q3 report"`);
    expect(io.stdout[1]).toBe(`open on the phone: https://meow.example.dev/artifacts/${record!.id}`);
    expect(io.stderr).toEqual([]);
    expect((await readdir(join(stateDir, "artifacts"))).length).toBe(2);
  });

  test("the child-session marker is read through: the id lands, and the bridge decides the pane", async () => {
    const stateDir = await freshStateDir();
    const io = capture();
    const ctx = context({ CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CODE_CHILD_SESSION: "1" }, { stateDir });
    const store = new ArtifactStore(stateDir);
    expect(await cmdArtifactAdd({ ctx, io, files: files({ "/work/a.md": "# a" }), store }, ["a.md"])).toBe(EXIT.OK);
    expect(io.stderr).toEqual([]);
    const [first] = await store.list();
    expect(first!.session).toEqual({ kind: "id", value: SESSION });
    expect(first!.title).toBe("a");
  });

  test("no session at all is said out loud, unless --origin says where the file came from", async () => {
    const stateDir = await freshStateDir();
    const ctx = context({}, { stateDir });
    const store = new ArtifactStore(stateDir);
    const io = capture();
    expect(await cmdArtifactAdd({ ctx, io, files: files({ "/work/a.md": "# a" }), store }, ["a.md"])).toBe(EXIT.OK);
    expect(io.stderr[0]).toContain("no agent session in this environment");
    const io2 = capture();
    expect(
      await cmdArtifactAdd({ ctx, io: io2, files: files({ "/work/b.md": "# b" }), store }, ["b.md", "--origin", "scheduler"]),
    ).toBe(EXIT.OK);
    expect(io2.stderr).toEqual([]);
    expect((await store.list()).find((r) => r.title === "b")!.origin).toBe("scheduler");
  });

  test("a missing file fails, an oversize file is refused with the cap in the sentence", async () => {
    const stateDir = await freshStateDir();
    const ctx = context({}, { stateDir });
    const io = capture();
    expect(await cmdArtifactAdd({ ctx, io, files: files({}) }, ["nope.html"])).toBe(EXIT.FAIL);
    expect(io.stderr[0]).toBe("cannot read /work/nope.html");
    const big = { readBytes: () => new Uint8Array(5 * 1024 * 1024 + 1), cwd: () => "/work" };
    const io2 = capture();
    expect(await cmdArtifactAdd({ ctx, io: io2, files: big }, ["big.html"])).toBe(EXIT.REFUSED);
    expect(io2.stderr[0]).toContain("5.00 MB");
    expect(await readdir(join(stateDir, "artifacts")).catch(() => [])).toEqual([]);
  });
});

describe("cmdArtifactList", () => {
  test("prints the library newest first, honours --limit, and says when it is empty", async () => {
    const stateDir = await freshStateDir();
    const ctx = context({}, { stateDir });
    let tick = 1_757_600_000_000;
    let n = 0;
    const store = new ArtifactStore(stateDir, { now: () => ++tick, random: () => `0000000${String(++n)}` });
    const empty = capture();
    expect(await cmdArtifactList({ ctx, io: empty, files: files({}), store }, [])).toBe(EXIT.OK);
    expect(empty.stdout[0]).toContain("the library is empty");
    await store.add({ bytes: new TextEncoder().encode("a"), fileName: "a.html", title: "First", origin: "scheduler" });
    await store.add({ bytes: new TextEncoder().encode("b"), fileName: "b.md", title: "Second" });
    const io = capture();
    expect(await cmdArtifactList({ ctx, io, files: files({}), store }, ["--limit", "1"])).toBe(EXIT.OK);
    expect(io.stdout[0]).toContain("Second");
    expect(io.stdout[0]).toContain("[—]");
    expect(io.stdout[1]).toBe("… 1 more (--limit 2)");
    const bad = capture();
    expect(await cmdArtifactList({ ctx, io: bad, files: files({}), store }, ["--limit", "x"])).toBe(EXIT.USAGE);
  });
});

describe("artifactPhoneUrl", () => {
  test("falls back to loopback when the deployment has no public host", () => {
    expect(artifactPhoneUrl(context({}), "a-0")).toBe("http://127.0.0.1:8787/artifacts/a-0");
  });
});

describe("cmdArtifactPromote", () => {
  test("pushes then promotes through the kb CLI, and writes the kb slug back", async () => {
    const stateDir = await freshStateDir();
    const ctx = context({ COLLIE_KB_CLI: "/opt/kb", COLLIE_KB_PUBLIC_ORIGIN: "https://kb.example/" }, { stateDir });
    const store = new ArtifactStore(stateDir);
    const added = await store.add({ bytes: new TextEncoder().encode("<p>x</p>"), fileName: "plan.html", title: "The plan", slug: "the-plan" });
    if (!added.ok) throw new Error("add failed");
    const exec = fakeExec({ answers: [["/opt/kb push", { code: 0, stdout: "ok" }], ["/opt/kb promote", { code: 0, stdout: "ok" }]] });
    const io = capture();
    const code = await cmdArtifactPromote(
      { ctx, io, files: files({}), store, exec },
      [added.record.id, "--folder", "ai", "--summary", "A plan.", "--tag", "meow", "--tag", "ai_ops"],
    );
    expect(code).toBe(EXIT.OK);
    expect(exec.calls).toEqual([
      `/opt/kb push ${store.filePath(added.record)} --folder ai --slug the-plan --title The plan`,
      "/opt/kb promote the-plan --summary A plan. --tag meow --tag ai_ops",
    ]);
    expect(io.stdout).toEqual([`promoted ${added.record.id} → https://kb.example/d/the-plan`]);
    expect((await store.get(added.record.id))!.kbSlug).toBe("the-plan");
  });

  test("refuses a non-HTML artifact, a missing --folder, a hyphenated tag, and reports a failed push", async () => {
    const stateDir = await freshStateDir();
    const ctx = context({}, { stateDir });
    const store = new ArtifactStore(stateDir);
    const md = await store.add({ bytes: new TextEncoder().encode("# x"), fileName: "x.md", title: "x" });
    const html = await store.add({ bytes: new TextEncoder().encode("<p>"), fileName: "y.html", title: "y" });
    if (!md.ok || !html.ok) throw new Error("add failed");
    const io = capture();
    expect(await cmdArtifactPromote({ ctx, io, files: files({}), store, exec: fakeExec() }, [md.record.id])).toBe(EXIT.USAGE);
    expect(io.stderr[0]).toContain("--folder is required");
    expect(parseArtifactPromoteArgs(["x", "--tag", "not-ok"])).toMatchObject({ error: expect.stringContaining("[a-z0-9_]") });
    const io2 = capture();
    expect(await cmdArtifactPromote({ ctx, io: io2, files: files({}), store, exec: fakeExec() }, [md.record.id, "--folder", "ai"])).toBe(EXIT.REFUSED);
    expect(io2.stderr[0]).toContain("takes HTML");
    const io3 = capture();
    const failing = fakeExec({
      answers: [[`${ctx.home}/git/side-projects/knowledge-system/bin/kb push`, { code: 1, stderr: "401 unauthorised" }]],
    });
    expect(await cmdArtifactPromote({ ctx, io: io3, files: files({}), store, exec: failing }, [html.record.id, "--folder", "ai"])).toBe(EXIT.FAIL);
    expect(io3.stderr[0]).toContain("kb push failed (1): 401 unauthorised");
    expect((await store.get(html.record.id))!.kbSlug).toBeNull();
  });
});

