import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactStore,
  artifactKindFor,
  artifactRecordFileName,
  MAX_ARTIFACT_BYTES,
  newArtifactId,
  parseArtifactRecord,
  slugify,
} from "./artifacts.ts";
import type { AgentView } from "./types.ts";

// The artifacts library (bridge/artifacts.ts). What is pinned: the two-file layout and its write
// order, the version chain per slug, the pane stamp (resolved from a live agent's session, then
// remembered), the byte cap, and that nothing on disk that is not a record can become one.

const dirs: string[] = [];
async function freshStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-artifacts-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function agent(paneId: string, session: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "AI Live",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you",
    focused: false,
    agentSession: { kind: "id", value: session },
    ...over,
  };
}

describe("artifactKindFor", () => {
  test("maps the known extensions and falls back to an attachment", () => {
    expect(artifactKindFor("report.HTML").kind).toBe("html");
    expect(artifactKindFor("notes.md").kind).toBe("markdown");
    expect(artifactKindFor("shot.PNG")).toEqual({ kind: "image", mime: "image/png", ext: "png" });
    expect(artifactKindFor("data.csv").kind).toBe("text");
    expect(artifactKindFor("bundle.tar.gz")).toEqual({ kind: "file", mime: "application/octet-stream", ext: "gz" });
    expect(artifactKindFor("noext").ext).toBe("bin");
  });
});

describe("slugify / newArtifactId", () => {
  test("a title becomes a slug; CJK falls away; an id is stem-safe", () => {
    expect(slugify("Medium digest 09-11 (v2)")).toBe("medium-digest-09-11-v2");
    expect(slugify("規劃書")).toBe("");
    expect(newArtifactId(1_757_600_000_000, "0A1B2C3D-4e5f-6789-abcd-ef0123456789")).toMatch(/^[a-z0-9]+-0a1b2c3d$/);
  });
});

