// Which autolinked URL opens INSIDE the app, and which stays an ordinary external link.
//
// lib/links.ts finds the URLs in the mirror; this module answers the single question the renderer
// has about each one afterwards: can Collie show this without leaving the PWA? Exactly one family
// of URL can — the operator's knowledge base, `https://<kb host>/d/<slug>` — because only for those
// does the bridge have a route of its OWN that fetches the document over loopback and serves it
// back same-origin. Everything else is `external`, and the anchor keeps the `target="_blank"` it
// has today, untouched.
//
// ── WHY A LOCAL PATH INSTEAD OF FRAMING THE REAL URL ─────────────────────────────────────────────
// Because framing the real URL does not work, and the reason is not fixable from here. Six
// representative targets were measured — github.com, developer.mozilla.org, docs.anthropic.com,
// news.ycombinator.com, stackoverflow.com and the operator's own knowledge.agnex.dev — and all six
// refuse to be framed. The operator's own services are the worst case rather than the easy one:
// they sit behind Cloudflare Access, Safari blocks third-party cookies, so a cross-origin frame
// would arrive unauthenticated and be handed the Access login page — which itself refuses framing.
// So an in-app view has to be Collie's own origin serving its own bytes, and this module's job is
// only to recognise the URLs the bridge is willing to do that for.
//
// ── EVERY REJECTION IS FREE; A WRONG ACCEPT IS NOT ───────────────────────────────────────────────
// This asymmetry decides every rule below. A URL this module declines is still a working link: the
// tap falls through to Safari and the operator sees the page they asked for. A URL it accepts by
// mistake is Collie fetching something on the operator's behalf and painting it inside the app's own
// chrome, where it reads as Collie's content and not as a stranger's. There is therefore no rule
// here worth relaxing for convenience — when in doubt, be an external link.
//
// ── FORK: A SECOND FAMILY THAT OPENS IN-APP, AND THE SAME ASYMMETRY DECIDES IT ──────────────────
// An HTML file the agent WROTE — announced as `/Users/op/proj/report.html` or as a `file://` URL —
// is the other thing this bridge can serve from its own origin (`/api/preview/file`,
// bridge/preview.ts). It is admitted under a STRICTER rule than the knowledge base's, because a
// path has no host to be wrong about: the path must be absolute, must end `.html`/`.htm`, must
// carry no `..`, `.git`, NUL or `%`, and must lie inside the CWD OF THE PANE the operator is
// looking at. A caller that passes no cwd recognises none of it — the feature is absent, not broken.
//
// The module is pure and import-free, like lib/links.ts: given a string, a list of hostnames and a
// directory it returns a verdict, and it never touches the network, the DOM, or configuration.

/**
 * The verdict on one href.
 *
 * A discriminated union rather than `string | null` so the caller cannot accidentally treat "not a
 * document" as a falsy path and navigate to `""`; the `external` arm carries nothing because there
 * is nothing to say about it — the anchor already knows how to open an external link.
 */
export type DocLinkTarget =
  /**
   * A knowledge-base document Collie can serve itself. `path` is origin-relative and ready to put
   * in an iframe `src`; `slug` is the document's identity, for anything the caller wants to key or
   * label by (a sheet title, a "reopen the same doc" check).
   */
  | { kind: "doc"; slug: string; path: string }
  /**
   * FORK: an HTML file the agent WROTE, inside the pane's own working directory, which this bridge
   * can serve back over `/api/preview/file` (bridge/preview.ts). `path` is the absolute path on the
   * answering machine's disk — NOT a URL — because that is what the route takes and what the jail
   * compares; the caller pairs it with the pane whose cwd it was validated against.
   */
  | { kind: "preview"; path: string }
  /** Anything else. Open it the way links have always opened: a new tab, out of the app. */
  | { kind: "external" };

/**
 * The path prefix Collie reserves for a proxied document, matching the bridge route the integrator
 * wires up. The value is part of the contract between the two, which is why it is a named export
 * rather than a literal spelled out at both ends.
 *
 * It lives under `/api/` deliberately, and not because a document is an API response. Two things
 * come free there and cost real work anywhere else:
 *
 *   - The service worker precaches the app shell and answers EVERY navigation from it unless the
 *     path is denylisted (lib/sw-routes.ts, NAVIGATION_NETWORK_ONLY). An iframe load is a navigation
 *     — `request.mode === "navigate"` — so a document served from, say, `/doc/<slug>` would be
 *     answered with Collie's own HTML shell inside the panel, offline and online alike. `/^\/api\//`
 *     is already on that list.
 *   - `/api/` is already behind the bridge's device guard, so the document inherits the same
 *     authentication as every other route instead of needing a second answer to "who is asking".
 */
export const DOC_PROXY_PATH = "/api/doc/";

/**
 * FORK: the route that serves an agent-written HTML file back from Collie's own origin
 * (bridge/preview.ts). Under `/api/` for `DOC_PROXY_PATH`'s reason and not a second one — an
 * iframe's document load is a navigation, and `/^\/api\//` is what the service worker already
 * passes to the network.
 *
 * The pane and the path ride the QUERY rather than the path, because the jail is that pane's own
 * `cwd`: a preview with no pane has no directory to be inside, so there is no such request to make.
 * The two halves are pinned against each other by bridge/preview.test.ts.
 */
