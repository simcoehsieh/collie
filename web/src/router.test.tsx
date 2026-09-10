import { Suspense } from "react";
import { describe, expect, it } from "vitest";

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

  it.each(["settings", "settings/updates", "crew", "pane/:paneId/history"])(
    "%s loads on demand",
    (path) => {
      expect(elementOf(path).type).toBe(Suspense);
    },
  );

  it.each([undefined, "space/:spaceId", "pane/:paneId"])("%s is on the shell", (path) => {
    expect(elementOf(path).type).not.toBe(Suspense);
  });
});
