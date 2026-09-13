import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import type { AgentSessionRef } from "./journal/types.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "./stt/json.ts";
import type { AgentView } from "./types.ts";

// FORK — ARTIFACTS: the things an agent MADE, kept beside the conversation that made them.
//
// An agent finishes a report and says "I wrote it to ~/work/report.html". On a phone that sentence
// is a dead end, and the file it names is one `git checkout` or one overwrite away from gone.
// bridge/preview.ts opens the file while it is there; the knowledge base keeps it forever but knows
// nothing of the pane it came from. This module is the middle: a COPY of the bytes, taken the moment
// the agent registered them, filed under the pane and the session that produced them, and served
// back to the phone from Collie's own origin — the same argument bridge/preview.ts makes, one step
// further down the line.
//
// ── ONE FILE PER ARTIFACT, AND THE CLI WRITES IT ────────────────────────────────────────────────
// The agent's side is `collie artifact add` (cli/artifact.ts), and it writes straight into this
// directory rather than calling the bridge over HTTP — the beacon's argument (bridge/beacon/): the
// CLI runs as the operator on the operator's machine, the state dir is already its channel, and an
// HTTP write would need a device credential the agent has no business holding. Two files per
// artifact: `<id>.<ext>` (the bytes, verbatim) and `<id>.json` (the record), the record written
// LAST so a reader never sees a record whose bytes are still landing. There is no shared index to
// tear: listing IS the directory, and a torn or foreign `.json` simply parses to null and is skipped.
//
// ── WHICH PANE, RESOLVED HERE AND THEN REMEMBERED ───────────────────────────────────────────────
// The CLI knows its harness session id (`CLAUDE_CODE_SESSION_ID`, read exactly as `beacon status`
// reads it) and nothing about panes. The bridge knows both: the snapshot's agents carry the
// session the beacon hook reported (`AgentView.agentSession`). So a record lands with a `session`
// and no `pane`, and the first list that sees a live agent with that session STAMPS the pane into
// the record and writes it back — after which the pane can close, the multiplexer can renumber, and
// the artifact still says where it came from. A record that never meets its agent (a subagent's
// session, a scheduler job with no pane) keeps `pane: null` and lives in the library only.
//
// ── SAME POLICY AS THE OTHER TWO DOCUMENT SURFACES ─────────────────────────────────────────────
// The raw route serves HTML under bridge/docs.ts's DOCUMENT_CSP — the object, not a copy — and the
// frame gets `sandbox=""`, exactly as preview and the kb panel do. The byte cap is the kb's 5 MiB.
// The id is minted by the writer and pattern-checked by every reader, so no client-supplied string
// ever becomes a path.

export const ARTIFACTS_SUBDIR = "artifacts";
export const ARTIFACT_SCHEMA_VERSION = 1;
/** The byte cap, the kb's number (bridge/docs.ts) — one limit for every document surface. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACT_TITLE_CHARS = 200;
export const MAX_ARTIFACT_TAGS = 12;

/** `<base36 ms>-<8 hex>`: sortable by birth, unguessable enough, and a safe file-name stem. */
export const ARTIFACT_ID = /^[a-z0-9]{1,12}-[a-f0-9]{8}$/;
export const ARTIFACT_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const ARTIFACT_TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type ArtifactKind = "html" | "markdown" | "image" | "text" | "file";

/** The pane an artifact was stamped with once its session met a live agent (see the header). */
export interface ArtifactPane {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly agent: string;
}

export interface ArtifactRecord {
  readonly schemaVersion: number;
  readonly id: string;
  /** Groups versions: registering the same slug again is a new version of the same artifact. */
  readonly slug: string;
  readonly version: number;
  readonly title: string;
  readonly kind: ArtifactKind;
  /** The bytes' extension, no dot — the file is `<id>.<ext>`. */
  readonly ext: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  /** Where the agent said the bytes came from, for the operator's eye only. Never re-read. */
  readonly sourcePath: string | null;
  readonly createdMs: number;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  /** The kb slug once the artifact was promoted (Phase 3), else null. */
  readonly kbSlug: string | null;
  /** The harness that registered it, from the CLI's environment read. */
  readonly harness: string | null;
  readonly session: AgentSessionRef | null;
  /** A free label for an artifact that has no pane by design ("scheduler"), else null. */
  readonly origin: string | null;
  readonly pane: ArtifactPane | null;
}