describe("ArtifactStore.add", () => {
  test("writes the bytes then the record, and the record round-trips", async () => {
    const stateDir = await freshStateDir();
    const store = new ArtifactStore(stateDir, { now: () => 1_757_600_000_000, random: () => "deadbeefcafe" });
    const added = await store.add({
      bytes: bytes("<h1>hi</h1>"),
      fileName: "report.html",
      title: "  A report  ",
      tags: ["meow", "bad tag", "x_1"],
      sourcePath: "/tmp/report.html",
      harness: "claude",
      session: { kind: "id", value: "sess-1" },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const r = added.record;
    expect(r.title).toBe("A report");
    expect(r.slug).toBe("a-report");
    expect(r.version).toBe(1);
    expect(r.kind).toBe("html");
    expect(r.tags).toEqual(["meow", "x_1"]);
    expect(r.pane).toBeNull();
    const names = (await readdir(store.dir)).toSorted();
    expect(names).toEqual([`${r.id}.html`, `${r.id}.json`]);
    expect(await readFile(join(store.dir, `${r.id}.html`), "utf8")).toBe("<h1>hi</h1>");
    const listed = await store.list();
    expect(listed).toEqual([r]);
    expect(await store.get(r.id)).toEqual(r);
    const raw = await store.readBytes(r);
    expect(raw).not.toBeNull();
    expect(new TextDecoder().decode(raw!)).toBe("<h1>hi</h1>");
  });

  test("the same slug again is the next version; a different slug starts at 1", async () => {
    const stateDir = await freshStateDir();
    let tick = 1_757_600_000_000;
    let n = 0;
    const store = new ArtifactStore(stateDir, { now: () => ++tick, random: () => `0000000${String(++n)}` });
    const a = await store.add({ bytes: bytes("a"), fileName: "plan.html", title: "Plan", slug: "plan" });
    const b = await store.add({ bytes: bytes("b"), fileName: "plan.html", title: "Plan v2", slug: "plan" });
    const c = await store.add({ bytes: bytes("c"), fileName: "other.md", title: "Other" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect([a.record.version, b.record.version, c.record.version]).toEqual([1, 2, 1]);
    expect(await store.nextVersion("plan")).toBe(3);
    // Newest first.
    expect((await store.list()).map((r) => r.id)).toEqual([c.record.id, b.record.id, a.record.id]);
  });

  test("refuses empty bytes, an oversize file and an empty title — with a reason, never a throw", async () => {
    const store = new ArtifactStore(await freshStateDir());
    expect(await store.add({ bytes: new Uint8Array(0), fileName: "x.html", title: "x" })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      await store.add({ bytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1), fileName: "x.html", title: "x" }),
    ).toEqual({ ok: false, reason: "too_large" });
    expect(await store.add({ bytes: bytes("x"), fileName: "x.html", title: "   " })).toEqual({
      ok: false,
      reason: "bad_title",
    });
    expect(await readdir(store.dir).catch(() => [])).toEqual([]);
  });
});

describe("ArtifactStore.resolvePanes", () => {
  test("stamps the pane from a live agent carrying the record's session, and remembers it", async () => {
    const stateDir = await freshStateDir();
    const store = new ArtifactStore(stateDir);
    const added = await store.add({
      bytes: bytes("x"),
      fileName: "x.md",
      title: "x",
      session: { kind: "id", value: "sess-9" },
    });
    if (!added.ok) throw new Error("add failed");
    const unresolved = await store.resolvePanes([added.record], [agent("w1:p1", "sess-other")]);
    expect(unresolved[0]!.pane).toBeNull();
    const resolved = await store.resolvePanes([added.record], [agent("w1:p2", "sess-9")]);
    expect(resolved[0]!.pane).toEqual({ paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "AI Live", agent: "claude" });
    // Persisted: a later list with NO agents still says where it came from.
    const again = await store.resolvePanes(await store.list(), []);
    expect(again[0]!.pane?.paneId).toBe("w1:p2");
    // And a record with no session is left alone.
    const orphan = await store.add({ bytes: bytes("y"), fileName: "y.md", title: "y", origin: "scheduler" });
    if (!orphan.ok) throw new Error("add failed");
    const [o] = await store.resolvePanes([orphan.record], [agent("w1:p2", "sess-9")]);
    expect(o!.pane).toBeNull();
    expect(o!.origin).toBe("scheduler");
  });
});

describe("ArtifactStore.patch / remove", () => {
  test("changes only the four mutable fields, and remove takes both files", async () => {
    const store = new ArtifactStore(await freshStateDir());
    const added = await store.add({ bytes: bytes("x"), fileName: "x.html", title: "x", tags: ["a"] });
    if (!added.ok) throw new Error("add failed");
    const id = added.record.id;
    const patched = await store.patch(id, { title: "  renamed ", pinned: true, tags: ["b", "not ok!"], kbSlug: "kb-1" });
    expect(patched).not.toBeNull();
    expect(patched!.title).toBe("renamed");
    expect(patched!.pinned).toBe(true);
    expect(patched!.tags).toEqual(["b"]);
    expect(patched!.kbSlug).toBe("kb-1");
    expect(patched!.sha256).toBe(added.record.sha256);
    // An empty title keeps the old one; a null kbSlug clears it.
    const again = await store.patch(id, { title: "", kbSlug: null });
    expect(again!.title).toBe("renamed");
    expect(again!.kbSlug).toBeNull();
    expect(await store.patch("zzzzzz-00000000", { pinned: true })).toBeNull();
    expect(await store.remove(id)).toBe(true);
    expect(await store.remove(id)).toBe(false);
    expect(await readdir(store.dir)).toEqual([]);
  });
});

describe("what is not a record", () => {
  test("a torn, foreign or renamed json in the directory is skipped, never fatal", async () => {
    const stateDir = await freshStateDir();
    const store = new ArtifactStore(stateDir);
    const added = await store.add({ bytes: bytes("x"), fileName: "x.html", title: "x" });
    if (!added.ok) throw new Error("add failed");
    await writeFile(join(store.dir, "torn-00000000.json"), "{ not json", "utf8");
    await writeFile(join(store.dir, "foreign-00000000.json"), JSON.stringify({ hello: "world" }), "utf8");
    // A record whose file name disagrees with its id is not trusted either.
    await writeFile(
      join(store.dir, artifactRecordFileName("moved0-00000000")),
      await readFile(join(store.dir, artifactRecordFileName(added.record.id)), "utf8"),
      "utf8",
    );
    expect((await store.list()).map((r) => r.id)).toEqual([added.record.id]);
    expect(await store.get("moved0-00000000")).toBeNull();
    expect(await store.get("../etc/passwd")).toBeNull();
  });

  test("parseArtifactRecord narrows every field", () => {
    expect(parseArtifactRecord(null)).toBeNull();
    expect(parseArtifactRecord({ schemaVersion: 2 })).toBeNull();
    const ok = parseArtifactRecord({
      schemaVersion: 1,
      id: "abc123-0123abcd",
      slug: "s",
      version: 2.7,
      title: "t",
      kind: "html",
      ext: "html",
      mime: "text/html",
      size: 3,
      sha256: "00",
      createdMs: 5,
      tags: ["ok", "no way", 7],
      pinned: "yes",
      session: { kind: "id", value: "s1" },
      pane: { paneId: "w1:p1", workspaceId: "w1" },
    });
    expect(ok).not.toBeNull();
    expect(ok!.version).toBe(2);
    expect(ok!.tags).toEqual(["ok"]);
    expect(ok!.pinned).toBe(false);
    expect(ok!.session).toEqual({ kind: "id", value: "s1" });
    expect(ok!.pane).toEqual({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "", agent: "" });
    expect(
      parseArtifactRecord({ schemaVersion: 1, id: "not an id", slug: "s", title: "t", kind: "html", ext: "html", mime: "m", size: 1, sha256: "0", createdMs: 1 }),
    ).toBeNull();
  });
});
