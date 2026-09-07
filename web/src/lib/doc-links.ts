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
// The module is pure and import-free, like lib/links.ts: given a string and a list of hostnames it
// returns a verdict, and it never touches the network, the DOM, or configuration.

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
export function classifyDocLink(href: string, hosts: readonly string[]): DocLinkTarget {
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
