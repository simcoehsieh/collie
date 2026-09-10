// Per-machine branding for the installed PWA.
//
// FORK-ONLY, and a new file on purpose: two machines serve this same commit, so anything that has to
// differ BETWEEN them cannot be a committed value. On an iPhone home screen both installs are the
// same white collie head on black under the same word "Collie", which makes the work instance and
// the home instance indistinguishable at the only moment it matters — the tap. The override is
// therefore a directory OUTSIDE the checkout, `~/.config/collie/branding/`, next to the `.env` that
// already lives there (FORK.md). A machine without that directory builds byte for byte what it built
// before this file existed, which is what keeps the other install untouched.
//
// THE OVERLAY REPLACES `publicDir`; IT DOES NOT COPY INTO `dist/` AFTERWARDS. vite-plugin-pwa
// computes each precache entry's revision from the bytes the BUILD saw, so an icon swapped in after
// the build ships under the stock file's hash — the service worker then serves whichever copy it
// happened to cache first, and the instance disagrees with itself rather than with its neighbour.
// Overriding the INPUT means the precache manifest, `includeAssets` and the manifest icons are all
// computed from the file that will actually be served.
//
// What the directory holds:
//
//   ~/.config/collie/branding/
//   ├── apple-touch-icon.png       180×180 — THE file iOS bakes into the home screen icon
//   ├── favicon-96x96.png          optional — the browser tab
//   ├── favicon.svg / .ico         optional — ditto
//   ├── web-app-manifest-*.png     optional — Android and other installers; iOS never reads these
//   └── branding.json              optional — {"name", "shortName", "description"}, all optional
//
// A file whose name matches one in `web/public/` replaces it. A name that matches nothing there is
// still copied, but WARNS: a typo'd filename is the failure that looks exactly like success.
//
// `COLLIE_BRANDING_DIR` points somewhere else, which is what the tests use.

import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

// The app's own parse boundary, reused rather than restated: `branding.json` is hand-written by
// the operator, so it is untrusted input in exactly the sense src/lib/json.ts exists for — every
// field below comes back through a reader that answers `undefined` for anything that isn't the
// shape asked for, with no `typeof` and no assertion in the middle.
import { asJsonObject, asJsonString, parseJson } from "./src/lib/json";
import type { JsonObject } from "./src/lib/json";

/** `branding.json`, after validation. Every field is optional; an absent one keeps upstream's. */
export interface BrandingText {
  readonly name?: string;
  readonly shortName?: string;
  readonly description?: string;
}

export interface Branding extends BrandingText {
  /** What vite must use as `publicDir` — the staged overlay, or `web/public` untouched. */
  readonly publicDir: string;
  /** Rewrites index.html's title pair. Null when no name override is configured. */
  readonly htmlPlugin: Plugin | null;
}

/**
 * iOS shows roughly this many characters under a home screen icon before it elides the middle. Not
 * an error — an operator may well want the long form in the app switcher — but worth saying once,
 * because the label is the other half of telling two installs apart.
 */
const HOME_SCREEN_LABEL_BUDGET = 12;

/** Everything `branding.json` may say. Anything else in the file is a typo worth naming. */
const BRANDING_KEYS = new Set(["name", "shortName", "description"]);

const warn = (msg: string) => console.warn(`\x1b[33m⚠ branding: ${msg}\x1b[0m`);

