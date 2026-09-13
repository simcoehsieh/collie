import type { JsonValue } from "./json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "./stt/json.ts";
import type { ProbeBox, ProbeResponse, ProbeStyles, ShotResponse, Viewport } from "./types.ts";

// FORK: a picture of a local page, and one element out of it — `POST /api/pane/:id/shot` and
// `POST /api/pane/:id/probe`, both fed by the operator's own command.
//
// ── WHY A COMMAND AND NOT A BROWSER IN HERE ─────────────────────────────────────────────────────
// CLAUDE.md: the bridge "makes no outbound call and spawns no long-running child for content".
// `bridge/quota.ts` argued the first exception to that and this is the second, of exactly the same
// shape and for exactly the same reason. Taking a screenshot of a page means driving a browser:
// a WebSocket client for the DevTools protocol, a launcher that knows which Chrome binary and which
// profile this machine keeps for automation, and a page-lifecycle model. All three are facts about
// ONE machine, and none of them belongs in a process whose job is to mirror a terminal. The
// operator already has that knowledge on disk — `chrome-cdp`'s idempotent headless launcher — so
// the bridge runs the argv they named and reads what comes back.
//
// Declined by doing nothing: with `COLLIE_SHOT_COMMAND` empty there is no route (404) and no
// capability on `/api/config`, so a phone never draws a button for something this host cannot do.
//
// ── WHAT NEVER REACHES THE PHONE ────────────────────────────────────────────────────────────────
// The command's stderr (dropped at the spawn) and, for `probe`, any field of its stdout that
// {@link normaliseProbe} does not name. A shot's stdout is IMAGE BYTES and is answered as a
// `data:` URL after being sniffed — if it is not one of the two formats below, it is a failure and
// the bytes are discarded rather than forwarded. The command may read a page holding the operator's
// own session; nothing it prints is echoed as text.
//
// ── WHY NO EGRESS ───────────────────────────────────────────────────────────────────────────────
// The URL is checked HERE as well as in the command. Two enforcers, one rule, for the reason
// `bridge/uploads.ts` gives about its size cap: the command is the one that holds when it is run by
// hand, and this one is what makes the ROUTE unable to ask for an outbound fetch at all. Loopback
// is always allowed; anything else has to be named in `COLLIE_SHOT_HOSTS`.
//
// ── WHY NO CACHE ────────────────────────────────────────────────────────────────────────────────
// Unlike quota, a shot is a one-shot: the operator asked what the page looks like NOW, and serving
// a body from thirty seconds ago is answering a different question. The probe is likewise a fresh
// question about a fresh tap. So there is no TTL and no serve-stale here, only a deadline.

/** The command's stdout is read under this cap; past it the run is killed and counts as failed. */
export const SHOT_OUTPUT_CAP = 8 * 1024 * 1024;
/**
 * The largest image that may become a `data:` URL in a response body.
 *
 * Lower than the spawn cap on purpose. Base64 costs a third on top, so 4 MB of WebP is a ~5.5 MB
 * body — already generous for a phone on cellular, and a 390×844@3 shot measures in the tens of
 * kilobytes. The gap between the two numbers is what lets an oversize run be reported as "too big"
 * rather than as a killed child with no reason attached.
 */
export const SHOT_IMAGE_CAP = 4 * 1024 * 1024;
/** The command is killed at this deadline. A cold Chrome launch plus a page load fits in well under. */
export const SHOT_DEADLINE_MS = 30_000;

/** One run of the command. `code` is null when it was killed (deadline or cap). */
export interface ShotRun {
  code: number | null;
  stdout: Uint8Array;
  timedOut: boolean;
}

/** The one call this module makes, injectable so the tests never spawn a process. */
export interface ShotIo {
  run: (argv: readonly string[], deadlineMs: number) => Promise<ShotRun>;
}

/**
 * The command as an argv: whitespace-split, no shell. Null when nothing is configured. Quoting is
 * deliberately not supported — a path with a space in it is a path the operator symlinks. The same
 * rule, and the same words, as `parseQuotaCommand`: two seams that parse their argv differently are
 * two seams an operator has to remember differently.
 */
export function parseShotCommand(command: string): string[] | null {
  const argv = command.trim().split(/\s+/u).filter((part) => part !== "");
  return argv.length === 0 ? null : argv;
}

/** Spawn the argv with the standard hygiene: no stdin, a deadline, a byte cap, stderr dropped. */
function spawnPiped(argv: readonly string[]) {
  return Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: process.env });
}

