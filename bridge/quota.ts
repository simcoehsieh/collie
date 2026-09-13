import type { JsonValue } from "./json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "./stt/json.ts";
import { computeEtag } from "./http-cache.ts";
import type { QuotaAgent, QuotaAgentKey, QuotaModel, QuotaResponse, QuotaWindow, QuotaWindowKind } from "./types.ts";

// FORK: what the three agents have left — `GET /api/quota`, fed by the operator's own CLI.
//
// ── WHY A CLI AND NOT THE PROVIDERS ─────────────────────────────────────────────────────────────
// Each provider's quota lives behind a credential the operator already holds on this machine
// (a keychain entry, an OAuth token file) and behind an API that is not documented for this use.
// `ai-quota` (tools/ai-quota in the operator's ai-live repo) already reads all three in parallel
// and prints one JSON; teaching the bridge to do the same would mean carrying three credential
// readers and three undocumented endpoints here. So the bridge runs the command the operator named
// and reads its JSON, exactly the way `collie stt` reaches a provider only when the operator set
// one up: declined by doing nothing when `COLLIE_QUOTA_COMMAND` is empty.
//
// ── WHAT NEVER REACHES THE PHONE ─────────────────────────────────────────────────────────────────
// The CLI's stdout and stderr. Its JSON is read for the fields named in {@link normaliseQuota} and
// nothing else is copied out — an `account_email`, an `account_id`, a token that leaked into an
// error message stay on this side. A failure is a plain-text reason and a one-line warn.
//
// ── WHY THE CACHE SERVES STALE ───────────────────────────────────────────────────────────────────
// The CLI takes two seconds (three providers, in parallel). A dashboard that blocked its usage
// section on that every time it mounted would be a dashboard that opened slower than it did
// yesterday. So a body older than the TTL is served at once and refreshed behind the answer, and a
// request that lands during a refresh gets the last good body rather than a second spawn. Only the
// FIRST read — no body at all — waits, and an explicit `?refresh=1` waits, because a refresh button
// that hands back what was already on screen reads as broken.

/** The command's stdout is read under this cap; past it the run is killed and counts as failed. */
export const QUOTA_OUTPUT_CAP = 256 * 1024;
/** The command is killed at this deadline. Three providers in parallel take ~2 s; 20 leaves room. */
export const QUOTA_DEADLINE_MS = 20_000;
/** A body younger than this is served without a rerun. */
export const QUOTA_TTL_MS = 60_000;

/** One run of the command. `code` is null when it was killed (deadline or cap). */
export interface QuotaRun {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/** The one call this module makes, injectable so the tests never spawn a process. */
export interface QuotaIo {
  run: (argv: readonly string[], deadlineMs: number) => Promise<QuotaRun>;
}

/**
 * The command as an argv: whitespace-split, no shell. Null when nothing is configured. Quoting is
 * deliberately not supported — a path with a space in it is a path the operator symlinks.
 */
export function parseQuotaCommand(command: string): string[] | null {
  const argv = command.trim().split(/\s+/u).filter((part) => part !== "");
  return argv.length === 0 ? null : argv;
}

/** Spawn the argv with the standard hygiene: no stdin, a deadline, a byte cap, stderr dropped. */
function spawnPiped(argv: readonly string[]) {
  return Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: process.env });
}

export async function runQuotaCommand(argv: readonly string[], deadlineMs: number): Promise<QuotaRun> {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(argv);
  } catch {
    // ENOENT and friends: the command is not there. The same outcome as a non-zero exit.
    return { code: 127, stdout: "", timedOut: false };
  }
  let timedOut = false;
  let capped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, deadlineMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > QUOTA_OUTPUT_CAP) {
        capped = true;
        proc.kill();
        break;
      }
      chunks.push(value);
    }
  } catch {
    capped = true;
  } finally {
    clearTimeout(timer);
  }
  const code = await proc.exited;
  const stdout = capped ? "" : new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  return { code: timedOut || capped ? null : code, stdout, timedOut };
}

export const spawnQuotaIo: QuotaIo = { run: runQuotaCommand };

