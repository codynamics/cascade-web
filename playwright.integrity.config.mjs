// CAS-1093: the account-integrity suite runs against a REAL local Supabase stack (started + torn down by
// scripts/test-integrity.mjs, never the live project) — its own config, separate from playwright.config.mjs
// (the smoke suite), so the two never collide over testDir/port if a dev ever ran both side by side.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.CASCADE_INTEGRITY_TEST_PORT || 8974);

export default defineConfig({
  testDir: "./tests/e2e-integrity",
  fullyParallel: false,
  // One worker: as with the smoke suite, cascades[]/localStorage live on one origin per context, and
  // several scenarios here open more than one context on purpose (S4) — a second worker would just be a
  // second, unrelated run racing the same local Supabase stack for no benefit.
  workers: 1,
  retries: 2,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report-integrity" }]]
    : [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // CAS-1093 (decision, 2026-10-01 build chat): unlike the smoke suite, CI uploads this job's HTML
    // report + traces on every run (qa.yml), so a failure is self-diagnosing without a local
    // Docker/Supabase CLI reproduction — on by default in CI; PWTRACE still opts a local run in.
    trace: (process.env.CI || process.env.PWTRACE) ? "retain-on-failure" : "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
  },
  // Same device profile as `npm run test:e2e` (CAS-552) — Cascade ships to exactly two runtimes, iOS
  // Safari and the Capacitor WKWebView, both WebKit.
  projects: [
    { name: "ios", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: `python -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