export async function runShotCommand(argv: readonly string[], deadlineMs: number): Promise<ShotRun> {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(argv);
  } catch {
    // ENOENT and friends: the command is not there. The same outcome as a non-zero exit.
    return { code: 127, stdout: new Uint8Array(), timedOut: false };
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
      if (size > SHOT_OUTPUT_CAP) {
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
  const stdout = capped ? new Uint8Array() : new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  return { code: timedOut || capped ? null : code, stdout, timedOut };
}

export const spawnShotIo: ShotIo = { run: runShotCommand };

// ── The URL policy ────────────────────────────────────────────────────────────────────────────

/**
 * Hostnames a shot may always be taken of. A shot is a picture of something running on THIS
 * machine; anything else is an outbound fetch, which is the thing CLAUDE.md's rule is about.
 *
 * `0.0.0.0` is here because a dev server bound to it answers on loopback and is routinely what
 * `vite --host` prints; the request still leaves this box no more than `127.0.0.1` does.
 */
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];

/**
 * Whether this URL may be shot, and the URL to hand the command. Null is a refusal.
 *
 * Returns the PARSED-AND-RESERIALISED href rather than the caller's string, so what the command
 * receives is what this function judged — a second parse with a different opinion is how a check
 * and its subject stop describing the same thing.
 */
export function allowedShotUrl(raw: string, extraHosts: readonly string[] = []): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Credentials in the authority would be handed to a page and echoed back in its own `location`.
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const allowed = [...LOOPBACK_HOSTS, ...extraHosts.map((h) => h.trim().toLowerCase())];
  if (!allowed.includes(host)) return null;
  return url.toString();
}

// ── The image ─────────────────────────────────────────────────────────────────────────────────

/**
 * The MIME type these bytes actually are, or null for anything else.
 *
 * The same reasoning `bridge/uploads.ts` gives for sniffing an upload rather than trusting its
 * declared type, applied to a child process instead of a client: what the command SAID it would
 * print is not evidence. Two formats only — the command encodes WebP and falls back to PNG on a
 * Chrome too old for it; anything else means the run went wrong and the bytes are not an answer.
 */
export function shotImageMime(bytes: Uint8Array): "image/webp" | "image/png" | null {
  const at = (i: number) => bytes[i];
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 8 &&
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

/** The image as a `data:` URL the phone can paint straight into a canvas. */
export function shotDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

// ── Normalising the probe's JSON ──────────────────────────────────────────────────────────────
//
// The budgets are Orca's (research notes §A.3) and they are applied on BOTH sides for the reason
// the URL check is: the command truncates because it is the only thing that can see the page, and
// this truncates because it is the only thing between a command and a terminal. A command that
// grows a new field, or forgets a cap, cannot widen what a pane receives.

const CAP = {
  selector: 700,
  path: 900,
  source: 500,
  react: 500,
  text: 200,
  html: 4096,
  nearbyText: 200,
  nearbyTextCount: 10,
  nearbyElement: 160,
  nearbyElementCount: 6,
  classes: 500,
  a11y: 500,
  styleValue: 120,
  styleCount: 16,
  url: 2048,
} as const;

/**
 * The narrow secret list, restated here rather than shared with the command: the two live in
 * different languages and different repositories, and a redaction that is only enforced where the
 * page is read is a redaction that stops existing the day the command is replaced.
 *
 * NARROW on purpose, and Orca's own source carries the argument: broad words like `code` or `state`
 * match ordinary class names (`source-code`, `stateful`) and would redact most of a real page,
 * degrading the answer without protecting anything.
 */
const SECRET_WORDS =
  "access_token|auth_token|api_key|apikey|client_secret|oauth_state|x-amz-|session_id|sessionid|csrf|secret|password|passwd";
const SECRET = new RegExp(SECRET_WORDS, "iu");

/**
 * Every `name=value` / `name: value` in the text, so the replacer below can judge each one.
 *
 * Both an HTML attribute and a URL query parameter have this shape, which is why one pattern covers
 * the two places a token turns up in a probe payload.
 */
const ASSIGNMENT = /([A-Za-z0-9_\-.[\]]+)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"'<>]+)/gu;

/**
 * A URL's secret-named query parameters, replaced in place. Orca's `sanitizedUrl`, and the reason
 * it is its own step: an `href` is usually the thing a question is ABOUT, so redacting the whole
 * attribute because one parameter was a token throws away the path, the page and the route with it.
 */
const SECRET_PARAM = new RegExp(`([?&])([^=&]*(?:${SECRET_WORDS})[^=&]*)=([^&#\\s"']*)`, "giu");

/**
 * The text with every secret-shaped value replaced by `[redacted]`.
 *
 * THE NAME SURVIVES AND THE VALUE DOES NOT, which is the right half to keep: "this input is named
 * api_key" is exactly the kind of thing a question about a form may need to say, and a name is
 * never itself the secret. Either side matching is enough to redact — a value that IS one of these
 * words (`name="password"`) is as much a giveaway as a name that is — except where the value is a
 * URL, which keeps its shape and loses only the offending parameter.
 */
export function redactSecrets(text: string): string {
  if (!SECRET.test(text)) return text;
  return text.replace(ASSIGNMENT, (match, name: string, sep: string, value: string) => {
    const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : "";
    const bare = quote === "" ? value : value.slice(1, -1);
    const trimmed = bare.replace(SECRET_PARAM, "$1$2=[redacted]");
    if (trimmed !== bare) return `${name}${sep}${quote}${trimmed}${quote}`;
    if (!SECRET.test(name) && !SECRET.test(bare)) return match;
    return `${name}${sep}${quote}[redacted]${quote}`;
  });
}

function cut(value: JsonValue | undefined, max: number): string {
  const text = jsonStringField(value) ?? "";
  return text.length > max ? text.slice(0, max) : text;
}

/** A capped, redacted string — everything that came out of the page goes through here. */
function safe(value: JsonValue | undefined, max: number): string {
  return redactSecrets(cut(value, max));
}

function stringList(value: JsonValue | undefined, max: number, count: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= count) break;
    const text = safe(item, max);
    if (text !== "") out.push(text);
  }
  return out;
}

