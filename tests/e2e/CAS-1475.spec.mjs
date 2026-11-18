// CAS-1475: Alerts — Jump to lands flush under the sticky chrome and is one-shot; an in-place re-render never
// flashes the loading/empty/no-owner state; the subtitle says "agent" for a one-agent account.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

async function openAlertsWithThreeStatuses(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  // Seed one found film per status (cinema/rent/stream) on this device's own ledger, owned by the one agent.
  await page.evaluate(() => {
    const cid = cascades[0].id;
    const seen = new Set();
    for(const g of ["cinema","rent","stream"]){
      const ms = MOVIES.filter(m => primaryStatus(m)===g && !watched.has(m.tmdb_id) && !seen.has(m.tmdb_id)).slice(0,3);
      ms.forEach(m => { seen.add(m.tmdb_id); firstFound[String(m.tmdb_id)] = Date.now(); window.CascadePersistence?.getAgentFilm; });
    }
    window.__cas1475Cid = cid;
  });
  await page.evaluate(() => openMovingScreen());
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator("#movingGroups .group").first()).toBeVisible();
}

const flush = (page, g) => page.evaluate(g => {
  const h = document.querySelector(`#movingGroups .group[data-g="${g}"]`).getBoundingClientRect().top;
  return h - document.getElementById("movingHead").getBoundingClientRect().bottom;
}, g);

test("CAS-1475: Jump to lands flush, stays put after the user scrolls, and re-render never flashes", async ({ page }) => {
  await openAlertsWithThreeStatuses(page);
  const groups = await page.locator("#movingGroups .group").evaluateAll(els => els.map(e => e.dataset.g));
  for(const g of groups){
    await page.locator(`#movingJumpBar .nowstop[data-jump="${g}"]`).click();
    await page.waitForTimeout(1500);
    expect(Math.abs(await flush(page, g))).toBeLessThanOrEqual(4);
  }

  // One-shot: scroll up, force the reload path, wait — nothing drags it back.
  await page.evaluate(() => { document.getElementById("movingScreen").scrollTop -= 300; });
  const top0 = await page.evaluate(() => document.getElementById("movingScreen").scrollTop);
  await page.evaluate(() => refreshMovingIfOpen());
  await page.waitForTimeout(3000);
  expect(Math.abs(await page.evaluate(() => document.getElementById("movingScreen").scrollTop) - top0)).toBeLessThanOrEqual(2);

  // In-place re-render: the list is never swapped for a message.
  await page.evaluate(() => {
    window.__cas1475Bad = false;
    new MutationObserver(() => {
      const b = document.getElementById("movingBody");
      if(!b.querySelector("#movingGroups") || b.querySelector(".mvempty")) window.__cas1475Bad = true;
    }).observe(document.getElementById("movingBody"), { childList:true, subtree:true });
    refreshMovingIfOpen(); refreshMovingIfOpen();
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__cas1475Bad)).toBe(false);
  await expect(page.locator("#movingGroups .card").first()).toBeVisible();
});

test("CAS-1475: subtitle is singular for one active agent, plural for two", async ({ page }) => {
  await openAlertsWithThreeStatuses(page);
  await expect(page.locator("#movingHead .ossub")).toHaveText("What your agent found and what moved.");
  await page.evaluate(() => {
    const c = normCascade({ kind:"stream", status:[] }); c.id = "cas1475-second"; c.paused = false; c.order = 1; c.name = "Second";
    cascades.push(c); renderMovingScreen();
  });
  await expect(page.locator("#movingHead .ossub")).toHaveText("What your agents found and what moved.");
});
