import { lineText, type StyledLine } from "@/lib/blocks";
import { findLinks } from "@/lib/links";

// FORK. What a mirror line earns a chip for.
//
// ── WHY A CHIP AND NOT A LINK ───────────────────────────────────────────────────────────────────
// lib/links.ts:19-26 already settled the general question and this module does not reopen it:
// terminal output is dense with dotted tokens, a host-shaped heuristic turns file names and
// versions into links you cannot select as text, and an explicit scheme is the only unambiguous
// signal. A chip is the answer that respects all of that — it rides BESIDE the line rather than
// wrapping any of its characters, so the text stays exactly as selectable and as copyable as it was,
// and the shared find/link offset space does not move by one character (`CopyFenceButton`'s shape:
// "a button is not text").
//
// ── THE FILE CHIP IS A LOOKUP, NOT A HEURISTIC ──────────────────────────────────────────────────
// A path detector over terminal output has a far worse false-positive rate than a scheme does —
// every `node_modules/x`, every `a/b.c` in prose, every version string. So this one never guesses:
// it is handed the pane's OWN diff file list, which the sheet has already fetched, and it offers a
// chip only when one of those exact strings appears verbatim on the line. The false-positive rate
// is therefore zero by construction, and a pane whose list has not arrived (or which is not a work
// tree at all) simply gets no file chips.
//
// Pure and offset-free: this module returns per-line verdicts and never a node, so the renderer
// keeps deciding what a chip looks like and where it sits.

/** The one URL this line offers, and whether it names a server on this machine. */
export interface UrlChip {
  href: string;
  /**
   * The URL is `http(s)://localhost:PORT` (or a loopback literal) — a dev server the agent just
   * started, rather than a page on the internet. The chip says "Preview" instead of "Open", and the
   * tap additionally hands the URL to whatever the app has arranged to do with a local server.
   */
  local: boolean;
}

/** What one mirror line earns. Both halves are optional and a line usually earns neither. */
export interface LineChips {
  url?: UrlChip;
  /** A path from the pane's diff file list, exactly as it appears in that list. */
  path?: string;
}

/**
 * The hostnames that mean "this machine".
 *
 * Exact forms only, and the same three bridge/docs.ts's `KB_LOOPBACK_HOSTNAME` names — the point is
 * not to enumerate 127.0.0.0/8, it is that anything else is somebody else's server and gets the
 * ordinary Open chip. `[::1]` carries its brackets because that is what `URL.hostname` hands back.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/u;

/** Whether `href` names a port on this machine — a dev server, not a page on the web. */
export function isLocalServerUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // Userinfo is refused for lib/doc-links.ts's reason: `https://evil.test@localhost:5173/` reads as
  // evil.test to a human skimming the terminal, which is the entire point of writing it that way.
  if (url.username !== "" || url.password !== "") return false;
  // A port is what makes this a dev server rather than the operator's own hosts file. Bare
  // `http://localhost/` is a real address but not the thing this chip is for.
  if (url.port === "") return false;
  return LOOPBACK.test(url.hostname);
}

/**
 * The shortest path the chip will offer.
 *
 * `git status` can name a one- or two-character path (`x`, `go.sum` is longer but `Ω` exists), and a
 * one-character path would match somewhere on almost every line of prose. Three is the floor at
 * which a verbatim match stops being an accident; below it the operator can still reach the file
 * through the diff sheet, which is one tap away.
 */
const MIN_PATH_CHARS = 3;

/**
 * The chips for each line of a block, index for index.
 *
 * `paths` is the pane's diff file list. It is consulted longest-first so that `src/app/main.ts`
 * wins over `main.ts` on a line carrying the full path — the more specific match is the one the
 * operator meant, and offering the shorter one would open a different file.
 *
 * At most ONE url chip and ONE file chip per line, and the first of each wins. A line naming three
 * files is a `git status` summary the diff sheet already draws better, and three chips on one row of
 * an 84-column mirror is not a row anybody can read.
 */
export function lineChips(
  lines: readonly StyledLine[],
  paths: readonly string[] = [],
): (LineChips | null)[] {
  // Sorted once per call rather than once per line. The list is capped at 500 by the bridge
  // (`DIFF_FILE_CAP`), so this is bounded work on a list that changes only when the tree does.
  const ranked = paths
    .filter((p) => p.length >= MIN_PATH_CHARS)
    .toSorted((a, b) => b.length - a.length);
  return lines.map((line) => {
    const text = lineText(line);
    if (text === "") return null;
    const link = findLinks(text)[0];
    const path = ranked.find((p) => text.includes(p));
    if (link === undefined && path === undefined) return null;
    const chips: LineChips = {};
    if (link !== undefined) chips.url = { href: link.href, local: isLocalServerUrl(link.href) };
    if (path !== undefined) chips.path = path;
    return chips;
  });
}
