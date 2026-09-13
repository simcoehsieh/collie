import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { withinRoot } from "./dirs.ts";
import { DOCUMENT_CSP } from "./docs.ts";

// FORK. An HTML file the agent WROTE, opened in a panel beside the terminal.
//
// ── WHY IT IS A ROUTE AND NOT A LINK ────────────────────────────────────────────────────────────
// The agent finishes, says "I wrote the report to ~/work/report.html", and on a phone that sentence
// is a dead end: there is no file manager in an installed PWA, `file://` is unreachable from a
// web origin, and the machine holding the bytes is at the other end of a Cloudflare tunnel. The
// bridge is already on that machine and already reads the pane's cwd, so it can simply hand the
// bytes back — which is the same argument bridge/diff.ts makes about `git`.
//
// ── THE POLICY IS bridge/docs.ts's, IMPORTED RATHER THAN COPIED ─────────────────────────────────
// {@link DOCUMENT_CSP} is not "a good starting point" that was then adapted — it is THE policy, the
// same string object, because the two surfaces pose the identical question: HTML that an agent
// wrote, served from Collie's own origin, into a frame. Copying it would produce two policies that
// agree today and drift the first time either is touched, and the drift would be invisible (a
// `sandbox` that quietly gained `allow-scripts` on one surface fails nothing). bridge/preview.test.ts
// pins the literal a second time, so a relaxation made for the knowledge base fails this module's
// test too and has to be argued twice.
//
// The three clauses that matter most here, restated because THIS surface is the one where they will
// be questioned first: `sandbox` with no tokens drops the page into an opaque origin, so a report an
// agent generated out of things it read on the web cannot reach Collie's `localStorage` or call
// `/api/*` with the Access cookie attached; `frame-ancestors 'self'` is not inherited from the app's
// own CSP and reusing that constant would end in `'none'` and blank the panel with nothing in any
// log; and `default-src 'none'` is why a LIVE dev server cannot be served here at all — `/@vite/client`
// and the HMR socket are refused by it, and relaxing the policy to admit them is a different feature
// with a different threat model (an allowlisted port, an opaque origin, and its own argument).
//
// ── THE JAIL IS THE PANE'S OWN cwd, WHICH IS NARROWER THAN THE ONE NEXT DOOR ────────────────────
// bridge/diff.ts jails to the repo the pane sits in; bridge/dirs.ts jails to the operator's home.
// This jails to the pane's `cwd` (AgentView.cwd) and nothing above it, which is narrower than either
// and free: the thing being previewed is a file the agent in THAT pane just wrote, so anything
// outside the directory it is working in is, by construction, not it. Home is still checked first,
// because a cwd is a value from the multiplexer and the rule that a bridge path lands inside the
// operator's home holds for every route regardless of what it is jailed to afterwards.

/**
 * The path the bridge answers a preview on.
 *
 * UNDER `/api/`, for bridge/docs.ts's reason and not a second one: an iframe's document load is a
 * NAVIGATION, and the service worker answers navigations from the precached app shell unless the
 * path is on `NAVIGATION_NETWORK_ONLY` (web/src/lib/sw-routes.ts) — where `/^\/api\//` already is.
 * A prettier `/preview/` would render a second copy of Collie inside the panel, and would have
 * looked perfectly fine in a browser tab with no service worker.
 *
 * Spelled here AND as a literal in server.ts's route, on purpose and for docs.ts's reason: the route
 * golden in solo-baseline.test.ts finds routes by reading server.ts for string literals, so a
 * registration that imported this constant would silently escape the one test whose job is that a
 * route arrives on purpose.
 */
export const PREVIEW_PATH = "/api/preview/file";

/**
 * The largest page this route will serve. The knowledge base's ceiling, restated — the corpus these
 * previews come from is the same `html-presentation` shape as a kb document (inline `<style>`,
 * base64 `data:` images), so the number that bounds one bounds the other.
 */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

/**
 * The policy the previewed page is served under: bridge/docs.ts's, unchanged.
 *
 * An alias rather than a copy — see this module's header for why the two surfaces share one policy
 * object instead of two strings that happen to match.
 */
export const PREVIEW_CSP = DOCUMENT_CSP;

/** The headers a served preview carries beyond `secure()`'s — the document route's four, exactly. */
export type PreviewHeaders = {
  "content-type": string;
  "cache-control": string;
  "content-security-policy": string;
  etag: string;
  // Intersected with an index signature for `documentResponseHeaders`'s reason: an INTERFACE has no
  // implicit one, so `new Response(body, { headers })` refuses it as a `HeadersInit`.
} & Record<string, string>;

/**
 * The headers for one served preview.
 *
 * `content-type` is the literal and is never derived from the filename: the grammar only ever admits
 * an `.html`/`.htm`, so a mapped type could only be a way to be wrong, and these bytes are going
 * into a frame as HTML either way. `no-cache` + a strong ETag is the house rule for bytes that are
 * not content-addressed — and it is what makes the panel's Reload button honest: the agent rewrites
 * the file, the operator taps Reload, the tag misses and the new page arrives. A `max-age` would
 * mean a Reload that could not reload.
 */
export function previewResponseHeaders(etag: string): PreviewHeaders {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "content-security-policy": PREVIEW_CSP,
    etag,
  };
}

/**
 * The extensions this route will serve, lowercase, dot included.
 *
 * A closed set, and the closure is doing real work: the response labels its body `text/html` and
 * drops it into a frame, so "which files may become a page" has to be decided by the grammar rather
 * than by what happens to be on disk. A `.js`, a `.env` or a private key served as HTML would be a
 * file-disclosure route wearing a preview's name.
 */
const PREVIEW_EXTS = [".html", ".htm"] as const;

