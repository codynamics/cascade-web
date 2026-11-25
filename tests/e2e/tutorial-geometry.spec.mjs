// CAS-1582: position + stability checks for every step of every tutorial, WebKit iPhone 13 at 390x844.
// tutorials.spec.mjs (CAS-1551) proves each step is reached; this proves each step LANDS: the ring is on its
// target, the bubble's arrow points at the target, the bubble is on screen and clear of it, and nothing moves
// once the bubble is drawn. Walks watch, moods, alerts, database, agent and invite as a new member would
// (fresh onboarding, then Menu -> Tutorials -> the row).
//
// KEEP CURRENT: any ticket that adds, removes or changes a tour step (TOURS in index.html) updates this spec
// in the same commit — see CC_AUTONOMY.md "Test upkeep".
//
// Screenshots: qa-artifacts/tutorials/<tour>-<step>.png (one per step, for human review).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { guestOnboarded } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

const TOUR_KEYS = ["watch", "moods", "alerts", "database", "agent", "invite"];
const OUT = "qa-artifacts/tutorials";
const RING_TOL = 4;     // px: ring vs target (after the ring's own padding)
const MOVE_TOL = 2;     // px: bubble / arrow / target may not move between first show and +500 ms

async function fakeSignedIn(page){
  await page.evaluate(() => {
    const a = window.CascadeAuth;
    a.enabled = true; a.status = "signed-in";
    a.user = { id: "cas1582-user", email: "cas1582@example.com", created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() };
    tutSeenMap = {}; tutVisitShown = false;
    render();
  });
}

// The made lists a member who named a streaming service and a favourite director gets from the first-run
// questions (oneAgentStarterMoods: ids topsvc / fav-person), plus the service itself. The one-agent walk the
// shared helpers do answers neither question; without them four steps' targets do not exist.
async function seedSetupAnswers(page){
  await page.evaluate(() => {
    const svc = PRIMARY_SUB_SERVICES[0], ages = (watchMoods[0] && watchMoods[0].ages) || [];
    prefs.sub.add(svc);
    watchMoods = [...watchMoods,
      { ...oamMoodDefaultFields(), id: "topsvc", name: oafSvcTagName(svc).slice(0, 24), svc, show: "40", ages, watched: true },
      { ...oamMoodDefaultFields(), id: "fav-person", name: "Christopher Nolan", people: "Christopher Nolan", show: "all", ages, watched: true }];
    render();
  });
}

async function startFromMenu(page, key){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Tutorials" }).click();
  await expect(page.locator("#tutorialsScreen")).toHaveClass(/open/);
  await page.locator(`#tutorialsScreen .tutrow[onclick*="'${key}'"]`).click();
  await expect(page.locator("#tutScrim")).toHaveClass(/open/);
}

// Everything the checks need, read in one synchronous pass so the numbers belong together.
function snapshot(page){
  return page.evaluate(() => {
    const R = el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const step = tutSteps[tutIdx] || {};
    const els = (tutCurrent && tutCurrent.els) || [];
    const card = document.getElementById("tutCard"), arrow = document.getElementById("tutArrow");
    const hole = document.getElementById("tutHole");
    const rings = [];
    if(hole && !hole.classList.contains("none") && !hole.classList.contains("multi")) rings.push(R(hole));
    document.querySelectorAll("#tutMarks .tutring:not(.shut)").forEach(e => rings.push(R(e)));
    // Every horizontally/vertically scrolling ancestor of every target, plus the page itself: if any of these is
    // still moving when the bubble is drawn, the arrow was placed from a box that is about to be stale.
    const scrolls = [["window", scrollX + "," + scrollY]];
    els.forEach((el, i) => {
      for(let p = el.parentElement; p && p !== document.body; p = p.parentElement)
        if(p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1)
          scrolls.push([`t${i}:${p.id || p.className || p.tagName}`, p.scrollLeft + "," + p.scrollTop]);
    });
    const dir = arrow.classList.contains("up") ? "up" : arrow.classList.contains("down") ? "down" : "";
    // The arrow is a 16px square rotated 45deg: its bounding box is centred on the tip's x, and its visible
    // point is the top (dir "up") or bottom (dir "down") vertex.
    const ar = R(arrow);
    return {
      centre: !!step.center,
      sel: (step.sel || []).join(" | "),
      text: document.getElementById("tutText").textContent.trim().slice(0, 50),
      pad: els.length > 1 ? 1 : 6,
      targets: els.map(e => ({ ...R(e), cls: (e.className && e.className.baseVal === undefined ? e.className : "") })),
      shut: els.map(e => tutShut.has(e)),
      rings, card: R(card), arrow: ar, dir,
      tip: { x: ar.x + ar.w / 2, y: dir === "up" ? ar.y : ar.y + ar.h },
      cardOpacity: Number(getComputedStyle(card).opacity),
      scrolls, vw: innerWidth, vh: innerHeight,
    };
  });
}

