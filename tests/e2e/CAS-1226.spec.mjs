// CAS-1226: the Watch top area's layout, judged against the real build at 390 x 844 (devices["iPhone 13"]
// is this suite's default project, so no viewport override is needed). AC5 of the ticket — "judged by eye,
// by Lee" — is a human call this spec can't make; what it CAN check is the measurable shape the patch
// claims: a straight rail through the dot centres (every .stagestop sharing one left edge/width, every
// .gdot sharing one left edge), one lozenge style for both columns (every .watchagentrow the same width,
// .stagecol/.agentcol the same top and height), agent names actually readable (clientHeight >= 10, no
// overflow), and the first stage heading above the list gone.
//
// Real onboarding agent, then renamed/cloned to the four named agents the ticket asks for — same technique
// cas763.spec.mjs uses (a real agent first, cloned via page.evaluate for a fixture roster that still carries
// every account-wide mechanism the Watch screen reads, so this never depends on catalogue-derived taste
// matching).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const AGENT_NAMES = ["Massive Movies", "Personal Favs", "Nominees & Awards", "Family Movies"];
const SEEDED_FILM_IDS = [];

async function toWatchScreenWithFourAgents(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  const cascadeIds = await page.evaluate((names) => {
    const first = cascades[0];
    first.order = 0; first.name = names[0];
    for(let i = 1; i < names.length; i++){
      const clone = JSON.parse(JSON.stringify(first));
      clone.id = `cas1226-agent-${i}`; clone.order = i; clone.name = names[i];
      cascades.push(clone);
    }
    return cascades.map(c => c.id);
  }, AGENT_NAMES);
  return cascadeIds;
}

async function seedFilm(page, { id, title, status, cascadeId }){
  SEEDED_FILM_IDS.push(id);
  await page.evaluate(({ id, title, status, cascadeId }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers: [] });
    const e = entryFor(id);
    e.pinnedTo = [cascadeId];
    e.wins = { stream: true };
    e.winsSource = { stream: "manual" };
  }, { id, title, status, cascadeId });
}

async function toStreamTab(page){
  // CAS-823 (post-dates CAS-763, same mechanism its spec notes): the Streaming tab restricts to its own
  // standing (included_streaming) unless widened — real account state, set the way the Filters sheet itself
  // would, not a status this fixture needs to fake.
  await page.evaluate(() => { watchAlsoShow.stream.add("upcoming"); setWatchTab("stream"); render(); });
  await settleListing(page);
}

test.afterEach(async ({ page }) => {
  await page.evaluate((ids) => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
  }, SEEDED_FILM_IDS.splice(0));
});

test("CAS-1226 AC4: the Watch top block is one coherent grid — straight rail, shared row shape, readable names, no lead heading, no overflow", async ({ page }) => {
  const cascadeIds = await toWatchScreenWithFourAgents(page);
  expect(cascadeIds.length).toBe(4);
  for(let i = 0; i < 4; i++)
    await seedFilm(page, { id: 900122600 + i, title: `CAS-1226 Film ${i}`, status: "upcoming", cascadeId: cascadeIds[i] });
  await toStreamTab(page);

  const result = await page.evaluate(() => {
    const names = [...document.querySelectorAll("#watchTop .watchagentname")];
    const stops = [...document.querySelectorAll("#watchTop .stagestop")];
    const dots = [...document.querySelectorAll("#watchTop .stagestop .gdot")];
    const agentRows = [...document.querySelectorAll("#watchTop .watchagentrow")];
    const stagecol = document.querySelector("#watchTop .stagecol");
    const agentcol = document.querySelector("#watchTop .agentcol");
    const leadHead = document.querySelector("#groups > .group:first-child > .grouphead:not(.sub)");
    return {
      names: names.map(el => ({ clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
      stopRects: stops.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, width: r.width }; }),
      dotLefts: dots.map(el => el.getBoundingClientRect().left),
      agentRowWidths: agentRows.map(el => el.getBoundingClientRect().width),
      stageTop: stagecol.getBoundingClientRect().top,
      stageHeight: stagecol.getBoundingClientRect().height,
      agentTop: agentcol.getBoundingClientRect().top,
      agentHeight: agentcol.getBoundingClientRect().height,
      leadHeadVisible: !!leadHead && leadHead.offsetParent !== null,
      docScrollWidth: document.documentElement.scrollWidth,
      winInnerWidth: window.innerWidth,
      agentRowCount: agentRows.length,
    };
  });

  // Agent names: every lozenge actually shows its name — tall enough to read, never clipped.
  expect(result.names.length).toBe(4);
  result.names.forEach(n => {
    expect(n.clientHeight).toBeGreaterThanOrEqual(10);
    expect(n.scrollWidth).toBeLessThanOrEqual(n.clientWidth);
  });

  // The rail: every stage stop shares one left edge and one width.
  expect(result.stopRects.length).toBeGreaterThan(0);
  const stopLeft0 = result.stopRects[0].left, stopWidth0 = result.stopRects[0].width;
  result.stopRects.forEach(r => {
    expect(Math.abs(r.left - stopLeft0)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.width - stopWidth0)).toBeLessThanOrEqual(1);
  });
  // Every dot sits on the same line — one shared left edge.
  expect(result.dotLefts.length).toBeGreaterThan(0);
  const dotLeft0 = result.dotLefts[0];
  result.dotLefts.forEach(l => expect(Math.abs(l - dotLeft0)).toBeLessThanOrEqual(1));

  // One lozenge style for both columns: every agent row the same width.
  expect(result.agentRowCount).toBe(4);   // AC2/AC3: every agent shows, no "+N more" overflow row
  const rowWidth0 = result.agentRowWidths[0];
  result.agentRowWidths.forEach(w => expect(Math.abs(w - rowWidth0)).toBeLessThanOrEqual(1));

  // The stage column and agent column sit on the same top and the same height.
  expect(Math.abs(result.stageTop - result.agentTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.stageHeight - result.agentHeight)).toBeLessThanOrEqual(1);

  // The first stage heading above the list is gone.
  expect(result.leadHeadVisible).toBe(false);

  // No block anywhere on the page pushes the document wider than the viewport.
  expect(result.docScrollWidth).toBeLessThanOrEqual(result.winInnerWidth);
});
