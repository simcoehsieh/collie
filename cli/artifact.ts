import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import {
  ARTIFACT_SLUG,
  ARTIFACT_TAG,
  ArtifactStore,
  MAX_ARTIFACT_BYTES,
  type ArtifactAddFailure,
  type ArtifactInput,
  type ArtifactRecord,
} from "../bridge/artifacts.ts";
import { readSessionFromEnv } from "./beacon.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec } from "./sys.ts";

// FORK — `collie artifact add` / `collie artifact list`: the agent's half of the artifacts library.
//
// An agent that just wrote a report types ONE line and the phone can open it, filed under this pane,
// for as long as the library keeps it — bridge/artifacts.ts has the whole argument. This file is the
// verb: parse the flags, read the bytes, hand them to the store the bridge reads. It writes the state
// dir directly rather than calling the bridge (the beacon's argument: the CLI IS the operator on the
// operator's machine, and an HTTP write would need a credential the agent has no business holding).
//
// WHICH PANE: the same environment read `beacon status` makes (`readSessionFromEnv`) — the harness
// session id — but read THROUGH the child-session marker: the bridge decides the pane by joining the
// id against the multiplexer's own agent list, so a subagent's id (which no pane carries) yields an
// artifact with no pane and no card in the thread, and an interactive session that merely inherited
// the marker keeps its pane. `--origin` names a source that has no pane by design (a scheduler job),
// and is what the library shows in the pane's place.

export const ARTIFACT_USAGE = [
  "usage:",
  '  collie artifact add <file> [--title "…"] [--slug s] [--tag t]… [--origin name]',
  "  collie artifact list [--limit N]",
  '  collie artifact promote <id> --folder <kb folder> [--summary "…"] [--tag t]… [--kb-slug s]',
].join("\n");

export interface ArtifactFiles {
  /** The bytes of a file, or null when it cannot be read. */
  readBytes(path: string): Uint8Array | null;
  cwd(): string;
}

export interface ArtifactDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly files: ArtifactFiles;
  /** A store to use instead of the state dir's — the test seam. */
  readonly store?: ArtifactStore;
  /** For `promote`: how the kb CLI is run. Absent ⇒ promote refuses (nothing to run it with). */
  readonly exec?: Exec;
}

export const realArtifactFiles: ArtifactFiles = {
  readBytes(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
  },
  cwd: () => process.cwd(),
};

export interface ArtifactAddArgs {
  readonly file: string;
  readonly title: string | null;
  readonly slug: string | null;
  readonly tags: readonly string[];
  readonly origin: string | null;
}

/** `--flag value` and `--flag=value`, one positional (the file). Every refusal is a sentence. */
export function parseArtifactAddArgs(args: readonly string[]): ArtifactAddArgs | { error: string } {
  let file: string | null = null;
  let title: string | null = null;
  let slug: string | null = null;
  let origin: string | null = null;
  const tags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      if (file !== null) return { error: `one file at a time (got "${file}" and "${arg}")` };
      file = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return { error: `--${name} needs a value` };
      value = next;
      i++;
    }
    switch (name) {
      case "title":
        title = value;
        break;
      case "slug":
        if (!ARTIFACT_SLUG.test(value)) return { error: `--slug must match ${ARTIFACT_SLUG.source} (got "${value}")` };
        slug = value;
        break;
      case "tag":
        if (!ARTIFACT_TAG.test(value)) return { error: `--tag must match ${ARTIFACT_TAG.source} (got "${value}")` };
        if (!tags.includes(value)) tags.push(value);
        break;
      case "origin":
        origin = value.trim().slice(0, 40);
        break;
      default:
        return { error: `unknown flag --${name}` };
    }
  }
  if (file === null) return { error: "which file? `collie artifact add <file>`" };
  return { file, title, slug, tags, origin };
}

