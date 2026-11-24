// CAS-754: on the Watch screen, sections within a stage list follow the journey order (Upcoming leads where
// it appears) — originally asserted per tab on synthetic films pinned to a legacy agent.
//
// CAS-1548: rewritten for the current app. The tab strip (#watchTabs), the per-tab "Also show" set
// (watchAlsoShow) and per-agent status gates are gone; the Watch screen has the stage line instead —
// a "Cinema" group (Upcoming, Now showing) and a "Home" group (Premium, Rental, Streaming) of .stagestop
// buttons (renderWatchTop, CAS-1223). What this spec still protects: on every stop the member can tap, the
// listing's sections come in journey order — Upcoming first wherever it is present — and a stop's own
// section is never listed ahead of it. It uses the real onboarded agent and the real catalogue, tapping the
// real stage stops, with no synthetic films (a one-agent account admits films by score, not by pin).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
}

const groupKeys = page => page.locator("#groups .group").evaluateAll(gs => gs.map(g => g.dataset.g));
const stopKeys = (page, label) => page.locator(".stgroups .stgrp", { has: page.locator(".stgrplbl", { hasText: label }) })
  .locator(".stagestop").evaluateAll(bs => bs.map(b => b.dataset.stage));

test("CAS-754 AC1: the stage line is a Cinema group and a Home group, each holding only its own stops", async ({ page }) => {
  await toWatchScreen(page);
  const labels = await page.locator(".stgroups .stgrplbl").allTextContents();
  expect(labels.map(l => l.trim())).toEqual(["Cinema", "Home"]);
  // Cinema holds the two cinema stages (the old Cinema tab split in two, CAS-1223); Home holds the rest.
  expect(await stopKeys(page, "Cinema")).toEqual(["upcoming", "in_cinema"]);
  const home = await stopKeys(page, "Home");
  expect(home.length).toBeGreaterThan(0);
  for(const k of home) expect(["premium", "rent", "stream"]).toContain(k);
});

test("CAS-754 AC2: tapping every stop lights only it, and its listing leads with Upcoming wherever Upcoming is present", async ({ page }) => {
  await toWatchScreen(page);
  const stops = [...await stopKeys(page, "Cinema"), ...await stopKeys(page, "Home")];
  for(const key of stops){
    const stop = page.locator(`.stgroups .stagestop[data-stage="${key}"]`);
    // A stop dimmed because of a service filter is disabled and not tappable — nothing to check on it.
    if(await stop.isDisabled()) continue;
    await stop.click();
    await settleListing(page);
    await expect(stop).toHaveClass(/\bon\b/);
    await expect(page.locator(".stgroups .stagestop.on")).toHaveCount(1);
    const keys = await groupKeys(page);
    const i = keys.indexOf("upcoming");
    if(i >= 0) expect(i, `stop ${key}: sections ${keys.join(",")}`).toBe(0);
  }
});