// ── Normalising the CLI's JSON ────────────────────────────────────────────────────────────────

/** The CLI's provider keys, in the order the phone shows them, and the agent each one runs. */
const AGENTS: ReadonlyArray<{ provider: string; key: QuotaAgentKey; name: string }> = [
  { provider: "claude", key: "claude", name: "claude" },
  { provider: "openai", key: "codex", name: "codex" },
  { provider: "gemini", key: "agy", name: "agy" },
];

const FIVE_HOURS_S = 5 * 3600;
const ONE_WEEK_S = 7 * 24 * 3600;

function kindOf(limitWindowSeconds: number | null): QuotaWindowKind {
  if (limitWindowSeconds === FIVE_HOURS_S) return "5h";
  if (limitWindowSeconds === ONE_WEEK_S) return "weekly";
  return "other";
}

/** A percentage the phone can draw: finite, clamped to 0–100, one decimal. */
function percent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function readWindow(value: JsonValue | undefined, fallbackLabel: string): QuotaWindow | null {
  const row = jsonRecord(value);
  if (row === null) return null;
  const used = jsonNumberField(row.used_percent);
  if (used === null) return null;
  return {
    kind: kindOf(jsonNumberField(row.limit_window_seconds)),
    label: jsonStringField(row.label) ?? fallbackLabel,
    usedPercent: percent(used),
    resetAt: jsonStringField(row.reset_at),
    resetAfterSeconds: jsonNumberField(row.reset_after_seconds),
    status: jsonStringField(row.status) ?? "",
  };
}

function readModels(value: JsonValue | undefined): QuotaModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: QuotaModel[] = [];
  for (const item of value) {
    const row = jsonRecord(item);
    if (row === null) continue;
    const label = jsonStringField(row.display_name) ?? jsonStringField(row.id);
    const used = jsonNumberField(row.used_percent);
    if (label === null || used === null) continue;
    models.push({ label, usedPercent: percent(used), resetAfterSeconds: jsonNumberField(row.reset_after_seconds) });
  }
  return models.length > 0 ? models : undefined;
}

/** The balance as the provider states it — `$0`, `unlimited` — or nothing when it states nothing. */
function readCredits(value: JsonValue | undefined): string | undefined {
  const row = jsonRecord(value);
  if (row === null) return undefined;
  if (row.unlimited === true) return "unlimited";
  const balance = jsonStringField(row.balance);
  if (balance !== null) return balance;
  const remaining = jsonNumberField(row.remaining) ?? jsonNumberField(row.balance);
  return remaining === null ? undefined : String(remaining);
}

function readAgent(providers: JsonValue | undefined, spec: (typeof AGENTS)[number]): QuotaAgent {
  const table = jsonRecord(providers);
  const row = table === null ? null : jsonRecord(table[spec.provider]);
  if (row === null) return { key: spec.key, name: spec.name, status: "missing", windows: [] };
  const status = jsonStringField(row.status);
  const agent: QuotaAgent = {
    key: spec.key,
    name: spec.name,
    status: status === "ok" ? "ok" : "error",
    windows: [],
  };
  const plan = jsonStringField(row.plan);
  if (plan !== null) agent.plan = plan;
  const five = readWindow(row.five_hour_window, "5h");
  if (five !== null) agent.windows.push({ ...five, kind: five.kind === "other" ? "5h" : five.kind });
  const primary = readWindow(row.primary_window, "weekly");
  if (primary !== null) agent.windows.push({ ...primary, kind: primary.kind === "other" ? "weekly" : primary.kind });
  if (Array.isArray(row.secondary_windows)) {
    for (const item of row.secondary_windows) {
      const window = readWindow(item, "");
      if (window !== null) agent.windows.push({ ...window, kind: "other" });
    }
  }
  const models = readModels(row.model_quotas);
  if (models !== undefined) agent.models = models;
  const credits = readCredits(row.credits);
  if (credits !== undefined) agent.credits = credits;
  if (agent.status === "error") {
    // The CLI's STRUCTURED error only — never a slice of stdout, never stderr. It is the one string
    // from the run that is allowed to reach the phone, and it is capped so a stack trace cannot.
    const error = jsonStringField(row.error) ?? status ?? "unavailable";
    agent.error = error.length > 200 ? `${error.slice(0, 200)}…` : error;
  }
  return agent;
}

