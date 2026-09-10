import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { applyBrandingToHtml, loadBranding, readBrandingText } from "../branding";

// This fork runs two Collie instances — one at the office, one at home — off the same commit, so the
// thing that tells them apart on a phone's home screen (the icon and the word under it) is a
// per-MACHINE input read from `~/.config/collie/branding/`. See branding.ts for why the overlay has
// to replace `publicDir` rather than land in `dist` afterwards.
//
// The load-bearing assertion in here is the LAST one: index.html is upstream's file, and the two
// patterns branding.ts rewrites are markup upstream is free to change. If it does, the rewrite stops
// matching — and a rewrite that stops matching produces a build that succeeds and installs itself
// under the wrong name, which is exactly the failure this feature exists to prevent. So the throw in
// applyBrandingToHtml is asserted, and the shipped file is asserted to still feed it.

const root = resolve(import.meta.dirname, "..");
const shippedHtml = readFileSync(resolve(root, "index.html"), "utf8");

const withTempDirs = (fn: (dirs: { branding: string; webRoot: string }) => void) => {
  const base = mkdtempSync(join(tmpdir(), "collie-branding-"));
  const branding = join(base, "branding");
  const webRoot = join(base, "web");
  mkdirSync(branding, { recursive: true });
  mkdirSync(join(webRoot, "public"), { recursive: true });
  const previous = process.env.COLLIE_BRANDING_DIR;
  process.env.COLLIE_BRANDING_DIR = branding;
  try {
    fn({ branding, webRoot });
  } finally {
    if (previous === undefined) delete process.env.COLLIE_BRANDING_DIR;
    else process.env.COLLIE_BRANDING_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
};

describe("applyBrandingToHtml", () => {
  it("rewrites both places the phone reads a name from", () => {
    const out = applyBrandingToHtml(shippedHtml, "Collie Work");
    expect(out).toContain("<title>Collie Work</title>");
    expect(out).toContain('name="apple-mobile-web-app-title" content="Collie Work"');
    expect(out).not.toContain("<title>Collie</title>");
  });

  it("escapes a name that would otherwise close the attribute", () => {
    const out = applyBrandingToHtml(shippedHtml, 'A & B" <x>');
    expect(out).toContain("<title>A &amp; B&quot; &lt;x&gt;</title>");
    expect(out).toContain('content="A &amp; B&quot; &lt;x&gt;"');
  });

  // Silence is the danger: returning the html unchanged would ship a correct-looking build labelled
  // "Collie" on both machines.
  it("throws rather than no-ops when the title is gone", () => {
    expect(() => applyBrandingToHtml("<html><head></head></html>", "X")).toThrow(/<title>/);
  });

  it("throws rather than no-ops when the apple meta is gone", () => {
    expect(() => applyBrandingToHtml("<html><title>Collie</title></html>", "X")).toThrow(
      /apple-mobile-web-app-title/,
    );
  });
});

describe("readBrandingText", () => {
  it("is empty when the directory holds no branding.json", () => {
    withTempDirs(({ branding }) => {
      expect(readBrandingText(branding)).toEqual({});
    });
  });

  it("reads and trims the three overridable strings", () => {
    withTempDirs(({ branding }) => {
      writeFileSync(
        join(branding, "branding.json"),
        JSON.stringify({ name: " Collie Work ", shortName: "Work", description: "office herd" }),
      );
      expect(readBrandingText(branding)).toEqual({
        name: "Collie Work",
        shortName: "Work",
        description: "office herd",
      });
    });
  });

  it("throws on malformed JSON instead of falling back to stock", () => {
    withTempDirs(({ branding }) => {
      writeFileSync(join(branding, "branding.json"), "{ nope");
      expect(() => readBrandingText(branding)).toThrow(/not valid JSON/);
    });
  });

  it("throws on an empty string, which would install a nameless icon", () => {
    withTempDirs(({ branding }) => {
      writeFileSync(join(branding, "branding.json"), JSON.stringify({ shortName: "  " }));
      expect(() => readBrandingText(branding)).toThrow(/non-empty string/);
    });
  });
});

describe("loadBranding", () => {
  it("is stock — publicDir untouched, no html plugin — when the directory does not exist", () => {
    withTempDirs(({ webRoot }) => {
      process.env.COLLIE_BRANDING_DIR = join(webRoot, "no-such-dir");
      const brand = loadBranding(webRoot);
      expect(brand.publicDir).toBe(resolve(webRoot, "public"));
      expect(brand.htmlPlugin).toBeNull();
      expect(brand.name).toBeUndefined();
    });
  });

  it("stages public with the override laid over it, leaving web/public alone", () => {
    withTempDirs(({ branding, webRoot }) => {
      writeFileSync(join(webRoot, "public", "apple-touch-icon.png"), "stock");
      writeFileSync(join(webRoot, "public", "favicon.ico"), "stock-favicon");
      writeFileSync(join(branding, "apple-touch-icon.png"), "work");

      const brand = loadBranding(webRoot);

      expect(brand.publicDir).not.toBe(resolve(webRoot, "public"));
      expect(readFileSync(join(brand.publicDir, "apple-touch-icon.png"), "utf8")).toBe("work");
      // Everything not overridden still comes along, or the build would ship a public dir with holes.
      expect(readFileSync(join(brand.publicDir, "favicon.ico"), "utf8")).toBe("stock-favicon");
      // The checkout stays clean: `git status` is this fork's pre-merge check.
      expect(readFileSync(join(webRoot, "public", "apple-touch-icon.png"), "utf8")).toBe("stock");
    });
  });

  it("reverts to stock bytes on the next build once the override is removed", () => {
    withTempDirs(({ branding, webRoot }) => {
      writeFileSync(join(webRoot, "public", "apple-touch-icon.png"), "stock");
      writeFileSync(join(branding, "apple-touch-icon.png"), "work");
      loadBranding(webRoot);

      rmSync(join(branding, "apple-touch-icon.png"));
      writeFileSync(join(branding, "branding.json"), JSON.stringify({ shortName: "Work" }));
      const brand = loadBranding(webRoot);

      expect(readFileSync(join(brand.publicDir, "apple-touch-icon.png"), "utf8")).toBe("stock");
    });
  });

  it("carries the name through to the manifest fields and the html plugin", () => {
    withTempDirs(({ branding, webRoot }) => {
      writeFileSync(
        join(branding, "branding.json"),
        JSON.stringify({ name: "Collie Work", shortName: "Work" }),
      );
      const brand = loadBranding(webRoot);
      expect(brand.name).toBe("Collie Work");
      expect(brand.shortName).toBe("Work");
      expect(brand.htmlPlugin).not.toBeNull();
    });
  });

  it("leaves index.html alone for the playground page", () => {
    withTempDirs(({ branding, webRoot }) => {
      writeFileSync(join(branding, "branding.json"), JSON.stringify({ shortName: "Work" }));
      const plugin = loadBranding(webRoot).htmlPlugin!;
      // SAFETY: branding.ts builds this plugin itself, and it always builds the object form of
      // `transformIndexHtml` — vite's own type is the union of every shape a plugin MAY use, so the
      // narrowing is to the one shape the code above this line just constructed.
      const handler = (
        plugin.transformIndexHtml as {
          handler: (html: string, ctx: { filename: string }) => string | undefined;
        }
      ).handler;

      // playground.html has neither pattern, so touching it would throw for no reason.
      expect(handler("<html><body>playground</body></html>", { filename: "/w/playground.html" })).toBe(
        undefined,
      );
      expect(handler(shippedHtml, { filename: "/w/index.html" })).toContain("<title>Work</title>");
    });
  });
});

// The drift guard. Upstream owns index.html; the day it rewrites either of these two lines, the
// rewrite above silently stops matching and both machines install as "Collie" again.
describe("the shipped index.html", () => {
  it("still carries the two strings branding rewrites", () => {
    expect(shippedHtml).toMatch(/<title>[^<]*<\/title>/);
    expect(shippedHtml).toMatch(/<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"/);
  });

  it("still points the apple-touch-icon at a file the overlay can replace", () => {
    expect(shippedHtml).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');
  });
});
