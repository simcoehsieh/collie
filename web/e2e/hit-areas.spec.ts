import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureArtifact } from "@/test/artifacts";
import { fixtureSnapshot } from "@/test/handlers";
import { installApiStub } from "./fixtures/api";

// FORK — THE HIT AREAS, MEASURED (survey round 3, components/ui/hit-area.tsx).
//
// DESIGN.md §6 sets a 44px floor for anything tappable, and the fork's reading controls buy it as hit
// area so their drawn faces keep their size. A class name cannot prove a reach reaches, or that it
// stops short of a neighbour, so this asks the browser the way a finger would:
//
//  - the box a control claims (its own box and its hit-area child's, together) is 44px each way;
//  - the face it draws is still the size it was;
//  - every point of that box — corners, edges, middle — answers `elementFromPoint` with the control
//    itself, so nothing paints over the reach;
//  - no two neighbours claim the same pixel.

const PANE = "w1:p1";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Measured {
  name: string;
  drawn: { w: number; h: number };
  box: Box;
}

async function measure(control: Locator, name: string): Promise<Measured> {
  const m = await control.evaluate((el) => {
    const own = el.getBoundingClientRect();
    const area = el.querySelector(':scope > [data-slot="hit-area"]');
    const reach = area === null ? own : area.getBoundingClientRect();
    return {
      drawn: { w: Math.round(own.width), h: Math.round(own.height) },
      box: {
        left: Math.min(own.left, reach.left),
        top: Math.min(own.top, reach.top),
        right: Math.max(own.right, reach.right),
        bottom: Math.max(own.bottom, reach.bottom),
      },
    };
  });
  return { name, ...m };
}

function expectFloor(m: Measured): void {
  // A hair under 44 is subpixel rounding, not a shortfall.
  expect(m.box.right - m.box.left, `${m.name}: hit width`).toBeGreaterThanOrEqual(43.9);
  expect(m.box.bottom - m.box.top, `${m.name}: hit height`).toBeGreaterThanOrEqual(43.9);
}

async function expectHittable(control: Locator, m: Measured): Promise<void> {
  const { left, top, right, bottom } = m.box;
  const xs = [left + 1, (left + right) / 2, right - 1];
  const ys = [top + 1, (top + bottom) / 2, bottom - 1];
  for (const x of xs) {
    for (const y of ys) {
      const mine = await control.evaluate(
        (el, [px, py]) => {
          const under = document.elementFromPoint(px, py);
          return under !== null && el.contains(under);
        },
        [x, y] as const,
      );
      expect(mine, `${m.name}: the point (${x.toFixed(1)}, ${y.toFixed(1)}) lands on it`).toBe(true);
    }
  }
}

function expectApart(all: readonly Measured[]): void {
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      const acrossX = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const acrossY = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      expect(acrossX > 0.5 && acrossY > 0.5, `${a.name} and ${b.name} claim the same pixels`).toBe(false);
    }
  }
}

/** Measure a row of neighbours: each owns 44px, keeps its face, answers its own points, shares none. */
async function expectRow(
  controls: readonly { locator: Locator; name: string; face: { w?: number; h: number } }[],
): Promise<void> {
  const all: Measured[] = [];
  for (const c of controls) await expect(c.locator).toBeVisible();
  // Anything still moving (a sheet sliding in, a collapse opening) would move a box between its
  // measuring and its probing.
  await controls[0]!.locator.page().waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  for (const c of controls) {
    const m = await measure(c.locator, c.name);
    expectFloor(m);
    expect(m.drawn.h, `${c.name}: drawn height`).toBe(c.face.h);
    if (c.face.w !== undefined) expect(m.drawn.w, `${c.name}: drawn width`).toBe(c.face.w);
    await expectHittable(c.locator, m);
    all.push(m);
  }
  expectApart(all);
}

async function paneWithSession(page: Page): Promise<void> {
  await page.route(/\/api\/snapshot(\?|$)/, (route) =>
    route.fulfill({
      json: {
        ...fixtureSnapshot,
        agents: fixtureSnapshot.agents.map((a) => (a.paneId === PANE ? Object.assign({}, a, { hasSession: true }) : a)),
      },
    }),
  );
}

// No route entrance, no sheet slide: a box measured mid-animation is a box that has moved by the time
// its points are asked about.
test.use({ contextOptions: { reducedMotion: "reduce" } });

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
});