export const PREVIEW_PROXY_PATH = "/api/preview/file";

/** FORK: the URL the panel's iframe loads for one previewed file on one pane. */
export function previewSrc(paneId: string, path: string): string {
  const params = new URLSearchParams({ pane: paneId, path });
  return `${PREVIEW_PROXY_PATH}?${params.toString()}`;
}

/**
 * The knowledge base's own document path. Not configurable: it is the kb's URL layout, the same one
 * its CLI builds when it prints a link (`<api_url minus /api>/d/<slug>`), so an operator who changed
 * it would have a kb that no longer matches its own tooling.
 */
const KB_DOC_PREFIX = "/d/";

/**
 * The hostnames recognised when the caller has nothing better. Exported as a starting value the
 * integrator can fall back to — it is NOT applied implicitly, because a default that switches
 * itself on when configuration is missing is a default nobody can turn off. `classifyDocLink` takes
 * its hosts as an argument and an empty list recognises nothing, so a bridge that publishes no kb
 * host produces a build where every link is simply external. That is the correct fail direction:
 * the feature is absent, not broken (the same argument lib/mux-capability.ts makes for an absent
 * logo — an empty answer means render nothing, not render an error).
 */
export const DEFAULT_DOC_HOSTS = ["knowledge.agnex.dev"] as const;

/**
 * A valid kb slug, character for character the constraint the kb's own database enforces:
 * `CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$')` (knowledge-system db/schema.sql, documents.slug).
 *
 * Copied rather than loosened, because the charset is doing security work as a side effect of being
 * accurate. It admits no `/`, no `%`, no `.`, no `:` and no `\` — which is why the path segment is
 * validated RAW and never percent-decoded. Decoding first and validating after is the classic
 * ordering bug: `/d/foo%2F..%2Fbar` decodes into a path traversal, and by then the validator is
 * looking at a string the URL never contained. Undecoded, that segment simply fails on `%`.
 *
 * There is deliberately no length cap. The kb stores slugs as unbounded TEXT, so any number chosen
 * here would be a rule Collie invented and would eventually reject a real document; length is not
 * a safety dimension once the charset excludes every structural character.
 */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** One shared value: every non-document answer is the same answer, and it carries no state. */
const EXTERNAL: DocLinkTarget = { kind: "external" };

/**
 * FORK: the extensions the preview route serves, lowercase. The bridge's `PREVIEW_EXTS`, restated —
 * a client looser than the bridge produces a tappable link that always fails, which is the shape a
 * user reports as "the panel is broken".
 */
const PREVIEW_EXTS = [".html", ".htm"] as const;

/**
 * FORK: whether `path` is an absolute POSIX path this client will offer to the preview route.
 *
 * The same closed rule bridge/preview.ts's `isPreviewPath` applies, minus the relative form — a
 * string reaching this function has to be absolute to be comparable against a cwd at all, and a
 * relative one is ambiguous about which directory it is relative to. No `..`, no `.git`, no NUL, no
 * `%` (nothing is ever percent-decoded here, so a `%` that survives is a literal one and no
 * previewable file has ever had one), and an `.html`/`.htm` ending.
 */
function isPreviewablePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("%")) return false;
  if (path.split("/").some((segment) => segment === ".." || segment === ".git")) return false;
  const lower = path.toLowerCase();
  return PREVIEW_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * FORK: whether `path` lies inside `cwd`, as strings that are both already absolute.
 *
 * A string comparison, exactly as the bridge's `withinRoot` is, and it carries the same caveat: it
 * cannot see through a symlink. That is not a weakness HERE, because this side is only deciding
 * whether to OFFER the tap — the bridge realpaths both ends and refuses the escape for real. The
 * separator is appended so `/home/op/proj` does not contain `/home/op/project`.
 */
function insideCwd(path: string, cwd: string): boolean {
  if (cwd === "" || !cwd.startsWith("/")) return false;
  const root = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return path.startsWith(`${root}/`);
}

/**
 * FORK: the `preview` verdict for a bare absolute path or a `file://` URL, or null when neither.
 *
 * `cwd` is the pane's own working directory and an empty one recognises NOTHING — the same fail
 * direction `hosts` has above, and for the same reason: a default that switches itself on when
 * configuration is missing is a default nobody can turn off. A phone that has not yet loaded a pane
 * simply sees external links, which is what it saw before this feature existed.
 *
 * `file://` is admitted because it is what a tool prints when it wants a path to be clickable, and
 * it is EXACTLY as safe as the bare path it wraps: the URL parser hands back an already-decoded
 * pathname, the host must be empty or `localhost` (a `file://server/share` UNC path is somebody
 * else's machine), and everything after that is the same grammar and the same containment.
 */