/** What a client may change after the fact. Everything else is a fact about the bytes. */
export interface ArtifactPatch {
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  readonly kbSlug?: string | null;
}

/** The same four fields, mutable — for a reader assembling a patch one field at a time. */
export interface ArtifactPatchDraft {
  title?: string;
  tags?: string[];
  pinned?: boolean;
  kbSlug?: string | null;
}

export function artifactsDir(stateDir: string): string {
  return join(stateDir, ARTIFACTS_SUBDIR);
}

export function artifactFileName(id: string, ext: string): string {
  return `${id}.${ext}`;
}

export function artifactRecordFileName(id: string): string {
  return `${id}.json`;
}

export function newArtifactId(now: number, random: string): string {
  return `${now.toString(36)}-${random.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

interface KindAndMime {
  readonly kind: ArtifactKind;
  readonly mime: string;
  readonly ext: string;
}

// Extension → kind. A closed list: an extension not here is a `file`, served as an attachment and
// never rendered, which is the safe default for bytes nobody classified.
const KINDS: ReadonlyMap<string, KindAndMime> = new Map<string, KindAndMime>([
  ["html", { kind: "html", mime: "text/html; charset=utf-8", ext: "html" }],
  ["htm", { kind: "html", mime: "text/html; charset=utf-8", ext: "html" }],
  ["md", { kind: "markdown", mime: "text/markdown; charset=utf-8", ext: "md" }],
  ["markdown", { kind: "markdown", mime: "text/markdown; charset=utf-8", ext: "md" }],
  ["png", { kind: "image", mime: "image/png", ext: "png" }],
  ["jpg", { kind: "image", mime: "image/jpeg", ext: "jpg" }],
  ["jpeg", { kind: "image", mime: "image/jpeg", ext: "jpg" }],
  ["gif", { kind: "image", mime: "image/gif", ext: "gif" }],
  ["webp", { kind: "image", mime: "image/webp", ext: "webp" }],
  ["svg", { kind: "image", mime: "image/svg+xml", ext: "svg" }],
  ["txt", { kind: "text", mime: "text/plain; charset=utf-8", ext: "txt" }],
  ["log", { kind: "text", mime: "text/plain; charset=utf-8", ext: "log" }],
  ["csv", { kind: "text", mime: "text/plain; charset=utf-8", ext: "csv" }],
  ["json", { kind: "text", mime: "text/plain; charset=utf-8", ext: "json" }],
  ["yaml", { kind: "text", mime: "text/plain; charset=utf-8", ext: "yaml" }],
  ["yml", { kind: "text", mime: "text/plain; charset=utf-8", ext: "yml" }],
  ["toml", { kind: "text", mime: "text/plain; charset=utf-8", ext: "toml" }],
  ["pdf", { kind: "file", mime: "application/pdf", ext: "pdf" }],
  ["zip", { kind: "file", mime: "application/zip", ext: "zip" }],
]);

/** The kind, mime and canonical extension for a file name — `file`/octet-stream when unclassified. */
export function artifactKindFor(fileName: string): KindAndMime {
  const raw = extname(fileName).replace(/^\./, "").toLowerCase();
  const known = KINDS.get(raw);
  if (known) return known;
  const ext = /^[a-z0-9]{1,8}$/.test(raw) ? raw : "bin";
  return { kind: "file", mime: "application/octet-stream", ext };
}

/** A slug from a title: lowercase ASCII words joined by hyphens; CJK and the like fall away. */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return s;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = jsonStringField(item);
    if (s !== null && ARTIFACT_TAG.test(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_ARTIFACT_TAGS);
}

function sessionOf(value: JsonValue | undefined): AgentSessionRef | null {
  const rec = jsonRecord(value);
  if (rec === null) return null;
  const kind = jsonStringField(rec.kind);
  const ref = jsonStringField(rec.value);
  if (ref === null || ref === "") return null;
  if (kind === "id") return { kind: "id", value: ref };
  if (kind === "path") return { kind: "path", value: ref };
  return null;
}

function paneOf(value: JsonValue | undefined): ArtifactPane | null {
  const rec = jsonRecord(value);
  if (rec === null) return null;
  const paneId = jsonStringField(rec.paneId);
  const workspaceId = jsonStringField(rec.workspaceId);
  if (paneId === null || paneId === "" || workspaceId === null) return null;
  return {
    paneId,
    workspaceId,
    workspaceLabel: jsonStringField(rec.workspaceLabel) ?? "",
    agent: jsonStringField(rec.agent) ?? "",
  };
}

function kindOf(value: string | null): ArtifactKind | null {
  switch (value) {
    case "html":
    case "markdown":
    case "image":
    case "text":
    case "file":
      return value;
    default:
      return null;
  }
}

/** One record off disk, or null for anything that is not one. Never throws. */
export function parseArtifactRecord(raw: JsonValue | undefined): ArtifactRecord | null {
  const rec = jsonRecord(raw);
  if (rec === null) return null;
  if (jsonNumberField(rec.schemaVersion) !== ARTIFACT_SCHEMA_VERSION) return null;
  const id = jsonStringField(rec.id);
  const slug = jsonStringField(rec.slug);
  const title = jsonStringField(rec.title);
  const kind = kindOf(jsonStringField(rec.kind));
  const ext = jsonStringField(rec.ext);
  const mime = jsonStringField(rec.mime);
  const size = jsonNumberField(rec.size);
  const sha256 = jsonStringField(rec.sha256);
  const createdMs = jsonNumberField(rec.createdMs);
  const version = jsonNumberField(rec.version);
  if (id === null || !ARTIFACT_ID.test(id)) return null;
  if (slug === null || !ARTIFACT_SLUG.test(slug)) return null;
  if (title === null || kind === null || ext === null || !/^[a-z0-9]{1,8}$/.test(ext)) return null;
  if (mime === null || size === null || sha256 === null || createdMs === null) return null;
  const kbSlug = jsonStringField(rec.kbSlug);
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    id,
    slug,
    version: version === null || version < 1 ? 1 : Math.floor(version),
    title: title.slice(0, MAX_ARTIFACT_TITLE_CHARS),
    kind,
    ext,
    mime,
    size,
    sha256,
    sourcePath: jsonStringField(rec.sourcePath),
    createdMs,
    tags: stringList(rec.tags),
    pinned: rec.pinned === true,
    kbSlug: kbSlug === "" ? null : kbSlug,
    harness: jsonStringField(rec.harness),
    session: sessionOf(rec.session),
    origin: jsonStringField(rec.origin),
    pane: paneOf(rec.pane),
  };
}

/** What `add` needs to know: the bytes and what the writer could say about them. */
export interface ArtifactInput {
  readonly bytes: Uint8Array;
  /** The original file name, for the extension → kind mapping and the default slug. */
  readonly fileName: string;
  readonly title: string;
  readonly slug?: string;
  readonly tags?: readonly string[];
  readonly sourcePath?: string | null;
  readonly harness?: string | null;
  readonly session?: AgentSessionRef | null;
  readonly origin?: string | null;
  /** A pane the writer already knows (a phone-side save names the pane it is looking at). */
  readonly pane?: ArtifactPane | null;
}

export type ArtifactAddFailure = "too_large" | "bad_title" | "bad_slug" | "empty";

export type ArtifactAddResult =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; reason: ArtifactAddFailure };

export interface ArtifactStoreDeps {
  readonly now?: () => number;
  readonly random?: () => string;
}

/** The store: a directory of `<id>.json` + `<id>.<ext>` pairs, read on every list. */
export class ArtifactStore {
  readonly dir: string;

  private readonly listeners = new Set<() => void>();

  private watcher: FSWatcher | null = null;

  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    stateDir: string,
    private readonly deps: ArtifactStoreDeps = {},
  ) {
    this.dir = artifactsDir(stateDir);
  }

  /** Every record, newest first. Unparseable files are skipped, never fatal. */
  async list(): Promise<ArtifactRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: ArtifactRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.readRecordFile(join(this.dir, name));
      if (record !== null && artifactRecordFileName(record.id) === name) records.push(record);
    }
    records.sort((a, b) => b.createdMs - a.createdMs || b.version - a.version);
    return records;
  }

  async get(id: string): Promise<ArtifactRecord | null> {
    if (!ARTIFACT_ID.test(id)) return null;
    const record = await this.readRecordFile(join(this.dir, artifactRecordFileName(id)));
    return record !== null && record.id === id ? record : null;
  }

  /** The bytes, or null when the record's file is missing or unreadable. Backed by a plain
   *  ArrayBuffer (not a Node pool slice), so a `Response` accepts it as a body as-is. */
  async readBytes(record: ArtifactRecord): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const buf = await readFile(join(this.dir, artifactFileName(record.id, record.ext)));
      const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
      out.set(buf);
      return out;
    } catch {
      return null;
    }
  }

  filePath(record: ArtifactRecord): string {
    return join(this.dir, artifactFileName(record.id, record.ext));
  }

  /** The version the next registration of `slug` gets: one past the highest on disk. */
  async nextVersion(slug: string): Promise<number> {
    const all = await this.list();
    let max = 0;
    for (const r of all) if (r.slug === slug && r.version > max) max = r.version;
    return max + 1;
  }

  async add(input: ArtifactInput): Promise<ArtifactAddResult> {
    if (input.bytes.byteLength === 0) return { ok: false, reason: "empty" };
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) return { ok: false, reason: "too_large" };
    const title = input.title.trim().slice(0, MAX_ARTIFACT_TITLE_CHARS);
    if (title === "") return { ok: false, reason: "bad_title" };
    const { kind, mime, ext } = artifactKindFor(input.fileName);
    const slug =
      input.slug ?? (slugify(title) || slugify(input.fileName.replace(/\.[^.]+$/, "")) || "artifact");
    if (!ARTIFACT_SLUG.test(slug)) return { ok: false, reason: "bad_slug" };
    const now = (this.deps.now ?? Date.now)();
    const id = newArtifactId(now, (this.deps.random ?? (() => crypto.randomUUID()))());
    const record: ArtifactRecord = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      id,
      slug,
      version: await this.nextVersion(slug),
      title,
      kind,
      ext,
      mime,
      size: input.bytes.byteLength,
      sha256: sha256Of(input.bytes),
      sourcePath: input.sourcePath ?? null,
      createdMs: now,
      tags: (input.tags ?? []).filter((t) => ARTIFACT_TAG.test(t)).slice(0, MAX_ARTIFACT_TAGS),
      pinned: false,
      kbSlug: null,
      harness: input.harness ?? null,
      session: input.session ?? null,
      origin: input.origin ?? null,
      pane: input.pane ?? null,
    };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Bytes first, record last — a reader that lists between the two sees no artifact at all rather
    // than one it cannot open.
    await writeFile(join(this.dir, artifactFileName(id, ext)), input.bytes, { mode: 0o600 });
    await this.writeRecord(record);
    return { ok: true, record };
  }

  async patch(id: string, patch: ArtifactPatch): Promise<ArtifactRecord | null> {
    const current = await this.get(id);
    if (current === null) return null;
    const title = patch.title === undefined ? current.title : patch.title.trim().slice(0, MAX_ARTIFACT_TITLE_CHARS);
    const next: ArtifactRecord = {
      ...current,
      title: title === "" ? current.title : title,
      tags:
        patch.tags === undefined
          ? current.tags
          : patch.tags.filter((t) => ARTIFACT_TAG.test(t)).slice(0, MAX_ARTIFACT_TAGS),
      pinned: patch.pinned ?? current.pinned,
      kbSlug: patch.kbSlug === undefined ? current.kbSlug : patch.kbSlug,
    };
    await this.writeRecord(next);
    return next;
  }

  /** Remove the record and its bytes. True when a record was there to remove. */
  async remove(id: string): Promise<boolean> {
    const current = await this.get(id);
    if (current === null) return false;
    await rm(join(this.dir, artifactRecordFileName(id)), { force: true });
    await rm(join(this.dir, artifactFileName(id, current.ext)), { force: true });
    return true;
  }

  /**
   * Stamp the pane onto every record whose session a live agent is carrying, and persist the stamp
   * — see the header. Returns the records with the stamps applied (a copy; the input is not touched).
   */
  async resolvePanes(records: readonly ArtifactRecord[], agents: readonly AgentView[]): Promise<ArtifactRecord[]> {
    const bySession = new Map<string, AgentView>();
    for (const agent of agents) {
      const ref = agent.agentSession;
      if (ref !== undefined) bySession.set(`${ref.kind} ${ref.value}`, agent);
    }
    const out: ArtifactRecord[] = [];
    for (const record of records) {
      if (record.pane !== null || record.session === null) {
        out.push(record);
        continue;
      }
      const agent = bySession.get(`${record.session.kind} ${record.session.value}`);
      if (agent === undefined) {
        out.push(record);
        continue;
      }
      const stamped: ArtifactRecord = {
        ...record,
        pane: {
          paneId: agent.paneId,
          workspaceId: agent.workspaceId,
          workspaceLabel: agent.workspaceLabel,
          agent: agent.agent,
        },
      };
      try {
        await this.writeRecord(stamped);
      } catch {
        // The stamp is a convenience; a failed write costs one more resolve next list, not the row.
      }
      out.push(stamped);
    }
    return out;
  }

  /** Total bytes on disk across every record — the Settings row's number. */
  async usage(): Promise<{ count: number; bytes: number }> {
    const all = await this.list();
    let bytes = 0;
    for (const r of all) bytes += r.size;
    return { count: all.length, bytes };
  }

  /**
   * Be told when the directory changes — a `collie artifact add` from a pane, a delete from the phone.
   * Debounced, because a registration is two writes. The watcher is non-persistent and opened lazily,
   * so a bridge that nobody subscribes to holds no handle.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.ensureWatcher();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.closeWatcher();
    };
  }

  close(): void {
    this.listeners.clear();
    this.closeWatcher();
  }

  private ensureWatcher(): void {
    if (this.watcher !== null) return;
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => this.scheduleNotify());
      this.watcher.on("error", () => this.closeWatcher());
    } catch {
      // No directory yet (nothing registered) or no inotify budget: the next `add` from this process
      // notifies directly, and a foreign write is picked up by the next list.
      this.watcher = null;
    }
  }

  private closeWatcher(): void {
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleNotify(): void {
    if (this.watchTimer !== null) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      for (const l of this.listeners) {
        try {
          l();
        } catch {
          // A listener's failure is its own.
        }
      }
    }, 200);
  }

  private async readRecordFile(path: string): Promise<ArtifactRecord | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    let raw: JsonValue;
    try {
      // SAFETY: `JSON.parse` returns the untyped tree of whatever was on disk; `parseArtifactRecord`
      // narrows every field it uses through the stt/json.ts readers and answers null otherwise.
      raw = JSON.parse(text) as JsonValue;
    } catch {
      return null;
    }
    return parseArtifactRecord(raw);
  }

  /** Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target. */
  private async writeRecord(record: ArtifactRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, artifactRecordFileName(record.id));
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    const body: JsonObject = {
      schemaVersion: record.schemaVersion,
      id: record.id,
      slug: record.slug,
      version: record.version,
      title: record.title,
      kind: record.kind,
      ext: record.ext,
      mime: record.mime,
      size: record.size,
      sha256: record.sha256,
      sourcePath: record.sourcePath,
      createdMs: record.createdMs,
      tags: [...record.tags],
      pinned: record.pinned,
      kbSlug: record.kbSlug,
      harness: record.harness,
      session: record.session === null ? null : { kind: record.session.kind, value: record.session.value },
      origin: record.origin,
      pane:
        record.pane === null
          ? null
          : {
              paneId: record.pane.paneId,
              workspaceId: record.pane.workspaceId,
              workspaceLabel: record.pane.workspaceLabel,
              agent: record.pane.agent,
            },
    };
    await writeFile(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    await rename(tmp, target);
    this.scheduleNotify();
  }
}

/** `stat` without the throw — for callers that want to know whether the bytes are still there. */
export async function artifactBytesPresent(store: ArtifactStore, record: ArtifactRecord): Promise<boolean> {
  try {
    await stat(store.filePath(record));
    return true;
  } catch {
    return false;
  }
}