/** The address the phone opens an artifact at, from the deployment's first public host. */
export function artifactPhoneUrl(ctx: CliContext, id: string): string {
  const hosts = (ctx.env.COLLIE_PUBLIC_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  const origin = hosts.length > 0 ? `https://${hosts[0]!}` : `http://127.0.0.1:${String(ctx.port)}`;
  return `${origin}/artifacts/${id}`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function cmdArtifactAdd(deps: ArtifactDeps, args: readonly string[]): Promise<number> {
  const parsed = parseArtifactAddArgs(args);
  if ("error" in parsed) {
    deps.io.err(parsed.error);
    deps.io.err(ARTIFACT_USAGE);
    return EXIT.USAGE;
  }
  const path = resolve(deps.files.cwd(), parsed.file);
  const bytes = deps.files.readBytes(path);
  if (bytes === null) {
    deps.io.err(`cannot read ${path}`);
    return EXIT.FAIL;
  }
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    deps.io.err(
      `${basename(path)} is ${humanSize(bytes.byteLength)}; the library keeps files up to ` +
        `${humanSize(MAX_ARTIFACT_BYTES)} — leave it in the pane's cwd and open it with Preview instead`,
    );
    return EXIT.REFUSED;
  }
  const fileName = basename(path);
  const title = parsed.title?.trim() || fileName.replace(new RegExp(`${extname(fileName).replace(".", "\\.")}$`), "");
  const identity = readSessionFromEnv(deps.ctx.env, { allowChild: true });
  const store = deps.store ?? new ArtifactStore(deps.ctx.stateDir);
  const input: ArtifactInput = {
    bytes,
    fileName,
    title,
    tags: parsed.tags,
    sourcePath: path,
    harness: identity?.harness ?? null,
    session: identity === null ? null : { kind: "id", value: identity.session },
    origin: parsed.origin,
  };
  const added = await store.add(parsed.slug === null ? input : { ...input, slug: parsed.slug });
  if (!added.ok) {
    deps.io.err(`not registered: ${refusalText(added.reason)}`);
    return EXIT.REFUSED;
  }
  const r = added.record;
  deps.io.out(`artifact ${r.id} · v${String(r.version)} · ${r.kind} · ${humanSize(r.size)} · "${r.title}"`);
  deps.io.out(`open on the phone: ${artifactPhoneUrl(deps.ctx, r.id)}`);
  if (identity === null && parsed.origin === null) {
    deps.io.err(
      "note: no agent session in this environment (a plain shell), so the artifact is in the library " +
        "but not under any pane — pass --origin <name> to say where it came from",
    );
  }
  return EXIT.OK;
}

function refusalText(reason: ArtifactAddFailure): string {
  switch (reason) {
    case "too_large":
      return "the file is over the library's byte cap";
    case "bad_title":
      return "the title is empty";
    case "bad_slug":
      return "the slug is not a slug";
    case "empty":
      return "the file is empty";
  }
}

function paneLabel(r: ArtifactRecord): string {
  if (r.pane !== null) return `${r.pane.workspaceLabel} › ${r.pane.agent} (${r.pane.paneId})`;
  if (r.origin !== null) return r.origin;
  return r.session === null ? "—" : "session not yet matched to a pane";
}

export async function cmdArtifactList(deps: ArtifactDeps, args: readonly string[]): Promise<number> {
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name === "--limit") {
      const raw = eq === -1 ? args[++i] : arg.slice(eq + 1);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        deps.io.err("--limit needs a positive integer");
        return EXIT.USAGE;
      }
      limit = n;
    } else {
      deps.io.err(`unknown flag ${arg}`);
      deps.io.err(ARTIFACT_USAGE);
      return EXIT.USAGE;
    }
  }
  const store = deps.store ?? new ArtifactStore(deps.ctx.stateDir);
  const rows = await store.list();
  if (rows.length === 0) {
    deps.io.out("the library is empty — `collie artifact add <file>` puts something in it");
    return EXIT.OK;
  }
  for (const r of rows.slice(0, limit)) {
    const when = new Date(r.createdMs).toISOString().replace("T", " ").slice(0, 16);
    deps.io.out(
      `${r.id}  v${String(r.version).padEnd(2)} ${r.kind.padEnd(8)} ${humanSize(r.size).padStart(9)}  ${when}  ${r.title}  [${paneLabel(r)}]`,
    );
  }
  if (rows.length > limit) deps.io.out(`… ${String(rows.length - limit)} more (--limit ${String(rows.length)})`);
  return EXIT.OK;
}

// ── promote: the long-term copy, in the knowledge base ────────────────────────────────────────
//
// The library is the WORKING set — filed by pane, pruned one day. The knowledge base is the archive
// the operator searches in a month. `promote` is the one step between them: push the artifact's
// bytes with the operator's own `kb` CLI (push, then promote — its two verbs), and write the kb
// slug back onto the record so the viewer can offer the archived copy. HTML only, because that is
// what the kb takes; the CLI's path and the public origin come from the deployment's env.

export const KB_CLI_ENV = "COLLIE_KB_CLI";
export const KB_PUBLIC_ORIGIN_ENV = "COLLIE_KB_PUBLIC_ORIGIN";

