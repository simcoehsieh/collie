import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

import { router } from "./router";

// FORK: the routes a session opens once a week are code-split off the app shell; the dashboard and
// the pane are not. Pinned structurally: the element a route hands React Router is a <Suspense>
// around a lazy component for the split ones, and the plain route component for the eager ones.
describe("router — route-level code splitting", () => {
  const children = router.routes[0]!.children!;
  const elementOf = (path: string | undefined) => {
    const route = children.find((r) => (path === undefined ? r.index === true : r.path === path))!;
    // SAFETY: every child route in router.tsx is declared with a JSX `element` (never a
    // `Component`), and a JSX element always carries a `type`; the cast only names that field.
    return route.element as { type: unknown };
  };

  it.each([
    "settings",
    "settings/updates",
    "settings/voice",
    "settings/harnesses",
    "crew",
    "pane/:paneId/history",
    "conversations",
  ])(
    "%s loads on demand",
    (path) => {
      expect(elementOf(path).type).toBe(Suspense);
    },
  );

  it.each([undefined, "space/:spaceId", "pane/:paneId", "overview"])("%s is on the shell", (path) => {
    expect(elementOf(path).type).not.toBe(Suspense);
  });

  // FORK: the redirect an iOS Shortcut can name. A loader, no element.
  it("pane/last is a loader-only redirect", () => {
    const route = children.find((r) => r.path === "pane/last")!;
    expect(route.loader).toBeTypeOf("function");
    expect(route.element).toBeUndefined();
  });
});

// The QR `collie pair` prints names `/settings?pair=<code>`. Settings became an index of four
// sections and the pairing form moved to System, so the index forwards (src/router.tsx, with the
// target from `pairLandingPath` in lib/nav.ts, which nav.test.ts pins). The forward is a router
// fact: the loader returns `replace(...)`, so Back does not land on the index and bounce forward
// again. The router is created at module scope from the document's own location, so each case
// sets the URL first and imports a fresh copy.
async function bootAt(path: string) {
  vi.resetModules();
  window.history.replaceState(null, "", "/");
  window.history.pushState(null, "", path);
  const { router } = await import("./router");
  await waitFor(() => expect(router.state.initialized).toBe(true));
  return router;
}

describe("router: the pairing forward", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("lands a scanned pairing link on System with the whole query intact", async () => {
    const router = await bootAt("/settings?h=badger&pair=ABCD2345");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/system"));
    expect(router.state.location.search).toBe("?h=badger&pair=ABCD2345");
    expect(window.location.pathname).toBe("/settings/system");
  });

  it("replaces the entry, so there is no extra history step to bounce back through", async () => {
    const before = window.history.length;
    const router = await bootAt("/settings?pair=ABCD2345");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/system"));
    // bootAt pushed exactly one entry (the scanned URL); the forward replaced it instead of adding one.
    expect(window.history.length).toBe(before + 1);
  });

  it("leaves Settings without a code as the index", async () => {
    const router = await bootAt("/settings");
    expect(router.state.location.pathname).toBe("/settings");
    expect(window.location.pathname).toBe("/settings");
  });
});
