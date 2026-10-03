import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { installApiStub } from "./fixtures/api";

// FORK — the pane menu's "What changed" opens the fork's diff sheet, and its "Workspace changes"
// lands on upstream's Changes view for the same pane; Back comes home to the pane (ADR 0067). With
// the belt pill and the dashboard footer both off by standing decision, this is that view's door.

test("the diff sheet's door lands on the pane's Changes, and Back returns to the pane", async ({ page }) => {
  await installApiStub(page);
  await page.goto("/pane/w1:p1");
  await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
  await page.getByRole("button", { name: en["diff.row.label"] }).click();
  await page.getByRole("button", { name: "Workspace changes" }).click();
  await expect(page).toHaveURL(/\/pane\/w1(%3A|:)p1\/changes$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/pane\/w1(%3A|:)p1$/);
});