export interface ArtifactPromoteArgs {
  readonly id: string;
  readonly folder: string | null;
  readonly summary: string | null;
  readonly tags: readonly string[];
  readonly kbSlug: string | null;
}

export function parseArtifactPromoteArgs(args: readonly string[]): ArtifactPromoteArgs | { error: string } {
  let id: string | null = null;
  let folder: string | null = null;
  let summary: string | null = null;
  let kbSlug: string | null = null;
  const tags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      if (id !== null) return { error: `one artifact at a time (got "${id}" and "${arg}")` };
      id = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return { error: `--${name} needs a value` };
      value = next;
      i++;
    }
    switch (name) {
      case "folder":
        folder = value;
        break;
      case "summary":
        summary = value;
        break;
      case "tag":
        // The kb's tag grammar is stricter than ours (an ltree label: `[a-z0-9_]`); a hyphen would be
        // silently dropped on that side, so it is refused on this one.
        if (!/^[a-z0-9_]{1,40}$/.test(value)) return { error: `--tag must be [a-z0-9_] for the kb (got "${value}")` };
        if (!tags.includes(value)) tags.push(value);
        break;
      case "kb-slug":
        if (!ARTIFACT_SLUG.test(value)) return { error: `--kb-slug must match ${ARTIFACT_SLUG.source} (got "${value}")` };
        kbSlug = value;
        break;
      default:
        return { error: `unknown flag --${name}` };
    }
  }
  if (id === null) return { error: "which artifact? `collie artifact promote <id> --folder <kb folder>`" };
  return { id, folder, summary, tags, kbSlug };
}

function kbCliPath(ctx: CliContext): string {
  const configured = ctx.env[KB_CLI_ENV]?.trim();
  return configured !== undefined && configured !== "" ? configured : `${ctx.home}/git/side-projects/knowledge-system/bin/kb`;
}

function kbPublicOrigin(ctx: CliContext): string {
  const configured = ctx.env[KB_PUBLIC_ORIGIN_ENV]?.trim();
  return configured !== undefined && configured !== "" ? configured.replace(/\/+$/, "") : "https://knowledge.agnex.dev";
}

export async function cmdArtifactPromote(deps: ArtifactDeps, args: readonly string[]): Promise<number> {
  const parsed = parseArtifactPromoteArgs(args);
  if ("error" in parsed) {
    deps.io.err(parsed.error);
    deps.io.err(ARTIFACT_USAGE);
    return EXIT.USAGE;
  }
  if (parsed.folder === null) {
    deps.io.err("--folder is required: which kb folder should it live in? (`kb folder tree` lists them)");
    return EXIT.USAGE;
  }
  if (deps.exec === undefined) {
    deps.io.err("promote needs a way to run the kb CLI, and this build has none");
    return EXIT.FAIL;
  }
  const store = deps.store ?? new ArtifactStore(deps.ctx.stateDir);
  const record = await store.get(parsed.id);
  if (record === null) {
    deps.io.err(`no artifact ${parsed.id} — \`collie artifact list\` shows the ids`);
    return EXIT.FAIL;
  }
  if (record.kind !== "html") {
    deps.io.err(`the knowledge base takes HTML; ${record.id} is ${record.kind}`);
    return EXIT.REFUSED;
  }
  const kb = kbCliPath(deps.ctx);
  const slug = parsed.kbSlug ?? record.kbSlug ?? record.slug;
  const pushed = deps.exec.capture(
    kb,
    ["push", store.filePath(record), "--folder", parsed.folder, "--slug", slug, "--title", record.title],
    120_000,
  );
  if (pushed.code !== 0) {
    deps.io.err(`kb push failed (${String(pushed.code)}): ${(pushed.stderr || pushed.stdout).trim()}`);
    return EXIT.FAIL;
  }
  const promoteArgs = ["promote", slug];
  if (parsed.summary !== null) promoteArgs.push("--summary", parsed.summary);
  for (const tag of parsed.tags) promoteArgs.push("--tag", tag);
  const promoted = deps.exec.capture(kb, promoteArgs, 300_000);
  if (promoted.code !== 0) {
    deps.io.err(`kb promote failed (${String(promoted.code)}): ${(promoted.stderr || promoted.stdout).trim()}`);
    deps.io.err("the document was pushed and sits in the kb as a draft — re-run promote, or `kb promote` it by hand");
    return EXIT.FAIL;
  }
  await store.patch(record.id, { kbSlug: slug });
  deps.io.out(`promoted ${record.id} → ${kbPublicOrigin(deps.ctx)}/d/${slug}`);
  return EXIT.OK;
}