function previewTarget(href: string, cwd: string): DocLinkTarget | null {
  let path = href;
  if (href.startsWith("file:")) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    // A UNC-style `file://host/share` names another machine; `file:///…` and `file://localhost/…`
    // are the two spellings of "this one".
    if (url.host !== "" && url.host !== "localhost") return null;
    if (url.search !== "" || url.hash !== "") return null;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  if (!isPreviewablePath(path) || !insideCwd(path, cwd)) return null;
  return { kind: "preview", path };
}

/**
 * Decide what tapping `href` should do.
 *
 * `hosts` is the set of hostnames whose documents Collie may serve itself — bare hostnames, compared
 * case-insensitively against the parsed URL's host and nothing else. Passing an empty list is a
 * legitimate call meaning "recognise nothing".
 *
 * What it refuses, and why each one is a real hazard rather than pedantry:
 *
 *   - **Anything but `https`.** Not a downgrade check for its own sake: the kb is only ever reached
 *     over TLS, and its CLI only ever prints `https://`, so an `http://` URL bearing the kb's host
 *     is by construction something the kb did not print. Admitting it would mean the one place
 *     Collie decides to render content in its own chrome trusts a string that any hop could have
 *     rewritten. It is also, as in lib/links.ts, the whole scheme story in one line — `javascript:`
 *     and `data:` are not filtered out later, they simply never reach the host check.
 *   - **A host that is not exactly one of `hosts`.** Never a suffix or prefix test.
 *     `hostname.endsWith("knowledge.agnex.dev")` also accepts `evil-knowledge.agnex.dev`, and a
 *     `startsWith` accepts `knowledge.agnex.dev.attacker.com`; both are hostnames anybody can
 *     register. The failure they produce is worse than a wrong page: the URL the operator READ said
 *     one host, and Collie would quietly show them the local document of that slug instead — a
 *     stranger's link turned into an authoritative-looking in-app view of the operator's own notes.
 *     A trailing-dot FQDN (`knowledge.agnex.dev.`) is rejected by the same equality, and correctly
 *     so: it is a distinct browser origin, whatever DNS thinks of it.
 *   - **Userinfo.** `https://knowledge.agnex.dev@evil.com/d/x` is caught by the host check anyway,
 *     but its mirror image is not: `https://evil.com@knowledge.agnex.dev/d/x` parses to the right
 *     host and would be accepted. It reads as evil.com to a human skimming the terminal, which is
 *     the entire point of writing it that way, so a URL carrying credentials is refused outright —
 *     a kb link never has any.
 *   - **An explicit non-default port.** A different port is a different service. `:443` survives
 *     because the URL parser normalises it away; it names the same endpoint.
 *   - **A query string.** The kb prints bare `/d/<slug>`, so a query is already not that URL, and
 *     the bridge route takes only a slug — there is nowhere to forward one. Silently dropping it
 *     would mean opening a different URL from the one the operator tapped, which for
 *     `?next=https://evil.com` is precisely the confusion to avoid. The fragment is kept instead,
 *     and the asymmetry is deliberate: a fragment addresses a position inside the document, never
 *     reaches the network, and is the one part of a kb link a human plausibly appends by hand.
 *
 * The returned `path` is origin-RELATIVE by construction. Nothing from the input can steer it to
 * another origin: it is a fixed prefix, a slug that matched {@link SLUG}, and the parser's own
 * already-percent-encoded fragment.
 */
export function classifyDocLink(href: string, hosts: readonly string[], cwd = ""): DocLinkTarget {
  // FORK: the preview arm runs FIRST and on the raw string, because the two shapes it recognises are
  // the two this function used to drop on the floor — a bare absolute path is not a URL at all, and
  // `file:` would be refused by the https check below. It is gated on `cwd`, so a caller that passes
  // none (every caller outside the pane view) gets exactly today's two answers.
  const preview = previewTarget(href, cwd);
  if (preview !== null) return preview;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // Relative, malformed, or otherwise unparseable. lib/links.ts only ever produces absolute
    // http(s) URLs, but this function is also reachable from anything else holding an href.
    return EXTERNAL;
  }

  if (url.protocol !== "https:") return EXTERNAL;
  if (url.username !== "" || url.password !== "") return EXTERNAL;
  if (url.port !== "") return EXTERNAL;
  if (url.search !== "") return EXTERNAL;

  // `url.hostname` is already lowercased and punycoded by the parser; the configured side may be
  // hand-typed or come from a config file, so it is normalised here rather than trusted.
  const host = url.hostname;
  if (!hosts.some((h) => h.trim().toLowerCase() === host)) return EXTERNAL;

  if (!url.pathname.startsWith(KB_DOC_PREFIX)) return EXTERNAL;
  const slug = url.pathname.slice(KB_DOC_PREFIX.length);
  if (!SLUG.test(slug)) return EXTERNAL;

  // `url.hash` is "" or "#…", already percent-encoded for the fragment set by the parser — taken
  // from the parsed URL and never sliced out of the raw input, so nothing that could break out of
  // an attribute survives into the path.
  return { kind: "doc", slug, path: `${DOC_PROXY_PATH}${slug}${url.hash}` };
}
