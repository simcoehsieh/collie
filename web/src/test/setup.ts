import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";

import { handlers, resetTypedDraft } from "./handlers";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { __resetPairing } from "@/lib/pairing";
import { __resetDraftPrune } from "@/lib/drafts";

// One MSW server for all tests; tests add per-case overrides with `server.use(...)`.
export const server = setupServer(...handlers);

// ── jsdom 29 defines Storage but never wires up the globals ──────────────────────────────────────
// `globalThis.localStorage` is a plain `{}` here — no getItem, no setItem — while `Storage` itself is
// a complete class whose methods brand-check their receiver, so `Object.create(Storage.prototype)`
// throws on first use and there is no supported way to mint a real instance. Every call site in the
// app guards its access, so nothing THREW: the tests that assert persistence simply failed, 133 of
// them across 18 files, and the tree learned to read that number as weather. Two real costs — a
// persistence regression could not be caught by any test in this repo, and a genuinely new failure
// had to be found inside a wall of expected ones.
//
// So the prototype's methods are replaced with Map-backed ones (nothing else in the process holds a
// real Storage instance, so there is nothing to break) and the two globals become plain objects on
// that prototype.
//
// THE MEMBERS GO ON `Storage.prototype`, NOT ON THE INSTANCES, and that is the whole subtlety. This
// suite simulates Safari private mode with `vi.spyOn(Storage.prototype, "setItem")`
// (lib/drafts.test.ts); an own method on the instance shadows that spy, the throw never happens, and
// a test whose entire purpose is proving the throw is survived passes without exercising it. Found
// exactly that way — the first version of this shim took 133 failures to 1, and the 1 was this.
//
// The guard asks whether the GLOBAL is usable, not whether the prototype has methods: here it has
// them and they are the reason a hand-made instance fails. A jsdom that wires the globals up gets
// left alone.
// SAFETY: the shim runs only when the global is NOT a working Storage — `"getItem" in localStorage`
// walks the prototype chain, so a real jsdom instance answers true and is left alone, while the
// plain `{}` this environment installs answers false. `"Storage" in globalThis` is what makes the
// class references below safe.
const storageIsWired = "Storage" in globalThis && "getItem" in globalThis.localStorage;

if (!storageIsWired && "Storage" in globalThis) {
  const backing = new WeakMap<Storage, Map<string, string>>();
  const mapOf = (s: Storage): Map<string, string> => {
    let m = backing.get(s);
    if (!m) {
      m = new Map<string, string>();
      backing.set(s, m);
    }
    return m;
  };
  Object.assign(Storage.prototype, {
    getItem(this: Storage, k: string): string | null {
      return mapOf(this).get(String(k)) ?? null;
    },
    setItem(this: Storage, k: string, v: string): void {
      mapOf(this).set(String(k), String(v));
    },
    removeItem(this: Storage, k: string): void {
      mapOf(this).delete(String(k));
    },
    clear(this: Storage): void {
      mapOf(this).clear();
    },
    key(this: Storage, i: number): string | null {
      return [...mapOf(this).keys()][i] ?? null;
    },
  });
  Object.defineProperty(Storage.prototype, "length", {
    configurable: true,
    get(this: Storage) {
      return mapOf(this).size;
    },
  });
  for (const name of ["localStorage", "sessionStorage"] as const) {
    // SAFETY: every member the app and this suite touch has just been redefined above as an ordinary
    // Map-backed function, so the object needs nothing from Storage but its prototype — which is
    // exactly what `Object.create` gives it, and what makes the spies find their target.
    const value = Object.create(Storage.prototype) as Storage;
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    if ("window" in globalThis) {
      Object.defineProperty(window, name, { value, configurable: true, writable: true });
    }
  }
}

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
// The connection-health store is module-scoped and initialises its anchor to module-load time. Pin it
// to "now" before every test so a component rendered minutes after the file loaded never reads a stale
// anchor as an escalated outage. Fake-timer escalation suites re-pin AFTER vi.useFakeTimers() so the
// anchor equals the frozen clock exactly.
beforeEach(() => __resetConnectionHealth());
// The pairing refusal latch is module-scoped too: one test's 403 "device not paired" would otherwise
// leave every later test's composer read-only. (The token itself rides localStorage, cleared below.)
beforeEach(() => __resetPairing());
// Persisted state (composer drafts, prefs) must not leak between cases — a draft saved by one test
// would be restored into the next test's freshly-mounted composer.
// `localStorage.clear()` alone stopped being enough when the draft store grew a second, in-memory
// tier (lib/drafts.ts) for drafts too large to persist: that one lives in module scope, which a
// storage clear cannot reach and which outlives every unmount by design.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  __resetDraftPrune();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetTypedDraft(); // the fake pane's input line, so a draft can't leak into the next test
});
afterAll(() => server.close());

// jsdom gaps that the terminal mirror / sheets touch.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}