const near = (a, b, t) => Math.abs(a - b) <= t;
const boxMoved = (a, b) => ["x", "y", "w", "h"].some(k => Math.abs(a[k] - b[k]) > MOVE_TOL);
const inside = (b, vw, vh) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= vw + 0.5 && b.y + b.h <= vh + 0.5;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for(const key of TOUR_KEYS){
  test(`CAS-1582 tutorial geometry: every ${key} step lands on its target and holds still`, async ({ page }) => {
    fs.mkdirSync(OUT, { recursive: true });
    await guestOnboarded(page);
    await seedSetupAnswers(page);
    if(key === "invite") await fakeSignedIn(page);
    await startFromMenu(page, key);

    const total = await page.evaluate(() => tutSteps.length);
    const faults = [];
    for(let i = 0; i < total; i++){
      const n = i + 1, who = `${key} step ${n}/${total}`;
      // No silent skip: the engine must be exactly on step i.
      const idx = await page.evaluate(() => tutIdx);
      if(idx !== i){
        const sel = await page.evaluate(k => { const st = TOURS[k].steps.filter(s => !s.needsAccount || window.CascadeAuth.status === "signed-in")[0]; return st && (st.sel || []).join(" | "); }, key);
        faults.push(`${who}: skipped silently (tutIdx is ${idx}; a target is missing${i === 0 ? ", e.g. " + sel : ""})`);
        break;
      }
      await expect.poll(async () => (await snapshot(page)).cardOpacity, { message: `${who}: bubble shows` }).toBeGreaterThan(0.99);

      const a = await snapshot(page);                  // first shown
      await page.waitForTimeout(500);
      const b = await snapshot(page);                  // +500 ms: the settled state the geometry checks use
      await page.screenshot({ path: `${OUT}/${key}-${n}.png` });
      const lbl = `${who} ("${b.text}")`;

      // 5. stability
      if(boxMoved(a.card, b.card)) faults.push(`${lbl}: bubble moved ${JSON.stringify(a.card)} -> ${JSON.stringify(b.card)}`);
      if(boxMoved(a.arrow, b.arrow) || a.dir !== b.dir) faults.push(`${lbl}: arrow moved ${JSON.stringify(a.arrow)} -> ${JSON.stringify(b.arrow)}`);
      if(a.targets.length === b.targets.length) a.targets.forEach((t, j) => {
        if(boxMoved(t, b.targets[j])) faults.push(`${lbl}: target ${j} moved ${JSON.stringify(t)} -> ${JSON.stringify(b.targets[j])}`);
      });
      if(JSON.stringify(a.scrolls) !== JSON.stringify(b.scrolls)) faults.push(`${lbl}: still scrolling when the bubble was drawn ${JSON.stringify(a.scrolls)} -> ${JSON.stringify(b.scrolls)}`);

      // 4. the bubble is on screen
      if(!inside(b.card, b.vw, b.vh)) faults.push(`${lbl}: bubble outside the viewport ${JSON.stringify(b.card)}`);
      if(!(b.centre || !b.targets.length)){          // a centred card points at nothing

      // 1. target visible and fully inside the viewport
      // A step naming several targets in a scrolling row may have more than fit (long list names): then at
      // least the first must be whole and the rest at least partly on screen.
      b.targets.forEach((t, j) => {
        const partly = t.x + t.w > 0 && t.x < b.vw && t.y + t.h > 0 && t.y < b.vh;
        const lenient = b.targets.length > 1 && j > 0;
        if(t.w <= 0 || t.h <= 0) faults.push(`${lbl}: target ${j} of ${b.sel} is not visible`);
        else if(lenient ? !partly : !inside(t, b.vw, b.vh)) faults.push(`${lbl}: target ${j} of ${b.sel} is not ${lenient ? "on" : "fully inside"} the viewport ${JSON.stringify(t)}`);
      });
      // 2. every target has a ring on it (ring = target grown by the step's padding)
      b.targets.forEach((t, j) => {
        if(b.shut[j]) return;
        const want = { x: t.x - b.pad, y: t.y - b.pad, w: t.w + b.pad * 2, h: t.h + b.pad * 2 };
        const ok = b.rings.some(r => ["x", "y", "w", "h"].every(k => near(r[k], want[k], RING_TOL)));
        if(!ok) faults.push(`${lbl}: no highlight ring on target ${j} of ${b.sel} ${JSON.stringify(t)}; rings ${JSON.stringify(b.rings)}`);
      });
      // 3. the arrow tip is inside a target the arrow can point at (one that is on screen)
      const live = b.targets.filter(t => t.w > 0 && t.x + t.w > 0 && t.x < b.vw);
      const tipOn = live.some(t => b.tip.x >= t.x && b.tip.x <= t.x + t.w);
      if(!b.dir) faults.push(`${lbl}: no arrow`);
      else if(!tipOn) faults.push(`${lbl}: arrow tip (${b.tip.x.toFixed(0)},${b.tip.y.toFixed(0)}) is not on any target of ${b.sel}: ${JSON.stringify(live)}`);
      // 4b. the bubble does not cover the target
      b.targets.forEach((t, j) => { if(overlaps(b.card, t)) faults.push(`${lbl}: bubble overlaps target ${j} of ${b.sel}`); });

      }
      if(i < total - 1){
        await page.locator("#tutNextBtn").click();
        await expect.poll(() => page.evaluate(() => tutIdx), { message: `${who}: Next moved on` }).not.toBe(i);
      }
    }
    expect(faults, faults.join("\n")).toEqual([]);
  });
}
