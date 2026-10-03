import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { t } from "@/lib/i18n";
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
//
// A control drawn at 44px needs no reach, and then its box is its own rounded face: a browser hit-tests
// the curve, so its four corner points sit just inside it rather than 1px in from a square corner.

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
  /** How far in from the box's corners the corner points sit: 1px, or inside a rounded face. */
  corner: number;
}

async function measure(control: Locator, name: string): Promise<Measured> {
  const m = await control.evaluate((el) => {
    const own = el.getBoundingClientRect();
    const area = el.querySelector(':scope > [data-slot="hit-area"]');
    const reach = area === null ? own : area.getBoundingClientRect();
    // A point (d, d) in from a corner rounded at radius r is on the face once d ≥ r(1 − 1/√2).
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return {
      drawn: { w: Math.round(own.width), h: Math.round(own.height) },
      box: {
        left: Math.min(own.left, reach.left),
        top: Math.min(own.top, reach.top),
        right: Math.max(own.right, reach.right),
        bottom: Math.max(own.bottom, reach.bottom),
      },
      corner: area === null ? Math.max(1, Math.ceil(radius * 0.3) + 1) : 1,
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
  for (const [i, x] of xs.entries()) {
    for (const [j, y] of ys.entries()) {
      // A corner is the one point with both coordinates on an edge; it moves in by `m.corner`.
      const corner = i !== 1 && j !== 1;
      const px = corner ? (i === 0 ? left + m.corner : right - m.corner) : x;
      const py = corner ? (j === 0 ? top + m.corner : bottom - m.corner) : y;
      const mine = await control.evaluate(
        (el, [cx, cy]) => {
          const under = document.elementFromPoint(cx, cy);
          return under !== null && el.contains(under);
        },
        [px, py] as const,
      );
      expect(mine, `${m.name}: the point (${px.toFixed(1)}, ${py.toFixed(1)}) lands on it`).toBe(true);
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

// ── Quick on a Codex pane (survey round 3's C3, floored at 44px in round 5) ───────────────────────
// Every target in this dock is DRAWN at 44px or more, so there is no reach to measure: the face is
// the box. The dock body scrolls (`max-h-[45dvh]`), so each group is brought to the top of it before
// its points are asked about — a point under the scroller's edge belongs to nothing.

const MODELS = [
  { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
  { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
  { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
] as const;

async function toTopOfDock(control: Locator): Promise<void> {
  // After any opening has finished: a collapse still growing has no room yet to scroll into.
  await control.page().waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  await control.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
}

test("Quick on a Codex pane: the folded rows, the models and their efforts own 44px, apart", async ({ page }) => {
  await page.route(/\/api\/snapshot(\?|$)/, (route) =>
    route.fulfill({
      json: {
        ...fixtureSnapshot,
        agents: fixtureSnapshot.agents.map((a) =>
          a.paneId === PANE
            ? Object.assign({}, a, { agent: "codex", status: "idle", model: "gpt-6-astra", effort: "high", hasSession: true })
            : a,
        ),
      },
    }),
  );
  await page.route((url) => url.pathname === "/api/launchers", (route) =>
    route.fulfill({ json: { launchers: [], home: "/home/you", handoffModels: MODELS } }),
  );
  await page.goto(`/pane/${PANE}`);
  await page.getByRole("button", { name: en["composer.controls.quick"] }).click();

  const commit = page.getByRole("button", { name: "commit and push", exact: true });
  const others = page.getByRole("button", { name: en["quickActions.group.others"], exact: true });
  const modelRow = page.getByRole("button", { name: t("fork.quick.codexModel.row", { current: "gpt-6-astra·high" }) });

  // Folded: the operator's phrase, the folded group under it, and the model row last.
  await toTopOfDock(commit);
  await expectRow([
    { locator: commit, name: "commit and push", face: { h: 48 } },
    { locator: others, name: "others", face: { h: 44 } },
    { locator: modelRow, name: "model row", face: { h: 44 } },
  ]);

  // Open: the row, and the catalog under it.
  await modelRow.click();
  const models = MODELS.map((m) => ({
    locator: page.getByRole("button", { name: m.label, exact: true }),
    name: m.label,
    face: { h: 44 },
  }));
  await toTopOfDock(modelRow);
  await expectRow([{ locator: modelRow, name: "model row", face: { h: 44 } }, ...models]);

  // A model picked: its efforts under the catalog.
  await page.getByRole("button", { name: "GPT-6-Astra", exact: true }).click();
  const efforts = MODELS[1].efforts.map((effort) => ({
    locator: page.getByRole("button", { name: effort, exact: true }),
    name: `effort ${effort}`,
    face: { h: 48 },
  }));
  await toTopOfDock(models[0]!.locator);
  await expectRow([...models, ...efforts]);
});
