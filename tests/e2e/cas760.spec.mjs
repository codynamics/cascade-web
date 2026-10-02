// CAS-760: the Watch listing's per-agent sub-heading (.grouphead.sub, CAS-717) gets a full-width tinted
// band keyed to the owning cascade's RANK (c.order position among the account's cascades, CAS-708) — rank
// 1 is always the same tint, so the change of agent registers while scrolling. Six --agrank-N custom
// properties, applied only to the sub-heading band (never .gdot/.cap/.wdot/the score chip/the agent chip).
//
// Real onboarding roster (toShortlist/finishFlow, same technique cas751-754 use), then the three cascades
// it produces are made permissive (status:[]) and given explicit, well-separated .order values so rank is
// deterministic rather than riding cascadeOrderCmp's created_at/id tie-break. Films are pinned in (CAS-709:
// a pin always outranks criteria), the same technique cas753/754 use for placing a film with no dependency
// on catalogue-derived taste matching.
//
// The "Other" (unowned) block is produced the same way it happens for real (CAS-682): a 4th cascade, a
// clone of cascade[0] with .paused=true, still admits its pin through listedBy() (which never checks
// .paused) but recomputeFound excludes a paused cascade from its candidate set entirely — so a film pinned
// only to it lands in the listing with no owner, exactly the divergence that produces a real "Other" stub.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

const FILM_A = 900760001, FILM_A2 = 900760011, FILM_B = 900760002, FILM_C = 900760003, FILM_OTHER = 900760004;
const ALL_FILMS = [FILM_A, FILM_A2, FILM_B, FILM_C, FILM_OTHER];
const PAUSED_CLONE_ID = "cas760-paused-clone";

/** Onboard a fresh streaming roster and return its cascade ids, in `cascades` array order.
 * CAS-1150 requeue: onboarding's own starter roster size has changed since this test was written and can
 * no longer be relied on to produce three agents by itself (seen in CI: 2, not >=3) — pad with clones of
 * the first, the same CAS-682 clone technique addPausedClone below already uses, so the rank-tint
 * assertions always have three real, distinct cascades to rank regardless of how many onboarding itself
 * seeds. rankCascades (below) overwrites every clone's .order anyway, so the duplicated criteria cost
 * nothing here. */
async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => {
    let i = 0;
    while(cascades.length < 3){
      const clone = JSON.parse(JSON.stringify(cascades[0]));
      clone.id = `cas760-extra-${i++}`;
      cascades.push(clone);
    }
    return cascades.map(c => c.id);
  });
}

/** Rank cascadeIds[0..2] 1/2/3 (order 10/20/30), make them status-permissive, and add the paused clone
 * that CAS-682's stub path needs for the "Other" block. */
async function rankCascades(page, cascadeIds){
  await page.evaluate((cascadeIds) => {
    const ord = [10, 20, 30];
    cascadeIds.slice(0, 3).forEach((id, i) => {
      const c = cascades.find(x => x.id === id);
      c.order = ord[i];
      c.status = []; c.listStatus = [];
    });
  }, cascadeIds);
}

async function addPausedClone(page, cascadeIds){
  await page.evaluate(({ cascadeIds, PAUSED_CLONE_ID }) => {
    const clone = JSON.parse(JSON.stringify(cascades.find(c => c.id === cascadeIds[0])));
    clone.id = PAUSED_CLONE_ID; clone.paused = true; clone.order = 999;
    cascades.push(clone);
  }, { cascadeIds, PAUSED_CLONE_ID });
}

async function seedFilm(page, { id, title, status, cascadeId }){
  await page.evaluate(({ id, title, status, cascadeId }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers: [] });
    const e = entryFor(id);
    if(cascadeId) e.pinnedTo = [cascadeId];
    e.wins = { stream: true };
    e.winsSource = { stream: "manual" };
  }, { id, title, status, cascadeId });
}

async function toStreamTab(page){
  await page.evaluate(() => setWatchTab("stream"));
  await page.waitForTimeout(300);   // stream is fillListChunked's own async paint, same as cas754's toTab
}

// CAS-763: the rank class moved from .grouphead.sub onto its .ablock wrapper (the sub-heading and its
// .list now share one block so the tint can paint a lane behind both) — read it off the ancestor.
const subHeadings = page => page.locator(".grouphead.sub").evaluateAll(els => els.map(el => ({
  text: el.textContent.trim(),
  rankClass: [...(el.closest(".ablock")?.classList || [])].find(c => c.startsWith("agrank-")) || null,
})));

test.afterEach(async ({ page }) => {
  await page.evaluate(({ ids, PAUSED_CLONE_ID }) => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
    const ci = cascades.findIndex(c => c.id === PAUSED_CLONE_ID);
    if(ci >= 0) cascades.splice(ci, 1);
    for(let i = cascades.length - 1; i >= 0; i--){
      if(String(cascades[i].id).startsWith("cas760-extra-")) cascades.splice(i, 1);
    }
  }, { ids: ALL_FILMS, PAUSED_CLONE_ID });
});

