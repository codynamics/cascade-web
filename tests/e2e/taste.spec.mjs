// CAS-1551: browser tests for the Taste screen (the one-agent app's #agentsScreen). Guest device with a real
// one-agent account (helpers.guestOnboarded) — Taste is client-side, and a guest's account is localStorage, so
// "survives reload" is a real page reload. Runs in e2e-full only (not the push gate).
import { test, expect } from "@playwright/test";
import { guestOnboarded, settleListing } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

async function openTaste(page){
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await expect(page.locator("#oaList .oarow").first()).toBeVisible();
}

/** A real reload, then back to a settled listing (dismissing a tour if one auto-started). */
async function reloadApp(page){
  await page.reload();
  await page.waitForFunction(() => typeof oneAgentCriteria === "function" && Array.isArray(MOVIES) && cascades.length > 0);
  await settleListing(page);
  if(await page.locator("#tutScrim.open").count() > 0){
    await page.locator("#tutSkipBtn").click();
    if(await page.locator("#tutScrim.open").count() > 0) await page.locator("#tutNextBtn").click();
  }
}

const firstOnRow = page => page.locator("#oaList .oarow:not(.off)").first();

test("CAS-1551 taste: a fresh account sees the recommendations card, empty", async ({ page }) => {
  await guestOnboarded(page);
  await openTaste(page);
  const card = page.locator(".tkrec");
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/tkrec-empty/);
  await expect(card).toContainText("None right now");
});

test("CAS-1594 taste: tapping a score-adjustment step saves that value and survives a reload", async ({ page }) => {
  await guestOnboarded(page);
  await openTaste(page);
  const row = firstOnRow(page);
  const style = await row.getAttribute("data-style");
  await expect(row.locator(".tkdrag, .oarange, .oarowtick")).toHaveCount(0);
  await row.locator(".oarowleft").click();
  const step = row.locator('.oacstep[data-step="-10"]').first();
  await expect(step).toBeVisible();
  const key = await step.getAttribute("data-key");
  await step.click();
  const read = () => page.evaluate(k => oneAgentCriteria().combo[k], key);
  await expect.poll(read).toBe(-10);
  await expect(page.locator(`#oaList .oarow[data-style="${style}"] .oacstep.on[data-key="${key}"]`)).toHaveAttribute("data-step", "-10");

  await reloadApp(page);
  expect(await read()).toBe(-10);

  await openTaste(page);
  await page.locator(`#oaList .oarow[data-style="${style}"] .oarowleft`).click();
  await page.locator(`#oaList .oarow[data-style="${style}"] .oacstep[data-key="${key}"][data-step="never"]`).click();
  await expect.poll(read).toBe("never");
});

test("CAS-1551 taste: a genre's alert can be turned off and on, and each state saves", async ({ page }) => {
  await guestOnboarded(page);
  await openTaste(page);
  const style = await firstOnRow(page).getAttribute("data-style");
  const rowOf = () => page.locator(`#oaList .oarow[data-style="${style}"]`);
  const alertOn = () => page.evaluate(s => !!oneAgentCriteria().styles[s].al.cinema, style);
  const dots = () => page.evaluate(s => {
    const al = oneAgentCriteria().styles[s].al || {};
    return { expected: ["cinema", "rent", "stream"].filter(k => al[k]).length,
             drawn: [...document.querySelectorAll("#oaList .oarow")].filter(r => r.dataset.style === s)
               .reduce((n, r) => n + r.querySelectorAll(".oadot").length, 0) };
  }, style);
  const chip = () => rowOf().locator(".oachip", { hasText: "Cinema" });
  const openRow = async () => { await rowOf().locator(".oarowleft").click(); await expect(chip()).toBeVisible(); };

  // CAS-1680: a guest device keeps no agents of its own (loadCascades() is a placeholder returning [], the agent
  // lives on the account store since CAS-1109/CAS-1222), so a guest reload boots with no agent and the old
  // "survives reload" step waited on cascades.length > 0 forever. "Each state saves" is asserted at the save
  // chokepoint instead: every toggle must call saveCascades() with the new alert state already in place.
  await page.evaluate(s => {
    window.__tasteSaves = [];
    const orig = saveCascades;
    saveCascades = function(){ window.__tasteSaves.push(!!oneAgentCriteria().styles[s].al.cinema); return orig.apply(this, arguments); };
  }, style);
  const saves = () => page.evaluate(() => window.__tasteSaves.slice());

  await openRow();
  if(!(await alertOn())) await chip().click();          // start from ON so "off then on" is what is tested
  expect(await alertOn()).toBe(true);
  await page.evaluate(() => { window.__tasteSaves.length = 0; });

  await chip().click();                                  // off
  await expect.poll(alertOn).toBe(false);
  await expect(chip()).toHaveAttribute("aria-pressed", "false");
  expect(await saves()).toEqual([false]);

  await chip().click();                                  // on again
  await expect.poll(alertOn).toBe(true);
  await expect(chip()).toHaveAttribute("aria-pressed", "true");
  const d = await dots();
  expect(d.drawn).toBe(d.expected);
  expect(await saves()).toEqual([false, true]);
});

