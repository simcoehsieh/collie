import { expect, test } from "@playwright/test";
import { fixtureArtifact } from "@/test/artifacts";
import { installApiStub } from "./fixtures/api";

test("library filters survive opening an artifact and browser Back", async ({ page }, testInfo) => {
  await installApiStub(page);
  const artifacts = Array.from({ length: 125 }, (_, i) => fixtureArtifact({
    id: `item-${i}`, slug: `item-${i}`, title: `Report ${i}`,
    kind: i === 124 ? "image" : "html", pinned: i === 124,
  }));
  await page.route((url) => url.pathname === "/api/artifacts", (route) =>
    route.fulfill({ json: { ok: true, artifacts } }));
  await page.goto("/artifacts");
  await expect(page.getByRole("button", { name: /^Open Report / })).toHaveCount(40);
  await page.screenshot({ path: testInfo.outputPath("library.png") });
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open Report / })).toHaveCount(80);
  await page.getByRole("searchbox", { name: "Search artifacts" }).fill("Report 123");
  await expect(page.getByRole("button", { name: /^Open Report / })).toHaveCount(1);
  await page.getByRole("button", { name: "Open Report 123", exact: true }).click();
  await expect(page).toHaveURL(/\/artifacts\/item-123$/);
  await page.goBack();
  await expect(page.getByRole("searchbox")).toHaveValue("Report 123");
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "image", exact: true }).click();
  await page.getByRole("button", { name: "Pinned only", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open Report / })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Report 124", exact: true })).toBeVisible();
});