test("CAS-760 AC1/AC2: three ranked agents get three distinct tints, rank 1 gets the rank-1 tint, stable across a re-render and across status sections", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  expect(cascadeIds.length).toBeGreaterThanOrEqual(3);
  await rankCascades(page, cascadeIds);
  await seedFilm(page, { id: FILM_A, title: "CAS-760 A", status: "upcoming", cascadeId: cascadeIds[0] });
  await seedFilm(page, { id: FILM_A2, title: "CAS-760 A2", status: "included_streaming", cascadeId: cascadeIds[0] });
  await seedFilm(page, { id: FILM_B, title: "CAS-760 B", status: "upcoming", cascadeId: cascadeIds[1] });
  await seedFilm(page, { id: FILM_C, title: "CAS-760 C", status: "upcoming", cascadeId: cascadeIds[2] });
  // CAS-823 (post-dates this spec) restricts the Streaming tab to its own standing (included_streaming)
  // unless widened — real account state, set the way the Filters sheet itself would.
  await page.evaluate(() => { watchAlsoShow.stream.add("upcoming"); render(); });
  await toStreamTab(page);

  const subs = await subHeadings(page);
  const rank1 = subs.filter(s => s.rankClass === "agrank-1");
  const rank2 = subs.filter(s => s.rankClass === "agrank-2");
  const rank3 = subs.filter(s => s.rankClass === "agrank-3");
  // Three distinct tints in use, and the block matching cascadeIds[0] (order 10, rank 1) is the one that
  // got agrank-1 — including its second appearance in the included_streaming section (stability).
  expect(rank1.length).toBe(2);
  expect(rank2.length).toBe(1);
  expect(rank3.length).toBe(1);
  expect(new Set(rank1.map(s => s.text)).size).toBe(1);   // same agent, same tint, in both sections

  // Stable across a re-render.
  await page.evaluate(() => render());
  await page.waitForTimeout(300);
  expect(await subHeadings(page)).toEqual(subs);
});

test("CAS-760 AC3: reordering agents so a different cascade holds rank 1 gives that cascade the rank-1 tint", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  expect(cascadeIds.length).toBeGreaterThanOrEqual(3);
  await rankCascades(page, cascadeIds);
  await seedFilm(page, { id: FILM_A, title: "CAS-760 A", status: "upcoming", cascadeId: cascadeIds[0] });
  await seedFilm(page, { id: FILM_B, title: "CAS-760 B", status: "upcoming", cascadeId: cascadeIds[1] });
  await seedFilm(page, { id: FILM_C, title: "CAS-760 C", status: "upcoming", cascadeId: cascadeIds[2] });
  await page.evaluate(() => { watchAlsoShow.stream.add("upcoming"); render(); });
  await toStreamTab(page);

  const before = await subHeadings(page);
  const rank1Before = before.find(s => s.rankClass === "agrank-1");

  await page.evaluate((cascadeIds) => {
    cascades.find(c => c.id === cascadeIds[0]).order = 30;
    cascades.find(c => c.id === cascadeIds[1]).order = 10;   // cascadeIds[1] now rank 1
    render();
  }, cascadeIds);
  await page.waitForTimeout(300);

  const after = await subHeadings(page);
  const rank1After = after.find(s => s.rankClass === "agrank-1");
  expect(rank1After.text).not.toBe(rank1Before.text);   // colour followed the NEW rank 1, not the old identity
});

test("CAS-760 AC4: a block with no owning cascade renders untinted, and no .gdot/.cap/.wdot carries a rank tint", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  expect(cascadeIds.length).toBeGreaterThanOrEqual(3);
  await rankCascades(page, cascadeIds);
  await addPausedClone(page, cascadeIds);
  await seedFilm(page, { id: FILM_A, title: "CAS-760 A", status: "upcoming", cascadeId: cascadeIds[0] });
  // Pinned only to the paused clone — listedBy() (never checks .paused) still lists it, but recomputeFound
  // excludes a paused cascade from its candidates, so it gets no owner (CAS-682's real stub divergence).
  await seedFilm(page, { id: FILM_OTHER, title: "CAS-760 Other", status: "upcoming", cascadeId: PAUSED_CLONE_ID });
  await page.evaluate(() => { watchAlsoShow.stream.add("upcoming"); render(); });
  await toStreamTab(page);

  const subs = await subHeadings(page);
  const other = subs.find(s => s.text === "Other");
  expect(other).toBeTruthy();
  expect(other.rankClass).toBeNull();

  const taintedDots = await page.locator(".gdot, .cap, .wdot").evaluateAll(els =>
    els.filter(el => [...el.classList].some(c => c.startsWith("agrank-"))).length
  );
  expect(taintedDots).toBe(0);
});

test("CAS-760: every rank tint's computed text colour clears 4.5:1 against --bg", async ({ page }) => {
  await toWatchScreen(page);
  const ratios = await page.evaluate(() => {
    function relLum(hex){
      const c = hex.replace("#", "").match(/.{2}/g).map(x => parseInt(x, 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function parseRgb(s){
      const m = s.match(/[\d.]+/g).map(Number);
      return `#${m.slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("")}`;
    }
    const bgLum = relLum(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    const out = [];
    for(let i = 1; i <= 6; i++){
      // CAS-763: --rt (and so the tinted colour) now comes from the .ablock wrapper, not the heading
      // itself — wrap it the same way the render loop does.
      const wrap = document.createElement("div"); wrap.className = `ablock agrank-${i}`;
      const el = document.createElement("div"); el.className = "grouphead sub";
      wrap.appendChild(el);
      document.body.appendChild(wrap);
      const hex = parseRgb(getComputedStyle(el).color);
      const lum = relLum(hex);
      const L1 = Math.max(lum, bgLum), L2 = Math.min(lum, bgLum);
      out.push((L1 + 0.05) / (L2 + 0.05));
      wrap.remove();
    }
    return out;
  });
  ratios.forEach(ratio => expect(ratio).toBeGreaterThanOrEqual(4.5));
});