function readBox(value: JsonValue | undefined): ProbeBox {
  const row = jsonRecord(value);
  const n = (key: string) => Math.round(jsonNumberField(row?.[key]) ?? 0);
  return { x: n("x"), y: n("y"), width: n("width"), height: n("height") };
}

function readStyles(value: JsonValue | undefined): ProbeStyles {
  const row = jsonRecord(value);
  if (row === null) return {};
  const out: Record<string, string> = {};
  let seen = 0;
  for (const key of Object.keys(row)) {
    if (seen >= CAP.styleCount) break;
    // The key becomes a label the phone renders; anything that is not a CSS property name is not
    // one this module has any reason to carry.
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,40}$/u.test(key)) continue;
    const text = safe(row[key], CAP.styleValue);
    if (text === "") continue;
    out[key] = text;
    seen++;
  }
  return out;
}

/**
 * The command's JSON as the phone's body, or null when the text is not the JSON this module knows.
 *
 * Every field is NAMED. A field the command grows tomorrow is not copied, which is what makes the
 * budgets above an upper bound on what a pane can be told rather than a suggestion.
 */
export function normaliseProbe(text: string): ProbeResponse | null {
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse of text yields exactly the JSON value space; every field is then narrowed
    // through the readers above before it becomes a domain value.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  const root = jsonRecord(parsed);
  if (root === null) return null;
  const tag = jsonStringField(root.tag);
  if (tag === null || !/^[a-zA-Z][a-zA-Z0-9-]{0,40}$/u.test(tag)) return null;
  const body: ProbeResponse = {
    ok: true,
    tag: tag.toLowerCase(),
    id: safe(root.id, 200) || null,
    classes: safe(root.classes, CAP.classes),
    selector: safe(root.selector, CAP.selector),
    elementPath: safe(root.elementPath, CAP.path),
    text: safe(root.text, CAP.text),
    box: readBox(root.box),
    role: safe(root.role, CAP.a11y),
    accessibleName: safe(root.accessibleName, CAP.a11y),
    computedStyles: readStyles(root.computedStyles),
    htmlSnippet: safe(root.htmlSnippet, CAP.html),
    nearbyText: stringList(root.nearbyText, CAP.nearbyText, CAP.nearbyTextCount),
    nearbyElements: stringList(root.nearbyElements, CAP.nearbyElement, CAP.nearbyElementCount),
    url: safe(root.url, CAP.url),
  };
  const react = safe(root.reactComponents, CAP.react);
  if (react !== "") body.reactComponents = react;
  // Omitted rather than guessed when the page resolved nothing — see the command's own note. A
  // guessed path sends the agent to edit a file that may have nothing to do with what is on screen.
  const source = safe(root.sourceFile, CAP.source);
  if (source !== "") body.sourceFile = source;
  return body;
}

// ── The runner ────────────────────────────────────────────────────────────────────────────────

export type ShotFailure =
  | "not_configured"
  | "bad_url"
  | "failed"
  | "timeout"
  | "too_large"
  | "unparsable";

/** A finite, rounded number inside [min, max]. A phone that sent nonsense gets the floor. */
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : 0)));
}

/** The viewport the operator asked for, clamped to something a browser can actually lay out. */
function clampViewport(width: number, height: number): Viewport {
  return { width: clampNumber(width, 200, 2560), height: clampNumber(height, 200, 4096) };
}

