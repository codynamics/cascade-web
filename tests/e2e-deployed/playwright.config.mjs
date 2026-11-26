// CAS-1574: the real-user check runs against a DEPLOYED site (no local server, no fake database), WebKit iPhone 13.
// Kept out of tests/e2e so the push gate's local smoke suite never picks it up.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "deployed-smoke.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,                       // a real sign-up must not be retried: the second try would hit a half-made account
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  timeout: 20 * 60_000,             // includes up to 15 minutes waiting for the deploy
  expect: { timeout: 20_000 },
  use: { ...devices["iPhone 13"], trace: "off", screenshot: "off", video: "off", serviceWorkers: "block" },
});
