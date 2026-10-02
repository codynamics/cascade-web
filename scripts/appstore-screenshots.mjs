#!/usr/bin/env node
// CAS-961: on-demand App Store screenshot generator. Drives the real BUILT index.html in Playwright,
// through the same shared driving helpers tests/e2e already uses (tests/e2e/helpers.mjs) — never a
// composited mock — and overlays a benefit-led caption on each frame. Run with `npm run screenshots`.
//
// Deliberately NOT wired into qa.yml or any other workflow: a per-push screenshot job is DEFERRED on
// Cascade by Lee's decision of 2026-08-17. This only runs when a human asks for it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { webkit, expect } from "@playwright/test";
import { freshApp, ctaLocator, finishFlow, toListing, settleListing } from "../tests/e2e/helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "state", "appstore-screenshots");
const PORT = Number(process.env.CASCADE_SHOT_PORT || 8994);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Apple's required iPhone portrait pixel sizes for the two mandatory size classes (App Store Connect).
// cssWidth/cssHeight x deviceScaleFactor 3 land exactly on outWidth/outHeight — no post-hoc resizing,
// so the raw driven screenshot already IS the required pixel size (AC3).
const FRAME_SETS = [
  { key: "6.9in", outWidth: 1320, outHeight: 2868, cssWidth: 440, cssHeight: 956 },
  { key: "6.5in", outWidth: 1242, outHeight: 2688, cssWidth: 414, cssHeight: 896 },
];
const DEVICE_SCALE_FACTOR = 3;
// Cascade ships to exactly two runtimes, iOS Safari and the Capacitor WKWebView — both WebKit
// (CAS-552) — so screenshots are driven in the same engine, not Chromium's desktop rendering.
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1";

// Placeholder copy only — obviously placeholders, per the ticket. The real captions are Lee's own
// copy call; see the completion comment for the full list to replace.
const CAPTIONS = {
  agent_reveal: "PLACEHOLDER CAPTION: An agent that already knows your taste",
  watch_cinema: "PLACEHOLDER CAPTION: Every film worth seeing, scored and dated",
  moving: "PLACEHOLDER CAPTION: See what changed the moment it does",
  film_card: "PLACEHOLDER CAPTION: Know exactly where and when to watch",
  onboarding: "PLACEHOLDER CAPTION: Set up in under a minute",
};

// The five frames, in the order the ticket specifies — the first three are what iOS 17+ renders
// inline in App Store search results, so they carry the whole argument.
const FRAME_ORDER = ["agent_reveal", "watch_cinema", "moving", "film_card", "onboarding"];

function readPngSize(buf){
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function assertPngSize(buf, frame, label){
  const size = readPngSize(buf);
  if(size.width !== frame.outWidth || size.height !== frame.outHeight){
    throw new Error(`${label} for ${frame.key} was ${size.width}x${size.height}, expected ${frame.outWidth}x${frame.outHeight}`);
  }
}

// Posters are CSS background-image, not <img> tags, so there is no img.complete signal to poll —
// resolve each one with its own throwaway Image() (the browser serves it from its own cache, since
// the background-image request already started it) and cap the wait so one dead poster URL can't
// hang the whole run.
async function waitPostersLoaded(page, selector, timeoutMs = 8000){
  await page.evaluate(({ selector, timeoutMs }) => new Promise(resolve => {
    const urls = [...document.querySelectorAll(selector)]
      .map(el => (getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/) || [])[1])
      .filter(Boolean);
    if(!urls.length) return resolve();
    let remaining = urls.length;
    const done = () => { if(--remaining <= 0) resolve(); };
    setTimeout(resolve, timeoutMs);
    urls.forEach(url => { const img = new Image(); img.onload = done; img.onerror = done; img.src = url; });
  }), { selector, timeoutMs });
}