/** A tap coordinate as the command's argv wants it: a whole number inside the viewport. */
function pointArg(value: number, max: number): string {
  return String(clampNumber(value, 0, max));
}

export type ShotResult = { ok: true; body: ShotResponse } | { ok: false; reason: ShotFailure };
export type ProbeResult = { ok: true; body: ProbeResponse } | { ok: false; reason: ShotFailure };

export interface ShotRunnerOptions {
  deadlineMs?: number;
  warn?: (message: string) => void;
}

/**
 * One command, two verbs, no state. The argv is the operator's; everything appended to it is a
 * number this module bounded or a URL {@link allowedShotUrl} accepted.
 */
export class ShotRunner {
  private readonly deadlineMs: number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly argv: readonly string[],
    private readonly hosts: readonly string[] = [],
    private readonly io: ShotIo = spawnShotIo,
    opts: ShotRunnerOptions = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? SHOT_DEADLINE_MS;
    this.warn = opts.warn ?? ((message) => console.warn(`[shot] ${message}`));
  }

  async shot(rawUrl: string, width: number, height: number, dpr: number): Promise<ShotResult> {
    const url = allowedShotUrl(rawUrl, this.hosts);
    if (url === null) return { ok: false, reason: "bad_url" };
    const vp = clampViewport(width, height);
    const scale = Math.min(3, Math.max(1, Math.round(Number.isFinite(dpr) ? dpr : 2)));
    const run = await this.spawn(["shot", url, String(vp.width), String(vp.height), String(scale)]);
    if (!run.ok) return run;
    const mime = shotImageMime(run.stdout);
    if (mime === null) {
      // Not an image. The bytes are DISCARDED rather than described: a command that printed an
      // error message onto stdout would otherwise have written that message into a response body.
      this.warn(`${this.argv[0]} printed something that is not a PNG or a WebP`);
      return { ok: false, reason: "unparsable" };
    }
    if (run.stdout.byteLength > SHOT_IMAGE_CAP) {
      this.warn(`${this.argv[0]} returned ${run.stdout.byteLength} bytes, over the ${SHOT_IMAGE_CAP} cap`);
      return { ok: false, reason: "too_large" };
    }
    return {
      ok: true,
      body: {
        ok: true,
        image: shotDataUrl(run.stdout, mime),
        mime,
        width: vp.width,
        height: vp.height,
        dpr: scale,
        url,
      },
    };
  }

  async probe(rawUrl: string, width: number, height: number, x: number, y: number, dpr: number): Promise<ProbeResult> {
    const url = allowedShotUrl(rawUrl, this.hosts);
    if (url === null) return { ok: false, reason: "bad_url" };
    const vp = clampViewport(width, height);
    const scale = Math.min(3, Math.max(1, Math.round(Number.isFinite(dpr) ? dpr : 2)));
    const run = await this.spawn([
      "probe",
      url,
      String(vp.width),
      String(vp.height),
      pointArg(x, vp.width),
      pointArg(y, vp.height),
      String(scale),
    ]);
    if (!run.ok) return run;
    const body = normaliseProbe(new TextDecoder().decode(run.stdout));
    if (body === null) {
      this.warn(`${this.argv[0]} printed something that is not its JSON`);
      return { ok: false, reason: "unparsable" };
    }
    return { ok: true, body };
  }

  /** The shared half: run the argv, judge the exit, and never quote its output in the reason. */
  private async spawn(args: readonly string[]): Promise<{ ok: true; stdout: Uint8Array } | { ok: false; reason: ShotFailure }> {
    let run: ShotRun;
    try {
      run = await this.io.run([...this.argv, ...args], this.deadlineMs);
    } catch {
      run = { code: 1, stdout: new Uint8Array(), timedOut: false };
    }
    if (run.timedOut) {
      this.warn(`${this.argv[0]} did not finish within ${this.deadlineMs}ms`);
      return { ok: false, reason: "timeout" };
    }
    if (run.code === null) {
      // Killed without timing out is the byte cap; the bytes are already discarded by the reader.
      this.warn(`${this.argv[0]} printed more than ${SHOT_OUTPUT_CAP} bytes`);
      return { ok: false, reason: "too_large" };
    }
    if (run.code !== 0) {
      // Exit 2 is the command's own refusal of a URL — the same verdict this module reaches, which
      // is what makes the two enforcers checkable against each other.
      const reason: ShotFailure = run.code === 2 ? "bad_url" : "failed";
      this.warn(`${this.argv[0]} exited ${run.code}`);
      return { ok: false, reason };
    }
    return { ok: true, stdout: run.stdout };
  }
}
