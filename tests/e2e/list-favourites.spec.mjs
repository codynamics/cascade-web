// CAS-1690: the list sheet's genre section is the onboarding Off / Include / Favourite control, at 390x844.
// (a) no five-stop track, one .favcell per ONE_AGENT_SETUP_STYLES genre; (b) tapping ♥ on a genre then Save makes
// that genre's cards in the list show "♥ <Genre>" in the metaline.
import { test, expect } from "@playwright/test";
import { guestOnboarded } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 } });

async function openSheet(page){
  await guestOnboarded(page);
  await page.evaluate(() => {
    // v2 one-agent cards only draw for a signed-in account (cardTopHTML gates oneAgentC on accountActive()).
    window.CascadePersistence.accountActive = () => true;
    const al = { cinema:false, rent:false, stream:false };
    cascades.length = 0;
    cascades.push({ id: cascadeNewId(), name: "Agent", v: 2, combo: {}, seenAdj: {}, seenAdjAt: {}, dismissed: [],
      styles: Object.fromEntries(ALL_GENRES.map(g => [g, { bar: 1, al }])) });
    saveCascades();
    setActive(cascades[0].id);
    watchMoods = [{ ...oamMoodDefaultFields(), id: "cas1690", name: "Favs", styles: [], favs: [] }];
    watchMoodSel = "cas1690";
    watchTab = "stream";
    render();
    window.openOamMoodSheetFor("cas1690");
    if (!oamSecOpen.has("primary")) window.oamToggleSec("primary");
  });
  await expect(page.locator("#watchSheet")).toHaveClass(/open/);
  await expect(page.locator("#watchSheetBody .favcell").first()).toBeVisible();
}

test("CAS-1690 AC2a: no five-stop track, one favcell per setup genre", async ({ page }) => {
  await openSheet(page);
  await expect(page.locator("#watchSheetBody .lvseg, #watchSheetBody .oamlvltrack, #watchSheetBody .oamlvlall")).toHaveCount(0);
  const want = await page.evaluate(() => ONE_AGENT_SETUP_STYLES.length);
  await expect(page.locator("#watchSheetBody .favcell")).toHaveCount(want);
});

test("CAS-1690 AC2b: tapping ♥ on a genre then Save shows '♥ <Genre>' in that genre's cards", async ({ page }) => {
  await openSheet(page);
  const genre = await page.evaluate(() => {
    const c = oneAgentCriteria(), mood = currentOamMood();
    const g = ONE_AGENT_SETUP_STYLES.find(x => MOVIES.some(m => showable(m) && filmMatchesWatchTab(m, "stream") && (m.genres || [])[0] === x && filmInOneAgentMood(m, mood, c)));
    return g || null;
  });
  test.skip(!genre, "no streaming film in this catalogue to carry a ♥ genre");
  const cell = page.locator(`#watchSheetBody .favcell[data-style="${genre}"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.locator('[data-pick="fav"]').click();
  await page.locator("#watchSheetBody .donebtn").click();
  const found = await page.evaluate(g => {
    const mood = currentOamMood();
    const m = oamVisibleRows().rows.find(x => (x.genres || [])[0] === g);
    return { favs: mood.favs, html: m ? cardHTML(m, false, { inWatch: true }) : "" };
  }, genre);
  expect(found.favs).toContain(genre);
  expect(found.html).toContain(`<span class="favgenre">♥ ${genre}</span>`);
});