/**
 * The CLI's JSON as the phone's body, or null when the text is not the JSON this module knows.
 * Always three agents, always in order; a provider the CLI did not report is `missing`.
 */
export function normaliseQuota(text: string, fetchedAt: string): QuotaResponse | null {
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse of text yields exactly the JSON value space; every field is then narrowed
    // through the readers below before it becomes a domain value.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  const root = jsonRecord(parsed);
  if (root === null) return null;
  const providers = jsonRecord(root.providers);
  if (providers === null) return null;
  return { ok: true, fetchedAt, agents: AGENTS.map((spec) => readAgent(providers, spec)) };
}

// ── The cache ─────────────────────────────────────────────────────────────────────────────────

export type QuotaFailure = "not_configured" | "failed" | "timeout" | "unparsable";

/** A body ready to send: serialised once, hashed once, stamped with when the CLI ran. */
export interface QuotaBody {
  body: string;
  etag: string;
  at: number;
}

export type QuotaResult = ({ ok: true } & QuotaBody) | { ok: false; reason: QuotaFailure };

export interface QuotaSourceOptions {
  ttlMs?: number;
  deadlineMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

/**
 * One command, one cache, one in-flight run at a time. See the header for the serve-stale rule.
 */
export class QuotaSource {
  private last: QuotaBody | null = null;
  private lastFailure: QuotaFailure | null = null;
  private inflight: Promise<QuotaResult> | null = null;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly argv: readonly string[],
    private readonly io: QuotaIo = spawnQuotaIo,
    opts: QuotaSourceOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? QUOTA_TTL_MS;
    this.deadlineMs = opts.deadlineMs ?? QUOTA_DEADLINE_MS;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((message) => console.warn(`[quota] ${message}`));
  }

  /** The last good body, whatever its age. */
  cached(): QuotaBody | null {
    return this.last;
  }

  /**
   * The body to answer with. `refresh` forces a run and waits for it (coalesced with any run
   * already in flight); otherwise a fresh body is answered from cache, a stale one is answered
   * from cache while a run is started behind it, and only "no body yet" waits.
   */
  async get(refresh = false): Promise<QuotaResult> {
    const cached = this.last;
    if (refresh) return this.run();
    if (cached !== null) {
      if (this.now() - cached.at >= this.ttlMs) void this.run();
      return { ok: true, ...cached };
    }
    return this.run();
  }

  private run(): Promise<QuotaResult> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.execute().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async execute(): Promise<QuotaResult> {
    let run: QuotaRun;
    try {
      run = await this.io.run(this.argv, this.deadlineMs);
    } catch {
      run = { code: 1, stdout: "", timedOut: false };
    }
    const reason = this.judge(run);
    if (reason !== null) {
      this.lastFailure = reason;
      this.warn(`${this.argv[0]} ${reason === "timeout" ? `did not finish within ${this.deadlineMs}ms` : reason === "unparsable" ? "printed something that is not its JSON" : `exited ${run.code ?? "killed"}`}`);
      // A run that failed leaves a stale body in place: what the operator saw a minute ago is
      // better than an empty section, and the next request tries again.
      return this.last !== null ? { ok: true, ...this.last } : { ok: false, reason };
    }
    const at = this.now();
    const body = JSON.stringify(normaliseQuota(run.stdout, new Date(at).toISOString()));
    this.last = { body, etag: computeEtag(body), at };
    this.lastFailure = null;
    return { ok: true, ...this.last };
  }

  private judge(run: QuotaRun): QuotaFailure | null {
    if (run.timedOut) return "timeout";
    if (run.code !== 0) return "failed";
    return normaliseQuota(run.stdout, "") === null ? "unparsable" : null;
  }

  /** The reason the most recent run failed, for a test; null after a success. */
  failure(): QuotaFailure | null {
    return this.lastFailure;
  }
}