/** Two (or more, until the engine proposes something) disliked verdicts on one main|sub-genre combo of real
 * catalogue films, plus three wowed on a different main genre so the account has a baseline to differ from.
 * Returns the seeded combo, a probe film (same combo, no verdict) and its score before anything was seeded. */
async function seedVerdicts(page){
  return page.evaluate(() => {
    const byCombo = {};
    MOVIES.forEach(m => { mainOtherCombos(m).keys.forEach(k => { (byCombo[k.key] = byCombo[k.key] || []).push(m); }); });
    const free = list => list.filter(m => !opinionOf(m.tmdb_id) && cascadeScore(m) >= 0);
    const ranked = Object.entries(byCombo).map(([k, l]) => [k, free(l)]).filter(([, l]) => l.length >= 12)
      .sort((a, b) => b[1].length - a[1].length);
    const [key, films] = ranked[0];
    const main = key.split("|")[0];
    const other = ranked.find(([k]) => k.split("|")[0] !== main);
    const c = oneAgentCriteria();
    const probe = films[films.length - 1];
    const scoreBefore = oneScore(probe, c);
    const mark = (m, set) => { watched.add(m.tmdb_id); set.add(m.tmdb_id); };
    other[1].slice(0, 3).forEach(m => mark(m, wowed));
    let used = 0;
    films.slice(0, 2).forEach(m => { mark(m, disliked); used++; });
    invalidateComputeCaches();
    // The ticket's "two verdicts" is the floor (TASTE_REC_MIN_VERDICTS); add more only if the engine needs them.
    while(!tasteRecs().some(r => r.style === main) && used < 8){ mark(films[used], disliked); used++; invalidateComputeCaches(); }
    return { key, main, probeId: probe.tmdb_id, scoreBefore, verdicts: used };
  });
}

const scoreOf = (page, id) => page.evaluate(i => oneScore(MOVIES.find(m => m.tmdb_id === i), oneAgentCriteria()), id);
const recFor = (page, main) => page.evaluate(m => {
  const r = tasteRecs().find(x => x.style === m);
  return r ? { style: r.style, keys: r.keys.map(k => ({ key: k.key, from: k.from, to: k.to })) } : null;
}, main);

test("CAS-1551 taste: Apply moves scores; nothing moves before it (CAS-1479)", async ({ page }) => {
  await guestOnboarded(page);
  const seed = await seedVerdicts(page);
  const rec = await recFor(page, seed.main);
  expect(rec, `a recommendation for ${seed.main} after ${seed.verdicts} verdicts`).not.toBeNull();
  const k = rec.keys.find(x => x.key === seed.key);
  expect(k).toBeTruthy();
  // Verdicts alone never move a score: the learned value is only a recommendation until applied.
  expect(await scoreOf(page, seed.probeId)).toBe(seed.scoreBefore);

  await openTaste(page);
  const card = page.locator(".tkrec");
  await expect(card).not.toHaveClass(/tkrec-empty/);
  await expect(card).toContainText("Open a gold genre to review them");
  // CAS-1609: the proposal is reviewed inside its genre: open the row, then Apply from the legend.
  await page.locator(`#oaList .oarow[data-style="${seed.main}"] .oarowleft`).click();
  await expect(page.locator(`#oaAdjustSection .oacstep.prop[data-key="${seed.key}"]`)).toHaveCount(1);
  await page.locator(`#oaAdjustSection .oaprop .ap[onclick*="tasteApply('${seed.main}')"]`).click();

  expect(await page.evaluate(key => oneAgentCriteria().applied[key], seed.key)).toBe(k.to);
  expect(await page.evaluate(m => tasteRecs().some(r => r.style === m), seed.main)).toBe(false);
  expect(await scoreOf(page, seed.probeId)).not.toBe(seed.scoreBefore);
});

test("CAS-1551 taste: Skip clears the recommendation without moving scores, and it stays cleared (CAS-1479)", async ({ page }) => {
  await guestOnboarded(page);
  const seed = await seedVerdicts(page);
  const rec = await recFor(page, seed.main);
  expect(rec, `a recommendation for ${seed.main} after ${seed.verdicts} verdicts`).not.toBeNull();
  const k = rec.keys.find(x => x.key === seed.key);
  const appliedBefore = await page.evaluate(key => (oneAgentCriteria().applied || {})[key], seed.key);

  await openTaste(page);
  await page.locator(`#oaList .oarow[data-style="${seed.main}"] .oarowleft`).click();   // CAS-1609: Skip lives in the genre legend
  await page.locator(`#oaAdjustSection .oaprop .sk[onclick*="tasteSkip('${seed.main}')"]`).click();

  expect(await page.evaluate(m => tasteRecs().some(r => r.style === m), seed.main)).toBe(false);
  expect(await page.evaluate(key => oneAgentCriteria().applied[key], seed.key)).toBe(appliedBefore);
  expect(await page.evaluate(key => oneAgentCriteria().skipped[key], seed.key)).toBe(k.to);
  expect(await scoreOf(page, seed.probeId)).toBe(seed.scoreBefore);

  // Leave Taste and come back: the skipped value holds (it only returns once learned moves by 2 or more).
  await page.evaluate(() => closeAgentsScreen());
  await openTaste(page);
  expect(await page.evaluate(m => tasteRecs().some(r => r.style === m), seed.main)).toBe(false);
});