function waitForServer(url, timeoutMs){
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url).then(r => {
        if(r.ok) resolve(); else throw new Error(`status ${r.status}`);
      }).catch(err => {
        if(Date.now() > deadline) reject(new Error(`server never became ready at ${url}: ${err.message}`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function composeHTML({ outWidth, outHeight, screenshotBase64, caption }){
  const fontSize = Math.round(outWidth * 0.052);
  const pad = Math.round(outWidth * 0.07);
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;width:${outWidth}px;height:${outHeight}px;overflow:hidden;background:#0b0b12;position:relative;">
  <img src="data:image/png;base64,${screenshotBase64}"
       style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;">
  <div style="position:absolute;top:0;left:0;right:0;padding:${pad}px ${pad}px ${Math.round(pad * 1.6)}px;
              background:linear-gradient(to bottom, rgba(6,6,14,.93) 55%, rgba(6,6,14,0));">
    <div style="font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;font-weight:800;
                font-size:${fontSize}px;line-height:1.15;color:#fff;letter-spacing:-0.01em;">
      ${caption}
    </div>
  </div>
</body></html>`;
}

// Overlays the caption directly on the raw device screenshot (rather than adding a separate band)
// so the composited asset stays exactly the frame's required pixel size — no resize, no letterbox.
async function composite(browser, frame, key, raw){
  const page = await browser.newPage({
    viewport: { width: frame.outWidth, height: frame.outHeight },
    deviceScaleFactor: 1,
  });
  await page.setContent(composeHTML({
    outWidth: frame.outWidth, outHeight: frame.outHeight,
    screenshotBase64: raw.toString("base64"), caption: CAPTIONS[key],
  }));
  const final = await page.screenshot();
  await page.close();
  assertPngSize(final, frame, `composited ${key}`);
  return final;
}

// Walks the real onboarding v2 sequence far enough to capture the first agent's reveal (row 1 — "a
// real haul") and a mid-build question screen (row 5), then hands off to the shared finishFlow()/
// toListing() helpers for the rest of the walk. Mirrors tests/e2e/smoke.spec.mjs's own CAS-913 walk
// (cas913WalkToShortlist), which duplicates this exact opening for the same reason: no helper in
// helpers.mjs stops mid-flow, since toShortlist() always runs all the way through to v2_services.
// The onboarding wizard's dual-pane slide (gotoStep/endSlide) keeps the OUTGOING step's .obhd in the
// DOM for a fixed 460ms after a Continue click, alongside the incoming step's own .obhd — long enough
// to turn any single-element locator ambiguous mid-transition. SLIDE_SETTLE waits it out before any
// selector that could match both panes runs.
const SLIDE_SETTLE = 500;

async function walkOnboarding(page, onFrame){
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".obhd")).toContainText("Let's get you set up.");
  await ctaLocator(page).click();
  await page.waitForTimeout(SLIDE_SETTLE);
  await expect(page.locator(".obhd")).toContainText("Massive Movies");
  await ctaLocator(page).click();
  await page.waitForTimeout(SLIDE_SETTLE);
  await expect(page.locator("#obCinemaOpts")).toBeVisible();
  await page.locator('#obCinemaOpts .obopt[data-val="yes"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(SLIDE_SETTLE);
  await expect(page.locator("#obRentOpts")).toBeVisible();
  await page.locator('#obRentOpts .obopt[data-val="yes"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(SLIDE_SETTLE);

  // v2_massive: the first agent's reveal, with its own poster grid haul (onbRevealGridHTML's .rvgrid).
  await expect(page.locator(".eyebrow")).toContainText("Your first agent");
  await expect(page.locator(".rvgrid")).toBeVisible();
  await waitPostersLoaded(page, ".rvposter");
  await onFrame("agent_reveal");

  await ctaLocator(page).click();   // -> v2_handoff
  await page.waitForTimeout(SLIDE_SETTLE);
  await ctaLocator(page).click();   // -> v2_styles
  await page.waitForTimeout(SLIDE_SETTLE);

  // v2_styles: a plain, one-question step — an agent being built, showing how little setup costs.
  await expect(page.locator("#obStylesChips")).toBeVisible();
  await onFrame("onboarding");

  // v2_styles -> v2_budget -> v2_ages -> v2_favs -> v2_partner: four more Continues with nothing to
  // answer on any of them (each has its own default/no-op wiring, same as toShortlist's own loop).
  for(let i = 0; i < 4; i++){
    await ctaLocator(page).click();
    await page.waitForTimeout(SLIDE_SETTLE);
  }
  await expect(page.locator("#obPartnerOpts")).toBeVisible();
  await page.locator('#obPartnerOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(SLIDE_SETTLE);
  await expect(page.locator("#obKidsOpts")).toBeVisible();
  await page.locator('#obKidsOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(SLIDE_SETTLE);
  await expect(page.locator("#obSvcStores")).toBeVisible();
}

async function runForFrameSet(browser, frame){
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: frame.cssWidth, height: frame.cssHeight },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    isMobile: true,
    hasTouch: true,
    userAgent: USER_AGENT,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  // Unlike tests/e2e (which blocks TMDB/YouTube as decoration it doesn't need), this script's whole
  // job is the real image — real posters ARE the "real haul" row 1 asks for — so nothing is blocked.

  const raw = {};
  await walkOnboarding(page, async key => {
    const shot = await page.screenshot();
    assertPngSize(shot, frame, `raw ${key}`);
    raw[key] = shot;
  });

  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  // Watch, Cinema tab is the default landing tab (CAS-933/CAS-750) — no extra navigation needed.
  await waitPostersLoaded(page, "#groups .card .poster");
  raw.watch_cinema = await page.screenshot();
  assertPngSize(raw.watch_cinema, frame, "raw watch_cinema");

  await page.locator("#movingBtn").click();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await page.waitForTimeout(200);
  raw.moving = await page.screenshot();
  assertPngSize(raw.moving, frame, "raw moving");

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  const firstCard = page.locator("#groups .card").first();
  await expect(firstCard).toBeVisible();
  await firstCard.locator(".cbody").click();
  await expect(firstCard).toHaveClass(/expanded/);
  await page.waitForTimeout(150);
  await waitPostersLoaded(page, "#groups .card .poster");
  raw.film_card = await page.screenshot();
  assertPngSize(raw.film_card, frame, "raw film_card");

  await context.close();

  const dir = path.join(OUT_DIR, frame.key);
  fs.mkdirSync(dir, { recursive: true });
  for(const key of FRAME_ORDER){
    const final = await composite(browser, frame, key, raw[key]);
    fs.writeFileSync(path.join(dir, `${key}.png`), final);
  }
  console.log(`${frame.key}: wrote ${FRAME_ORDER.length} frames to ${path.relative(ROOT, dir)}`);
}

async function main(){
  const indexPath = path.join(ROOT, "index.html");
  if(!fs.existsSync(indexPath)){
    console.error("index.html not found — run `npm run build` first.");
    process.exit(1);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = spawn(process.platform === "win32" ? "python" : "python3",
    ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  const killServer = () => { try{ server.kill(); }catch(e){} };
  process.on("exit", killServer);

  try{
    await waitForServer(`${BASE_URL}/index.html`, 30_000);
    const browser = await webkit.launch();
    try{
      for(const frame of FRAME_SETS) await runForFrameSet(browser, frame);
    } finally {
      await browser.close();
    }
  } finally {
    killServer();
  }

  console.log(`\nDone. Output: ${path.relative(ROOT, OUT_DIR)}`);
  console.log("Placeholder captions used (Lee's copy call to replace):");
  for(const key of FRAME_ORDER) console.log(`  ${key}: ${CAPTIONS[key]}`);
}

main().catch(err => { console.error(err); process.exit(1); });
