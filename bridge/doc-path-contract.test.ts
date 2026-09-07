import { describe, expect, test } from "bun:test";

import { DOCUMENT_PATH_PREFIX, DOCUMENT_SLUG_PATTERN, documentSlugFromPath } from "./docs.ts";
import { DOC_PROXY_PATH, classifyDocLink } from "../web/src/lib/doc-links.ts";

// The document panel is implemented twice — the client decides which link becomes an in-app path
// (web/src/lib/doc-links.ts) and the bridge decides which path becomes a document (bridge/docs.ts) —
// and each half has its own tests, so either could be changed alone and stay green while the two
// drift apart. This is bridge/auth-path-contract.test.ts's argument applied to the second pair of
// halves in this repo that must agree, and it is here for the same reason: drift is SILENT.
//
// What silent looks like here. If the client's prefix leads the bridge's, the phone builds a path
// nothing routes: no handler matches, the SPA fallback answers with the app shell, and the panel
// renders a second copy of Collie inside itself — in a browser tab, with no service worker and no
// precache, that even looks plausible for a moment. If the grammars disagree instead, a link the
// client happily classifies as a document is refused by the bridge as a bad slug, and the operator
// gets "no such document" for a document that exists. Neither failure logs anything.
//
// It imports across the bridge/web boundary on purpose, exactly as the auth contract does:
// doc-links.ts is pure (no DOM, no React), which is why it is a lib module and not a hook.

const HOSTS = ["knowledge.agnex.dev"];

describe("the document path agrees across the client and the bridge", () => {
  test("the client builds paths the bridge routes", () => {
    // The one fact both files spell independently. Two constants, not one imported by both, because
    // the bridge's is ALSO spelled as a literal in server.ts for the route golden to find — so the
    // duplication is deliberate everywhere and this is the test that makes it safe.
    expect(DOC_PROXY_PATH).toBe(DOCUMENT_PATH_PREFIX);
  });

  // A slug the client extracts must survive the bridge's grammar, and back again. These are real
  // shapes from the operator's kb: a plain slug, one carrying a date (the convention for periodic
  // reports), and the single-character floor the pattern's first class allows.
  test.each([
    "herdr-interface-anatomy",
    "medium-digest-2026-08-16",
    "signal-scan-2026-07-09",
    "a",
  ])("a link to %s survives both halves", (slug) => {
    const target = classifyDocLink(`https://knowledge.agnex.dev/d/${slug}`, HOSTS);
    expect(target.kind).toBe("doc");
    if (target.kind !== "doc") return;
    expect(target.slug).toBe(slug);
    // The path the client hands the frame, fed back through the bridge's own reader: what comes out
    // must be the slug that went in, or the panel asks kb about something else entirely.
    expect(documentSlugFromPath(target.path)).toBe(slug);
  });

  // The refusals have to agree too, and in this direction specifically: anything the CLIENT would
  // send must be something the bridge accepts. A client stricter than the bridge only costs a link
  // that stays external; a client LOOSER than the bridge produces a tappable link that always
  // fails, which is the shape a user reports as "the panel is broken".
  test.each([
    "https://knowledge.agnex.dev/d/../healthz",
    "https://knowledge.agnex.dev/d/%2e%2e%2fhealthz",
    "https://knowledge.agnex.dev/d/UPPER",
    "https://knowledge.agnex.dev/d/-leading-hyphen",
    "https://knowledge.agnex.dev/d/a/b",
    "https://knowledge.agnex.dev/d/",
    "https://knowledge.agnex.dev/documents/x",
    "http://knowledge.agnex.dev/d/plain-http",
    "https://knowledge.agnex.dev.evil.test/d/suffix-match",
    "https://evil.test/d/wrong-host",
  ])("%s is refused by the client, so the bridge is never asked", (href) => {
    expect(classifyDocLink(href, HOSTS).kind).toBe("external");
  });

  test("the two grammars are the same grammar", () => {
    // Both files spell the kb's own `CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$')`, the bridge adding only
    // a length ceiling. Pinning the source string keeps a future loosening on one side from passing
    // as a widened feature: change one and this fails, which is the whole point.
    expect(DOCUMENT_SLUG_PATTERN).toBe("^[a-z0-9][a-z0-9-]{0,127}$");
    const overLong = "a".repeat(200);
    // The ceiling is the bridge's alone, and that asymmetry is safe in the direction it runs: the
    // client offers the link, the bridge refuses it, and the operator gets a 404 rather than the
    // bridge asking kb about a 200-character slug.
    expect(documentSlugFromPath(`${DOCUMENT_PATH_PREFIX}${overLong}`)).toBeNull();
  });
});
