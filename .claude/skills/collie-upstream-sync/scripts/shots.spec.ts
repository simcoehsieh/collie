import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// BEFORE/AFTER SHOTS for collie-upstream-sync. NOT a test: `before-after.sh` copies this file into
// the `web/e2e/` of a scratch worktree, runs it once there, and deletes it. Running it inside each
// tree is the point — the tree's own bundle, its own API stub, its own branding — so the "before" and
// "after" pictures differ only by what the merge changes.
//
// Env (all set by before-after.sh):
//   SHOTS_SPEC   JSON file: [{ "id", "route"?, "fixture"?, "harness"?, "hasSession"?, "storage"? }]
//                  fixture = a file name under SHOTS_FIXTURES; it becomes the pane's text and the
//                  route defaults to that pane. harness = the pane's agent (default: the fixture's
//                  `<harness>--` prefix), because the harness picks the grammar that reads the screen.
//                  hasSession = whether Herdr knows the pane's session (default true; false shows
//                  the "has not reported a session" note, which is otherwise the stub's gap).
//                  storage = localStorage entries set before the app's first script, for a state
//                  that lives on the device (a pin: `{"collie:pins:v1": "[…]"}`). Values are strings.
//                  steps = actions run after the page settles, to reach a state: {"click": selector},
//                  {"press": key}, {"wait": ms}. ignore = boxes highlight.py skips (unused here).
//                  devices = which viewports to shoot, default ["phone"]. sides = which trees shoot
//                  this id (default all); per = { "<side>": { route?, steps?, fixture?, storage? } }
//                  overrides for one tree — a new capability's "before" is the screen it would live
//                  on, reached another way, because the control that opens it does not exist yet.
//   SHOTS_SIDE   before | after | upstream — which tree this run is (set by before-after.sh).
//   SHOTS_FIXTURES  the fixture directory. The AFTER tree's, for both runs, so a capture upstream
//                  added in this release is shown to the old bundle too — that is the "before".
//   SHOTS_OUT    where the JPEGs go: <id>--phone.jpg, <id>--desktop.jpg.

interface Shot {
  id: string;
  route?: string;
  fixture?: string;
  harness?: string;
  hasSession?: boolean;
  storage?: Record<string, string>;
  steps?: Array<{ click?: string; press?: string; wait?: number }>;
  ignore?: number[][];
  devices?: string[];
  sides?: string[];
  per?: Record<string, Partial<Pick<Shot, "route" | "fixture" | "harness" | "storage" | "steps" | "hasSession">>>;
}

const side = process.env.SHOTS_SIDE ?? "after";
// One tree's view of the list: the ids it shoots, each with that tree's overrides applied.
const spec: Shot[] = (JSON.parse(readFileSync(process.env.SHOTS_SPEC!, "utf8")) as Shot[])
  .filter((s) => s.sides === undefined || s.sides.includes(side))
  .map((s) => ({ ...s, ...(s.per?.[side] ?? {}) }));
const fixtures = process.env.SHOTS_FIXTURES!;
const out = process.env.SHOTS_OUT!;
mkdirSync(out, { recursive: true });

const PANE = "w1:p1";
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
} as const;

for (const [device, use] of Object.entries(VIEWPORTS)) {
  test.describe(device, () => {
    test.use({ ...use, deviceScaleFactor: 2 });

    for (const shot of spec.filter((s) => (s.devices ?? ["phone"]).includes(device))) {
      test(shot.id, async ({ page }) => {
        await installApiStub(page);
        if (shot.storage !== undefined) {
          await page.addInitScript((entries: Record<string, string>) => {
            for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
          }, shot.storage);
        }
        if (shot.fixture !== undefined) {
          const text = readFileSync(join(fixtures, shot.fixture), "utf8");
          const harness = shot.harness ?? shot.fixture.split("--")[0]!.replace(/-lab$/, "");
          // Newest handler wins: these two override the stub's snapshot and pane text only.
          await page.route(/\/api\/snapshot(\?|$)/, (route) =>
            route.fulfill({
              json: {
                ...fixtureSnapshot,
                // hasSession: without it the mirror opens with a "has not reported a session to Herdr"
                // note, which is the stub's gap, not anything either version does.
                agents: fixtureSnapshot.agents.map((a) =>
                  a.paneId === PANE ? { ...a, agent: harness, hasSession: shot.hasSession ?? true } : a,
                ),
              },
            }),
          );
          // Any spelling of the id (`w1:p1`, `w1%3Ap1`), with or without a query string.
          await page.route(/\/api\/pane\/[^/?]+(\?|$)/, (route) =>
            route.fulfill({ json: { paneId: PANE, text, truncated: false, revision: 1 } }),
          );
        }
        await page.goto(shot.route ?? `/pane/${PANE}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(600); // route entrance + first mirror paint
        for (const step of shot.steps ?? []) {
          if (step.click !== undefined) await page.locator(step.click).first().click({ timeout: 5000 });
          if (step.press !== undefined) await page.keyboard.press(step.press);
          await page.waitForTimeout(step.wait ?? 300);
        }
        await page.screenshot({ path: join(out, `${shot.id}--${device}.jpg`), type: "jpeg", quality: 78 });
      });
    }
  });
}
