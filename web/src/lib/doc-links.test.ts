import { describe, expect, it } from "vitest";

import { classifyDocLink, DEFAULT_DOC_HOSTS, DOC_PROXY_PATH } from "./doc-links";

describe("classifyDocLink", () => {
  const KB = "knowledge.agnex.dev";
  /** The verdict's discriminant alone, for the many cases whose whole claim is "not a document". */
  const kind = (href: string, hosts: readonly string[] = [KB]) =>
    classifyDocLink(href, hosts).kind;
  /** The local path, or null for an external verdict — so a path assertion needs no narrowing. */
  const pathOf = (href: string, hosts: readonly string[] = [KB]): string | null => {
    const target = classifyDocLink(href, hosts);
    return target.kind === "doc" ? target.path : null;
  };

  it("maps a knowledge-base document URL onto Collie's own same-origin path", () => {
    const target = classifyDocLink(`https://${KB}/d/medium-digest-2026-09-06`, [KB]);
    expect(target).toEqual({
      kind: "doc",
      slug: "medium-digest-2026-09-06",
      // Composed from the exported constant, not a literal: the bridge route and this path are one
      // contract, and a test that spelled it out again would keep passing while they drifted apart.
      path: `${DOC_PROXY_PATH}medium-digest-2026-09-06`,
    });
  });

  it("returns a path that is origin-relative, so nothing in the href can aim it elsewhere", () => {
    // If this ever became absolute, the whole same-origin argument for the panel would be void —
    // the iframe would be loading a stranger's origin under Collie's chrome.
    const path = pathOf(`https://${KB}/d/notes`);
    expect(path?.startsWith("/")).toBe(true);
    expect(path).not.toContain("://");
  });

  it("leaves every other site external — the caller's target=_blank behaviour is unchanged", () => {
    expect(kind("https://github.com/AltanS/collie")).toBe("external");
    expect(kind("https://developer.mozilla.org/en-US/docs/Web/API/URL")).toBe("external");
    expect(kind("https://news.ycombinator.com/item?id=1")).toBe("external");
  });

  // The load-bearing check. `endsWith(host)` accepts the first of these and `startsWith(host)` the
  // second; both hostnames are registrable by anyone. Accepting one means a link the operator read
  // as a stranger's site silently opens their own notes inside the app instead.
  it("matches the host exactly — a lookalike that merely contains it is external", () => {
    expect(kind(`https://evil-${KB}/d/notes`)).toBe("external");
    expect(kind(`https://${KB}.attacker.example/d/notes`)).toBe("external");
    expect(kind(`https://sub.${KB}/d/notes`)).toBe("external");
    expect(kind("https://agnex.dev/d/notes")).toBe("external");
  });

  // A root-anchored FQDN is a distinct browser origin however DNS resolves it, so treating it as the
  // configured host would be Collie disagreeing with the origin model it depends on.
  it("treats a trailing-dot FQDN as a different host", () => {
    expect(kind(`https://${KB}./d/notes`)).toBe("external");
  });

  it("accepts the host case-insensitively but the path case-sensitively", () => {
    // Hostnames are case-insensitive by spec; paths are not, and the kb serves lowercase `/d/`.
    // Folding the path's case would invent a slug the printed URL never named.
    expect(kind(`https://KNOWLEDGE.AGNEX.DEV/d/notes`)).toBe("doc");
    expect(kind(`https://${KB}/D/notes`)).toBe("external");
    expect(kind(`https://${KB}/d/Notes`)).toBe("external");
  });

  // The kb only ever speaks TLS and its CLI only ever prints https, so an http URL wearing the kb's
  // host is by construction not a URL the kb produced.
  it("accepts https only", () => {
    expect(kind(`http://${KB}/d/notes`)).toBe("external");
  });

  // Same story as lib/links.ts: a dangerous scheme is unreachable, not filtered. It fails the
  // protocol check before the host is ever consulted.
  it("never accepts a non-http scheme, whatever it claims about the host", () => {
    expect(kind(`javascript:alert(1)//${KB}/d/notes`)).toBe("external");
    expect(kind("data:text/html,<script>alert(1)</script>")).toBe("external");
    expect(kind(`file:///d/notes`)).toBe("external");
  });

  // `https://evil.example@knowledge.agnex.dev/d/x` parses to the RIGHT host — the host check alone
  // would pass it — while reading as evil.example to anyone skimming the terminal. That is the whole
  // reason userinfo is refused rather than ignored.
  it("refuses a URL carrying userinfo even when the host itself is correct", () => {
    expect(kind(`https://evil.example@${KB}/d/notes`)).toBe("external");
    expect(kind(`https://user:pw@${KB}/d/notes`)).toBe("external");
    expect(kind(`https://${KB}@evil.example/d/notes`)).toBe("external");
  });

  it("refuses an explicit port but keeps the redundant default one", () => {
    // A different port is a different service. `:443` is not — the URL parser normalises it away
    // before this code sees it, and rejecting it would refuse a URL naming the very same endpoint.
    expect(kind(`https://${KB}:8443/d/notes`)).toBe("external");
    expect(kind(`https://${KB}:443/d/notes`)).toBe("doc");
  });

  // Dropping the query silently would open a URL other than the one tapped — and for a query
  // carrying a second URL that is exactly the confusion the panel must not create. There is also
  // nowhere to forward it: the bridge route takes a slug and nothing else.
  it("refuses a query string, including one smuggling a second URL", () => {
    expect(kind(`https://${KB}/d/notes?next=https://evil.example`)).toBe("external");
    expect(kind(`https://${KB}/d/notes?x=1`)).toBe("external");
  });

  it("preserves a fragment so an anchor inside a long document still lands", () => {
    expect(classifyDocLink(`https://${KB}/d/notes#section-3`, [KB])).toEqual({
      kind: "doc",
      slug: "notes",
      path: `${DOC_PROXY_PATH}notes#section-3`,
    });
  });

  it("carries the fragment as the parser encoded it, never as raw input", () => {
    // The fragment ends up in an iframe `src`. Taking `url.hash` means the URL parser has already
    // percent-encoded the characters that could otherwise end an attribute early.
    expect(pathOf(`https://${KB}/d/notes#"><script>`)).toBe(
      `${DOC_PROXY_PATH}notes#%22%3E%3Cscript%3E`,
    );
  });

  it("requires the path to be exactly one document segment", () => {
    // Anything else is some other page of the kb — a folder listing, its search, its root — and none
    // of them is what the bridge's document route can serve.
    expect(kind(`https://${KB}/d/`)).toBe("external");
    expect(kind(`https://${KB}/d/notes/`)).toBe("external");
    expect(kind(`https://${KB}/d/notes/extra`)).toBe("external");
    expect(kind(`https://${KB}/docs/notes`)).toBe("external");
    expect(kind(`https://${KB}/notes`)).toBe("external");
    expect(kind(`https://${KB}/`)).toBe("external");
  });

  // The slug is validated RAW. Decoding first and validating after is the ordering that turns
  // `%2F..%2F` into a traversal the validator never sees; undecoded it fails on `%` alone.
  it("is not fooled by an encoded path separator or by dot segments", () => {
    expect(kind(`https://${KB}/d/notes%2F..%2Fadmin`)).toBe("external");
    expect(kind(`https://${KB}/d/%2e%2e%2fadmin`)).toBe("external");
    // `/d/../admin` is normalised to `/admin` by the URL parser before the prefix test runs, which
    // is why this asserts the verdict rather than trusting the prefix check to be reached at all.
    expect(kind(`https://${KB}/d/../admin`)).toBe("external");
  });

  it("enforces the kb's own slug charset, character for character", () => {
    // Mirrors documents.slug's CHECK constraint (^[a-z0-9][a-z0-9-]*$). A slug this rejects is one
    // the kb could not have minted, so the tap falling through to Safari costs nothing.
    expect(kind(`https://${KB}/d/a-valid-slug-2026`)).toBe("doc");
    expect(kind(`https://${KB}/d/-leading-dash`)).toBe("external");
    expect(kind(`https://${KB}/d/under_score`)).toBe("external");
    expect(kind(`https://${KB}/d/dotted.slug`)).toBe("external");
    expect(kind(`https://${KB}/d/spaced%20slug`)).toBe("external");
  });

  // The absent-configuration path. A bridge that publishes no kb host must produce a build where
  // every link is an ordinary external link — the feature is missing, not broken — so the default
  // constant must never apply itself behind the caller's back.
  it("recognises nothing when given no hosts", () => {
    expect(kind(`https://${KB}/d/notes`, [])).toBe("external");
    expect(kind(`https://${KB}/d/notes`, [""])).toBe("external");
    expect(kind(`https://${KB}/d/notes`, ["   "])).toBe("external");
  });

  it("normalises the configured hosts, which may be hand-typed", () => {
    expect(kind(`https://${KB}/d/notes`, ["  KNOWLEDGE.Agnex.DEV  "])).toBe("doc");
  });

  it("accepts more than one configured host", () => {
    const hosts = ["kb.example", KB];
    expect(kind("https://kb.example/d/notes", hosts)).toBe("doc");
    expect(kind(`https://${KB}/d/notes`, hosts)).toBe("doc");
    expect(kind("https://other.example/d/notes", hosts)).toBe("external");
  });

  it("survives an href that is not a URL at all", () => {
    // lib/links.ts only emits absolute http(s) URLs, but the classifier is reachable from any href
    // and must answer rather than throw — a thrown error here would break the tap entirely.
    expect(kind("/d/notes")).toBe("external");
    expect(kind("not a url")).toBe("external");
    expect(kind("")).toBe("external");
  });

  // ── FORK: the preview arm ────────────────────────────────────────────────────────────────────
  //
  // A second family opens in-app: an HTML file the AGENT wrote, which the bridge serves back from
  // its own origin (`/api/preview/file`). The same asymmetry the module's header states decides
  // every case here — a rejection costs a link that stays external, an accept is Collie painting
  // somebody's file inside its own chrome — and the jail is one directory rather than a host list,
  // so the rules are tighter rather than looser.
  describe("the preview arm", () => {
    const CWD = "/home/op/proj";
    /** The verdict for a path against this pane's cwd. */
    const preview = (href: string, cwd = CWD) => classifyDocLink(href, [KB], cwd);

    it("recognises an absolute path to an HTML file inside the pane's cwd", () => {
      expect(preview(`${CWD}/out/report.html`)).toEqual({
        kind: "preview",
        path: `${CWD}/out/report.html`,
      });
    });

    it("recognises the file:// form a tool prints when it wants the path to be clickable", () => {
      // Exactly as safe as the bare path it wraps: the parser hands back an already-decoded
      // pathname and everything after that is the same grammar and the same containment.
      expect(preview(`file://${CWD}/report.html`)).toEqual({ kind: "preview", path: `${CWD}/report.html` });
      expect(preview(`file://localhost${CWD}/report.html`)).toEqual({
        kind: "preview",
        path: `${CWD}/report.html`,
      });
    });

    it("decodes a file:// pathname before the grammar, never after", () => {
      // `%20` is an ordinary space in a filename and must survive; a double-encoded separator
      // decodes to a literal `%2e%2e%2f`, which the `%` rule then refuses.
      expect(preview(`file://${CWD}/my%20report.html`)).toEqual({
        kind: "preview",
        path: `${CWD}/my report.html`,
      });
      expect(preview(`file://${CWD}/%252e%252e%252fx.html`).kind).toBe("external");
    });

    it("recognises NOTHING without a cwd, which is the shape every other caller has", () => {
      // The fail direction the module's header states: a default that switches itself on when
      // configuration is missing is a default nobody can turn off. A phone that has not loaded a
      // pane sees exactly the two verdicts this function had before the arm existed.
      expect(classifyDocLink(`${CWD}/report.html`, [KB]).kind).toBe("external");
      expect(classifyDocLink(`file://${CWD}/report.html`, [KB]).kind).toBe("external");
    });

    it.each([
      ["a path above the cwd", "/home/op/.ssh/id_rsa.html"],
      ["a sibling directory that merely starts the same way", "/home/op/project/report.html"],
      ["the cwd itself", CWD],
      ["a parent segment, however it is spelled", `${CWD}/../secrets/report.html`],
      ["the git directory", `${CWD}/.git/config.html`],
      ["a percent sign, which is never decoded a second time", `${CWD}/re%2fport.html`],
      ["a NUL byte", `${CWD}/report.html\u0000.png`],
      ["a script, which would be served as a page", `${CWD}/bundle.js`],
      ["a key, for the same reason", `${CWD}/id_rsa`],
      ["an extension that merely contains the word", `${CWD}/report.html.bak`],
      ["a relative path, which names no directory to be inside", "out/report.html"],
      ["another machine's UNC share", `file://fileserver${CWD}/report.html`],
      ["a query, which the route has nowhere to put", `file://${CWD}/report.html?x=1`],
    ])("leaves %s external", (_why, href) => {
      expect(preview(href).kind).toBe("external");
    });

    it("does not shadow the document arm, and is not shadowed by it", () => {
      // Both families are live at once on a pane view, so the order they are asked in has to be a
      // decision rather than an accident: a kb URL is still a document, and a path is still a path.
      expect(preview(`https://${KB}/d/notes`).kind).toBe("doc");
      expect(preview(`${CWD}/report.html`).kind).toBe("preview");
      expect(preview("https://example.test/report.html").kind).toBe("external");
    });
  });

  it("ships a default host list the integrator can fall back to", () => {
    // Pinned because the constant is the wiring's escape hatch when configuration is silent; if it
    // stopped naming the operator's kb, the fallback would quietly recognise nothing.
    expect(DEFAULT_DOC_HOSTS).toContain(KB);
    expect(kind(`https://${KB}/d/notes`, DEFAULT_DOC_HOSTS)).toBe("doc");
  });
});