test("the tab row: each half of the view switch and the fold chevron own 44px, apart", async ({ page }) => {
  await paneWithSession(page);
  await page.goto(`/pane/${PANE}`);
  await expectRow([
    { locator: page.getByRole("radio", { name: en["chat.view.transcript"] }), name: "Transcript", face: { w: 28, h: 28 } },
    { locator: page.getByRole("radio", { name: en["chat.view.terminal"] }), name: "Terminal", face: { w: 28, h: 28 } },
    { locator: page.getByRole("button", { name: en["chat.strips.hide.tabs"] }), name: "fold", face: { w: 28, h: 28 } },
  ]);
});

test("the diff sheet and the file viewer: every tool owns 44px, keeps its 32px face, and fits the row", async ({ page }) => {
  await page.route(/\/api\/pane\/[^/]+\/diff(\?|$)/, (route) => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    if (mode === "patch") {
      return route.fulfill({
        json: {
          ok: true,
          mode: "patch",
          path: "src/app.ts",
          patch: "diff --git a/src/app.ts b/src/app.ts\n@@ -1,1 +1,2 @@\n line\n+added\n",
          truncated: false,
        },
      });
    }
    return route.fulfill({
      json: {
        ok: true,
        mode: "stat",
        cwd: "/home/you/webapp",
        repoRoot: "/home/you/webapp",
        branch: "main",
        files: [{ path: "src/app.ts", status: "M", staged: false, additions: 1, deletions: 0, binary: false }],
        truncated: false,
      },
    });
  });
  await page.route(/\/api\/pane\/[^/]+\/file(\?|$)/, (route) =>
    route.fulfill({ json: { ok: true, mode: "file", path: "src/app.ts", text: "line\nadded\n", bytes: 11, truncated: false } }),
  );
  await page.goto(`/pane/${PANE}`);
  await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
  await page.getByRole("button", { name: en["diff.row.label"] }).click();

  // The list: the door to the workspace's Changes on the left, refresh on the right.
  await expectRow([
    { locator: page.getByRole("button", { name: "Workspace changes" }), name: "workspace changes", face: { h: 32 } },
    { locator: page.getByRole("button", { name: en["diff.refresh"] }), name: "refresh", face: { w: 38, h: 32 } },
  ]);

  // One file's patch: four tools on one row.
  await page.getByText("src/app.ts", { exact: true }).click();
  await expectRow([
    { locator: page.getByRole("button", { name: en["diff.back"] }), name: "back", face: { h: 32 } },
    { locator: page.getByRole("button", { name: en["diff.openFile"] }), name: "open file", face: { h: 32 } },
    { locator: page.getByRole("button", { name: en["diff.copyPath"] }), name: "copy path", face: { h: 32 } },
    { locator: page.getByRole("button", { name: en["diff.refresh"] }), name: "refresh", face: { w: 38, h: 32 } },
  ]);

  // …and all four fit the glass: the row does not scroll its last tool off the right edge.
  const fits = await page.getByRole("button", { name: en["diff.back"] }).evaluate((el) => {
    const row = el.parentElement!;
    return row.scrollWidth <= row.clientWidth;
  });
  expect(fits, "the patch's tool row fits its width").toBe(true);

  // The file itself.
  await page.getByRole("button", { name: en["diff.openFile"] }).click();
  await expectRow([
    { locator: page.getByRole("button", { name: en["file.copyPath"] }), name: "copy path", face: { h: 32 } },
    { locator: page.getByRole("button", { name: en["file.refresh"] }), name: "refresh", face: { w: 38, h: 32 } },
  ]);
});

test("an HTML artifact's two icons own 44px each, apart, at 32px drawn", async ({ page }) => {
  const artifact = fixtureArtifact({ kind: "html" });
  await page.route((url) => url.pathname === "/api/artifacts", (route) =>
    route.fulfill({ json: { ok: true, artifacts: [artifact] } }),
  );
  await page.route((url) => url.pathname === `/api/artifacts/${artifact.id}`, (route) =>
    route.fulfill({ json: { ok: true, artifact } }),
  );
  await page.route((url) => url.pathname === `/api/artifacts/${artifact.id}/raw`, (route) =>
    route.fulfill({ body: "<p>report</p>", contentType: "text/html" }),
  );
  await page.goto(`/artifacts/${artifact.id}`);
  await expectRow([
    { locator: page.getByRole("button", { name: en["artifacts.viewer.refresh"] }), name: "reload", face: { w: 32, h: 32 } },
    { locator: page.getByRole("button", { name: en["artifacts.viewer.openTab"] }), name: "open in tab", face: { w: 32, h: 32 } },
  ]);
});