/**
 * Whether `path` is one this route will turn into a filesystem read.
 *
 * Lexical, total, and checked BEFORE anything is resolved. What each refusal is actually for:
 *
 *   - **empty, or a NUL byte.** A NUL truncates in some readers and does not in others, which is the
 *     whole reason a path carrying one never becomes a path here.
 *   - **a `%`.** Nothing is ever percent-DECODED on the way to this function — the query parser has
 *     already done that once, and a second decode is precisely the step that turns `%2f` into a
 *     separator. So a `%` that survives into the decoded string is a literal one, no previewable
 *     file has ever had one in its name, and refusing it costs nothing while reasoning about it does
 *     not. (`%2e%2e%2f` in the URL arrives here as `../` and is refused by the next rule; a
 *     double-encoded `%252e%252e%252f` arrives as the literal `%2e%2e%2f` and is refused by this one.)
 *   - **a `..` or `.git` segment.** bridge/diff.ts's rule, for bridge/diff.ts's reasons.
 *   - **anything but `.html`/`.htm`.** See {@link PREVIEW_EXTS}.
 *
 * ABSOLUTE PATHS ARE ADMITTED, and that is the one place this grammar is looser than
 * `isRepoRelativePath` next door. An agent announces a preview by printing where it wrote the file,
 * and what it prints is `/Users/x/work/report.html` — a relative-only rule would refuse the form the
 * feature exists to accept. Nothing is bought by the refusal either: an absolute path is resolved
 * and then compared against the pane's cwd exactly as a relative one is, and the comparison is what
 * decides, not the shape of the string.
 */
export function isPreviewPath(path: string): boolean {
  if (path === "" || path.includes("\0") || path.includes("%")) return false;
  const segments = path.split(/[\\/]/u);
  if (segments.some((segment) => segment === ".." || segment === ".git")) return false;
  const lower = path.toLowerCase();
  return PREVIEW_EXTS.some((ext) => lower.endsWith(ext));
}

/** Why a preview could not be served. The route turns these into statuses; nothing else reads them. */
export type PreviewFailure = "bad_path" | "outside_root" | "not_found" | "too_large" | "unreadable";

/** One served preview: the bytes and the tag that names them. */
export interface PreviewBody {
  /** The RESOLVED path the bytes came from — never the string the client asked with. */
  path: string;
  html: string;
  bytes: number;
}

export type PreviewResult = { ok: true; body: PreviewBody } | { ok: false; reason: PreviewFailure };

/** The filesystem calls this module makes, injectable so every rule above is testable without one. */
export interface PreviewIo {
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile: () => boolean; size: number }>;
  read: (path: string) => Promise<Uint8Array>;
}

const diskIo: PreviewIo = {
  realpath,
  stat,
  read: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
};

/**
 * Read one HTML file the pane wrote, jailed to that pane's own `cwd`.
 *
 * Total: every failure is a `reason`, never a throw. The order is the argument — grammar, then the
 * cwd's own containment in home, then the target's containment in the cwd, then the size, and only
 * then the bytes. Nothing is read from disk until every question about WHERE has been answered, and
 * the size is asked of `stat` rather than discovered by reading, so an oversized file costs a stat.
 */
export async function readPreview(
  cwd: string,
  path: string,
  home: string,
  io: PreviewIo = diskIo,
): Promise<PreviewResult> {
  if (!isPreviewPath(path)) return { ok: false, reason: "bad_path" };

  let homeResolved: string;
  let here: string;
  try {
    homeResolved = await io.realpath(home);
    here = await io.realpath(cwd);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  // The cwd is a value the multiplexer reported, not one the client sent — and it is checked anyway,
  // because "a trusted source" is the exception that stops a rule being checkable (bridge/docs.ts
  // makes the same argument about an id kb itself just sent).
  if (!withinRoot(here, homeResolved)) return { ok: false, reason: "outside_root" };

  // `resolve` handles both shapes the grammar admits: an absolute path is returned as itself, a
  // relative one is joined onto the cwd. Neither can carry a `..` past the grammar above.
  const target = resolve(here, path);
  let real: string;
  try {
    real = await io.realpath(target);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  // THE CONTAINMENT CHECK, on the real path and nothing else. A symlink inside the cwd that points
  // at `~/.ssh/id_rsa.html` — or at anything else — lands here as its target, which is the only
  // string worth comparing: every check before this one was about characters.
  if (!withinRoot(real, here) || real === here) return { ok: false, reason: "outside_root" };
  // The extension is re-asked of the RESOLVED name, because the link's own name is not its target's:
  // `report.html -> ../../secrets/key.pem` passes the grammar on the name the client typed.
  if (!isPreviewPath(real.split(sep).pop() ?? "")) return { ok: false, reason: "bad_path" };

  let meta: { isFile: () => boolean; size: number };
  try {
    meta = await io.stat(real);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  // A directory called `x.html` is not a page, and a device node is not one either.
  if (!meta.isFile()) return { ok: false, reason: "bad_path" };
  if (meta.size > MAX_PREVIEW_BYTES) return { ok: false, reason: "too_large" };

  let bytes: Uint8Array;
  try {
    bytes = await io.read(real);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // The size is re-measured rather than believed: `stat` and the read are two moments, and the
  // ceiling has to be about the bytes that are going out, not about the bytes that were there.
  if (bytes.byteLength > MAX_PREVIEW_BYTES) return { ok: false, reason: "too_large" };
  // Not `fatal: true`, and the difference from bridge/file-view.ts is deliberate: that route SHOWS
  // the text and a lone U+FFFD would read as corruption it caused, while this one hands the bytes to
  // a parser that has its own opinion about encoding. A page with one bad byte should still render.
  const html = new TextDecoder("utf-8").decode(bytes);
  return { ok: true, body: { path: real, html, bytes: bytes.byteLength } };
}