/** `<title>` and the iOS home screen label. Both must be present, or index.html changed under us. */
const TITLE_RE = /(<title>)([^<]*)(<\/title>)/;
const APPLE_TITLE_RE = /(<meta\s+name="apple-mobile-web-app-title"\s+content=")([^"]*)(")/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Put `title` into index.html's `<title>` and its `apple-mobile-web-app-title` meta — the two places
 * that decide what the phone writes under the icon.
 *
 * THROWS when either pattern is missing rather than returning the html unchanged. A silent no-op
 * here produces a build that succeeds, installs, and is labelled "Collie" anyway — indistinguishable
 * from the thing this whole file exists to prevent. Upstream owns index.html, so the day it rewrites
 * that markup is the day this must fail loudly; `src/branding.test.ts` pins the shipped file against
 * both patterns so the failure arrives at test time, not at install time.
 */
export function applyBrandingToHtml(html: string, title: string): string {
  const safe = escapeHtml(title);
  if (!TITLE_RE.test(html)) {
    throw new Error("branding: index.html has no <title> to rewrite — the markup changed");
  }
  if (!APPLE_TITLE_RE.test(html)) {
    throw new Error(
      "branding: index.html has no apple-mobile-web-app-title meta to rewrite — the markup changed",
    );
  }
  return html.replace(TITLE_RE, `$1${safe}$3`).replace(APPLE_TITLE_RE, `$1${safe}$3`);
}

/**
 * One overridable string, or `undefined` when the file does not carry it.
 *
 * A key that is PRESENT but not a usable string throws rather than falling back to stock: an
 * operator who wrote `"shortName": ""` asked for something, and quietly building the stock label
 * would be the same wrong answer this whole file exists to prevent.
 */
function readString(doc: JsonObject, file: string, key: string): string | undefined {
  const raw = doc[key];
  if (raw === undefined) return undefined;
  const value = asJsonString(raw);
  if (value === undefined || value.trim() === "") {
    throw new Error(`branding: ${file} — "${key}" must be a non-empty string`);
  }
  return value.trim();
}

/** Read and validate `branding.json`. A malformed file throws; an absent one is simply no overrides. */
export function readBrandingText(dir: string): BrandingText {
  const file = join(dir, "branding.json");
  if (!existsSync(file)) return {};
  const parsed = parseJson(readFileSync(file, "utf8"));
  if (parsed === undefined) throw new Error(`branding: ${file} is not valid JSON`);
  const doc = asJsonObject(parsed);
  if (doc === undefined) throw new Error(`branding: ${file} must be a JSON object`);
  for (const key of Object.keys(doc)) {
    if (!BRANDING_KEYS.has(key)) warn(`${file} — unknown key "${key}" ignored`);
  }
  return {
    name: readString(doc, file, "name"),
    shortName: readString(doc, file, "shortName"),
    description: readString(doc, file, "description"),
  };
}

/**
 * Stage `web/public` with the branding directory laid over it, and return the path vite should use.
 * Rebuilt from scratch every build, so deleting an override reverts to stock on the next one.
 *
 * The staging directory lives under `node_modules/`, which is already ignored — nothing here may
 * leave the tree dirty, because `git status` is this fork's pre-merge check (FORK.md).
 */
export function stagePublicDir(webRoot: string, brandingDir: string, files: string[]): string {
  const stock = resolve(webRoot, "public");
  const stage = resolve(webRoot, "node_modules", ".collie-branding", "public");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(stock, stage, { recursive: true });
  for (const name of files) {
    if (!existsSync(join(stock, name))) {
      warn(`"${name}" matches no file in web/public — copied anyway, but check the spelling`);
    }
    copyFileSync(join(brandingDir, name), join(stage, name));
  }
  return stage;
}

/**
 * The whole feature, as one call `vite.config.ts` makes at config time — i.e. before the build reads
 * a single byte of `publicDir`.
 */
export function loadBranding(webRoot: string): Branding {
  const stock = resolve(webRoot, "public");
  const dir =
    process.env.COLLIE_BRANDING_DIR?.trim() || join(homedir(), ".config", "collie", "branding");

  if (!existsSync(dir)) return { publicDir: stock, htmlPlugin: null };

  const text = readBrandingText(dir);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== "branding.json" && !e.name.startsWith("."))
    .map((e) => e.name)
    .toSorted();

  const named = text.name ?? text.shortName ?? text.description;
  if (files.length === 0 && named === undefined) {
    warn(`${dir} exists but is empty — building the stock Collie`);
    return { publicDir: stock, htmlPlugin: null };
  }

  const label = text.shortName ?? text.name;
  if (label !== undefined && label.length > HOME_SCREEN_LABEL_BUDGET) {
    warn(
      `"${label}" is ${label.length} characters — iOS elides the middle of a home screen label past ` +
        `about ${HOME_SCREEN_LABEL_BUDGET}`,
    );
  }

  const publicDir = files.length > 0 ? stagePublicDir(webRoot, dir, files) : stock;
  console.log(
    `\x1b[36mbranding:\x1b[0m ${dir} → ` +
      [
        files.length > 0 ? `${files.length} file(s): ${files.join(", ")}` : null,
        label !== undefined ? `label "${label}"` : null,
      ]
        .filter(Boolean)
        .join("; "),
  );

  return {
    ...text,
    publicDir,
    htmlPlugin:
      label === undefined
        ? null
        : {
            name: "collie-branding-html",
            transformIndexHtml: {
              // `pre`, so the rewrite happens on the source markup rather than on whatever the PWA
              // plugin has already injected into it.
              order: "pre",
              handler(html: string, ctx: { filename: string }) {
                // index.html ONLY. `playground.html` is a dev-server page with its own title and no
                // apple meta, and rewriting it would trip the throw above for no reason.
                if (!ctx.filename.replaceAll("\\", "/").endsWith("/index.html")) return;
                return applyBrandingToHtml(html, label);
              },
            },
          },
  };
}
