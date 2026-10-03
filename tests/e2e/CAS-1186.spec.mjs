// CAS-1186: Find — the third nav destination, every film in MOVIES searchable by name, reachable even
// when no agent lists it. No agent/tab/service/watched/style/Picked-by narrowing applies here (that's the
// whole point — it's the one listing a film reaches regardless of whether any agent lists it). Built on
// CAS-1185's left-moved menu, which left the chip row reading Watch, Moving.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, numberIn } from "./helpers.mjs";

async function buildListing(page){
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator("#groups .card, #groups .stub").first()).toBeVisible();
}

const findRows = page => page.locator("#findList > [id^='card-']");
const findCount = page => page.locator("#findCount").textContent().then(numberIn);

test("CAS-1186 AC2: opening Find lights findBtn, dims the others, and counts the whole catalogue", async ({ page }) => {
  await buildListing(page);
  await page.locator("#findBtn").click();
  await expect(page.locator("#findScreen")).toHaveClass(/open/);
  await expect(page.locator("#findBtn")).toHaveClass(/active/);
  await expect(page.locator("#moviesBtn")).not.toHaveClass(/active/);
  await expect(page.locator("#movingBtn")).not.toHaveClass(/active/);
  const total = await page.evaluate(() => MOVIES.length);
  expect(await findCount(page)).toBe(total);
});

test("CAS-1186 AC3: the catalogue is paged — at most 50 rows on open, more once the user nears the bottom", async ({ page }) => {
  await buildListing(page);
  await page.locator("#findBtn").click();
  await expect(findRows(page).first()).toBeVisible();
  expect(await findRows(page).count()).toBeLessThanOrEqual(50);

  await page.locator("#findScreen").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll("#findList > [id^='card-']").length > 50, null, { timeout: 5000 });
});

test("CAS-1186 AC4: the list opens sorted by Cascade score, highest first", async ({ page }) => {
  await buildListing(page);
  await page.locator("#findBtn").click();
  await expect(findRows(page).first()).toBeVisible();
  const [s1, s2] = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#findList > [id^='card-']")].slice(0, 2);
    return rows.map(r => cascadeScore(MOVIES.find(m => m.tmdb_id === Number(r.id.replace("card-", "")))));
  });
  expect(s1).toBeGreaterThanOrEqual(s2);
});

test("CAS-1186 AC5: typing filters by title with a matching count, an unmatched search shows the empty state, and clear restores the full list", async ({ page }) => {
  await buildListing(page);
  await page.locator("#findBtn").click();
  await expect(findRows(page).first()).toBeVisible();
  const total = await page.evaluate(() => MOVIES.length);

  const sample = await page.evaluate(() => MOVIES.find(m => m.title.length >= 6).title.slice(0, 4));
  await page.locator("#findSearchInput").fill(sample);
  const expectedCount = await page.evaluate(
    q => MOVIES.filter(m => m.title.toLowerCase().includes(q.toLowerCase())).length, sample);
  expect(await findCount(page)).toBe(expectedCount);
  const allMatch = await findRows(page).evaluateAll(
    (els, q) => els.every(el => (el.querySelector(".titletext, .stubname")?.textContent || "")
      .toLowerCase().includes(q.toLowerCase())),
    sample);
  expect(allMatch).toBe(true);

  await page.locator("#findSearchInput").fill("zzzzqq");
  await expect(page.locator("#findListWrap")).toContainText('No movies match "zzzzqq"');

  await page.locator("#findSearchClear").click();
  expect(await findCount(page)).toBe(total);
  await expect(page.locator("#findSearchInput")).toHaveValue("");
});

test("CAS-1186 AC6: a film no agent lists still appears in Find when searched", async ({ page }) => {
  await buildListing(page);
  const unlistedTitle = await page.evaluate(() => {
    const m = MOVIES.find(m => !cascades.some(c => listedBy(m, c)));
    return m ? m.title : null;
  });
  expect(unlistedTitle).toBeTruthy();

  await page.locator("#findBtn").click();
  await page.locator("#findSearchInput").fill(unlistedTitle);
  await expect(page.locator("#findListWrap")).toContainText(unlistedTitle);
});

test("CAS-1186 AC7: Watch and Moving both close Find in either direction, and reopening Find clears the search", async ({ page }) => {
  await buildListing(page);
  await page.locator("#findBtn").click();
  await page.locator("#findSearchInput").fill("abc");

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#findScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#moviesBtn")).toHaveClass(/active/);

  await page.locator("#findBtn").click();
  await expect(page.locator("#findSearchInput")).toHaveValue("");

  await page.locator("#movingBtn").click();
  await expect(page.locator("#findScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator("#movingBtn")).toHaveClass(/active/);
});

test("CAS-1186 AC8: no console errors across open, page, search and close", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if(m.type() === "error") errors.push(m.text()); });
  await buildListing(page);
  errors.length = 0;   // discard boot/poster noise unrelated to Find (same technique CAS-969.spec.mjs uses)

  await page.locator("#findBtn").click();
  await expect(findRows(page).first()).toBeVisible();
  await page.locator("#findScreen").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  await page.locator("#findSearchInput").fill("the");
  await page.waitForTimeout(200);
  await page.locator("#findSearchClear").click();
  await page.locator("#moviesBtn").click();

  expect(errors).toEqual([]);
});
