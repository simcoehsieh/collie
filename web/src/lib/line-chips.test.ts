import { describe, expect, it } from "vitest";

import { splitLines } from "./blocks";
import { parseAnsi } from "./ansi";
import { isLocalServerUrl, lineChips } from "./line-chips";

// FORK. Which mirror line earns a chip, and — the half that matters more — which does not.
//
// This module exists because lib/links.ts already argued that a host-shaped or path-shaped
// heuristic over terminal output turns file names and version strings into things you cannot select
// as text. So the two rules here are narrow on purpose: a URL is found by the SCHEME (the same scan
// the autolinker uses, so a chip and a link never disagree about what is on the line), and a path is
// found by LOOKUP against the pane's own diff list — never by guessing what a path looks like.

/** Mirror lines from plain text, through the real parser the renderer uses. */
const lines = (text: string) => splitLines(parseAnsi(text));

describe("isLocalServerUrl", () => {
  it.each([
    "http://localhost:5173/",
    "http://127.0.0.1:3000",
    "http://[::1]:8080/app",
    "https://localhost:4173/",
  ])("says %s is a server on this machine", (href) => {
    expect(isLocalServerUrl(href)).toBe(true);
  });

  it.each([
    ["a real site", "https://example.test/"],
    ["a host that merely starts like loopback", "http://localhost.evil.test:5173/"],
    ["a LAN address, which is somebody else's box", "http://192.168.1.10:5173/"],
    ["loopback with NO port — a hosts-file entry, not a dev server", "http://localhost/"],
    ["userinfo, which reads as another host to a human skimming", "http://evil.test@localhost:5173/"],
    ["a scheme that is not http(s)", "ws://localhost:5173/"],
    ["something that is not a URL", "localhost:5173"],
  ])("says %s is not", (_why, href) => {
    expect(isLocalServerUrl(href)).toBe(false);
  });
});

describe("the URL chip", () => {
  it("offers Open for a page on the web and Preview for a server on this machine", () => {
    const out = lineChips(lines("see https://example.test/docs\nvite ready at http://localhost:5173/"));
    expect(out[0]).toEqual({ url: { href: "https://example.test/docs", local: false } });
    expect(out[1]).toEqual({ url: { href: "http://localhost:5173/", local: true } });
  });

  it("takes the FIRST URL only — three chips on one 84-column row is not a row anyone reads", () => {
    const out = lineChips(lines("a https://one.test/ b https://two.test/ c https://three.test/"));
    expect(out[0]?.url?.href).toBe("https://one.test/");
  });

  it("agrees with the autolinker about where a URL ends", () => {
    // The chip and the anchor on the same line must open the same address, so the scan is shared
    // rather than re-implemented: the trailing full stop is prose, the balanced paren is not.
    expect(lineChips(lines("See https://x.test/a."))[0]?.url?.href).toBe("https://x.test/a");
    expect(lineChips(lines("See https://x.test/a_(b)"))[0]?.url?.href).toBe("https://x.test/a_(b)");
  });

  it("leaves a bare host:port alone — the whole reason this is a chip and not a link", () => {
    // lib/links.ts:19-26 refuses to match a schemeless host, and this module does not reopen it.
    // A line naming `localhost:5173` with no scheme earns nothing, and its text stays selectable.
    expect(lineChips(lines("listening on localhost:5173"))).toEqual([null]);
  });

  it("earns nothing from ordinary output", () => {
    expect(lineChips(lines("  ✓ 128 tests passed in 3.2s\n\nnode_modules/.bin/vitest"))).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe("the file chip", () => {
  const PATHS = ["web/src/lib/line-chips.ts", "line-chips.ts", "bridge/preview.ts"];

  it("is a LOOKUP: a path earns a chip only because the diff list already named it", () => {
    const out = lineChips(lines("wrote bridge/preview.ts"), PATHS);
    expect(out[0]).toEqual({ path: "bridge/preview.ts" });
  });

  it("offers nothing at all without a list, however path-shaped the line is", () => {
    // The false-positive rate a path detector would have is not reduced here, it is ABSENT — there
    // is no detector. A pane that is not a work tree simply gets no file chips.
    expect(lineChips(lines("edited src/components/agent-chat.tsx and web/vite.config.ts"))).toEqual([null]);
  });

  it("prefers the LONGER match, so a full path never opens the wrong file", () => {
    // `line-chips.ts` is a substring of `web/src/lib/line-chips.ts`; a line carrying the full path
    // means the full path, and offering the short one would open a different file of the same name.
    const out = lineChips(lines("M web/src/lib/line-chips.ts"), PATHS);
    expect(out[0]?.path).toBe("web/src/lib/line-chips.ts");
  });

  it("ignores a path too short to be anything but an accident", () => {
    // A one- or two-character path matches somewhere on almost every line of prose. Below the floor
    // the operator reaches the file through the Changes sheet, which is one tap away.
    expect(lineChips(lines("a b c d"), ["a", "cd"])).toEqual([null]);
  });

  it("rides beside a URL chip rather than displacing it", () => {
    const out = lineChips(lines("served bridge/preview.ts at http://localhost:5173/"), PATHS);
    expect(out[0]).toEqual({
      url: { href: "http://localhost:5173/", local: true },
      path: "bridge/preview.ts",
    });
  });
});

describe("the shape of the answer", () => {
  it("is index-for-index with the lines it was given", () => {
    // The renderer looks a line's chips up by its own index inside the block, so a filtered or
    // reordered result would put a chip on the wrong row — silently, and only on some screens.
    const src = lines("one\nhttps://x.test/\nthree\n");
    expect(lineChips(src)).toHaveLength(src.length);
  });

  it("says null for a blank line rather than scanning it", () => {
    expect(lineChips(lines("\n\n"))).toEqual([null, null, null]);
  });
});
