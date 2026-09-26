import { defineConfig } from "@playwright/test";

// The config for shots.spec.ts, copied next to web/playwright.config.ts in a scratch worktree by
// before-after.sh. The repo's own config starts three servers (the swap server alone builds two
// bundles); this one starts only the tree's shipped bundle, on a port nothing else uses, and NEVER
// reuses a server already there — a leftover "before" server answering the "after" run would make
// two identical sets of pictures that look like "nothing changed".
const PORT = Number(process.env.SHOTS_PORT ?? 4183);

export default defineConfig({
  testDir: "e2e",
  testMatch: /collie-sync-shots\.spec\.ts$/,
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: "line",
  // The installed Google Chrome, not Playwright's bundled build: the bundled one has to be downloaded
  // per Playwright version (`playwright install`), and a picture does not need that exact engine.
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: "chromium", channel: process.env.SHOTS_CHANNEL ?? "chrome" },
  webServer: {
    command: `bunx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 60_000,
  },
});
