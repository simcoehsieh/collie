import { expect, test } from "@playwright/test";
import { installApiStub } from "./fixtures/api";

// These cases verify controls and navigation; sheet entrance animations are covered elsewhere.
test.use({ contextOptions: { reducedMotion: "reduce" } });

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  await page.route((url) => url.pathname === "/api/launchers", (route) => route.fulfill({ json: {
    home: "/home/you", launchers: [{ command: "claude", label: "claude" }, { command: "codex", label: "codex" }],
    handoffModels: [{ id: "codex-test", label: "Test Codex", efforts: ["low", "high"], defaultEffort: "low" }],
  } }));
  await page.route((url) => url.pathname === "/api/artifacts", (route) => route.fulfill({ json: { ok: true, artifacts: [] } }));
});

test("Codex keeps its artifacts entry even before anything is registered", async ({ page }) => {
  await page.goto("/pane/w2%3Ap1");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.getByRole("button", { name: "Pane actions" }).click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(page.getByText("This pane has not registered anything yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "All artifacts" })).toBeVisible();
});

test("handoff exposes usable model and effort controls on a narrow screen", async ({ page }, testInfo) => {
  await page.goto("/pane/w1%3Ap1");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.getByRole("button", { name: "Pane actions" }).click();
  await page.getByRole("button", { name: "Hand off to another agent" }).click();
  await page.getByLabel("Codex model").selectOption("codex-test");
  await page.getByLabel("Reasoning effort").selectOption("high");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("high");
  await page.getByRole("checkbox", { name: /Ask claude/ }).uncheck();
  await page.getByRole("button", { name: "Hand off to codex", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Hand off to codex", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("handoff.png") });
});

test("screenshot explains its steps and leaves health endpoints out of the address", async ({ page }, testInfo) => {
  await page.route((url) => url.pathname === "/api/config", (route) => route.fulfill({ json: { push: false, shot: true } }));
  await page.route((url) => /^\/api\/pane\/[^/]+$/.test(url.pathname), (route) => route.fulfill({ json: {
    paneId: "w1:p1", text: "http://127.0.0.1:4318/api/snapshot", truncated: false, revision: 1,
  } }));
  await page.goto("/pane/w1%3Ap1");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.getByRole("button", { name: "Pane actions" }).click();
  await page.getByRole("button", { name: "Screenshot & annotate…" }).click();
  await expect(page.getByLabel("Page address")).toHaveValue("");
  await expect(page.getByText("Capture a website running on your Mac")).toBeVisible();
  await page.getByLabel("Page address").fill("http://localhost:5173/");
  await page.getByRole("button", { name: "Tablet · 768" }).click();
  await expect(page.getByRole("button", { name: "Take a shot" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Take a shot" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("screenshot-setup.png") });
});
