// CAS-1691 / CAS-1699: onboarding is welcome, who, services, topSvc, favourites, people, done — the "Who watches movies
// with you?" tiles are the controls, genres start Off, and there are no together/family screens.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const readLog = page => page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
const shownKeys = async page => (await readLog(page)).filter(e => e.type === "onbstep_shown").map(e => e.step.replace(/^oaf_/, ""));
const pill = (page, field, val) => page.locator(`.whopill[data-field="${field}"][data-val="${val}"]`);
const tile = (page, who) => page.locator(`.whotile[data-who="${who}"]`);

test.use({ viewport: { width: 390, height: 844 } });

// Walks welcome -> who (partner + kids on, 18+) -> services (two streaming) -> topSvc -> favourites, returning the CTA.
async function toFavourites(page, { partner = true, kids = true } = {}){
  await page.evaluate(() => window.oafOpen());
  const cta = page.locator("#oafCta");
  await cta.click();                                           // welcome -> who
  await pill(page, "age", "18plus").click();
  if(partner) await tile(page, "partner").click();
  if(kids) await tile(page, "children").click();
  await cta.click();                                           // who -> services
  await page.evaluate(() => { prefs.sub.clear(); [...SUB_SERVICES].slice(0, 2).forEach(s => prefs.sub.add(s)); });
  await cta.click();                                           // services -> topSvc
  await page.locator("#oafTopSvcOpts .chip").first().click();
  await cta.click();                                           // topSvc -> favourites
  await expect(page.locator("#oafInner .osh")).toHaveText("Your favourite genres");
  return cta;
}

test("CAS-1699 AC1: partner on, kids on, 18+, two streaming services — exact step sequence; no together/family", async ({ page }) => {
  await freshApp(page);
  const cta = await toFavourites(page);
  await page.locator('.favcell[data-style="Action"] .favtoggle').click();
  await cta.click();                                           // favourites -> people
  await cta.click();                                           // people -> done
  await expect(page.locator("#oafInner .osh")).toHaveText("Your agent is ready.");
  expect(await shownKeys(page)).toEqual(["welcome", "who", "services", "topSvc", "favourites", "people", "done"]);
  expect(await page.evaluate(() => oafCountedKeys())).toEqual(["welcome", "who", "services", "topSvc", "favourites", "people", "done"]);
  expect(await page.evaluate(() => [...oafState.where].sort())).toEqual(["cinema", "rent", "stream"]);
  expect(await page.locator("#oafInner input").count()).toBe(0);
});

test("CAS-1699 AC2: the partner tile toggles; Under 18 disables Young kids and sets children to no", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  const cta = page.locator("#oafCta");
  await cta.click();                                           // welcome -> who
  await expect(page.locator("#oafInner .osh")).toHaveText("Who watches movies with you?");
  await expect(page.locator(".whotile")).toHaveCount(3);
  await expect(page.locator(".whotile.lit")).toHaveCount(1);   // Just me is the only lit tile
  await expect(page.locator(".whopill.on")).toHaveCount(0);    // no age preselected
  await expect(cta).toBeDisabled();
  expect(await page.evaluate(() => [oafState.partner, oafState.children])).toEqual(["no", "no"]);
  await tile(page, "partner").click();
  expect(await page.evaluate(() => oafState.partner)).toBe("yes");
  await expect(tile(page, "partner")).toHaveClass(/lit/);
  await tile(page, "partner").click();
  expect(await page.evaluate(() => oafState.partner)).toBe("no");
  await expect(tile(page, "partner")).not.toHaveClass(/lit/);
  await pill(page, "age", "18plus").click();
  await expect(cta).toBeEnabled();
  await tile(page, "children").click();
  expect(await page.evaluate(() => oafState.children)).toBe("yes");
  await pill(page, "age", "under18").click();
  await expect(tile(page, "children")).toHaveAttribute("aria-disabled", "true");
  expect(await page.evaluate(() => oafState.children)).toBe("no");
  await tile(page, "children").click({ force: true });
  expect(await page.evaluate(() => oafState.children)).toBe("no");
});

test("CAS-1699 AC3: genres start Off and Continue is disabled until one is switched on", async ({ page }) => {
  await freshApp(page);
  const cta = await toFavourites(page, { partner: false, kids: false });
  expect(await page.evaluate(() => oafFavCount())).toBe(0);
  await expect(page.locator("#oafFavGrid .favcell.on")).toHaveCount(0);
  await expect(cta).toBeDisabled();
  await page.locator('.favcell[data-style="Drama"] .favbtn.check').click();
  await expect(cta).toBeEnabled();
});

test("CAS-1699 AC4: partner and kids on, no other edits — the Partner and Family lists carry the preselection defaults", async ({ page }) => {
  await freshApp(page);
  const cta = await toFavourites(page);
  await page.locator('.favcell[data-style="Action"] .favtoggle').click();
  await cta.click();                                           // favourites -> people
  await cta.click();                                           // people -> done
  await page.evaluate(() => window.oafStartWatching());
  const lists = await page.evaluate(() => ({
    date: watchMoods.find(m => m.id === "date"), family: watchMoods.find(m => m.id === "family"),
    together: ONE_AGENT_TOGETHER_DEFAULT, fam: ONE_AGENT_FAMILY_DEFAULT,
  }));
  expect(lists.date).toBeTruthy();
  expect(lists.family).toBeTruthy();
  expect([...lists.date.styles].sort()).toEqual([...lists.together].sort());
  expect([...lists.family.styles].sort()).toEqual([...lists.fam].sort());
});

test("CAS-1699 AC5: the done box lists only the person's own genres, favourites first", async ({ page }) => {
  await freshApp(page);
  const cta = await toFavourites(page);
  await page.locator('.favcell[data-style="Drama"] .favbtn.check').click();
  await page.locator('.favcell[data-style="Action"] .favbtn.heart').click();
  await cta.click();                                           // favourites -> people
  await cta.click();                                           // people -> done
  await expect(page.locator("#oafInner .osh")).toHaveText("Your agent is ready.");
  const chips = await page.locator("#oafInner .oafdrow.genres .oafdtag:not(.more)").allTextContents();
  expect(chips.map(t => t.trim())).toEqual(["♥ Action", "Drama"]);
  // The agent still carries the Partner/Family-only genres, they are just not listed.
  expect(await page.evaluate(() => Object.keys(oneAgentBuildDraft().styles).length)).toBeGreaterThan(2);
});

test("CAS-1699 AC6/AC7: the sign-up screen has the poster fan and count, no Membership heading; the code step button is Continue", async ({ page }) => {
  await freshApp(page);
  const cta = await toFavourites(page);
  await page.locator('.favcell[data-style="Action"] .favtoggle').click();
  await cta.click();                                           // favourites -> people
  await cta.click();                                           // people -> done
  await expect(page.locator("#oafInner .osh")).toHaveText("Your agent is ready.");
  // A brand-new signed-out visitor on a configured build sees the email-entry variant: membNeedsEmail() is true.
  await page.evaluate(() => { window.CascadeAuth = Object.assign(window.CascadeAuth || {}, { enabled: true, status: "signed-out" }); });
  const doneCount = await page.evaluate(() => oafDoneFound);
  await cta.click();                                           // Proceed -> membership
  await expect(page.locator("#membScreen.open")).toBeVisible();
  const scr = page.locator("#membScreen");
  await expect(scr.locator(".membh")).toHaveText("Become a member");
  await expect(scr.locator(".oafdposters .oafdposter")).toHaveCount(5);
  await expect(scr.locator(".oafdposters .oafdmore")).toHaveText("+ more");
  await expect(scr.locator(".membwait")).toHaveText(`${doneCount.toLocaleString()} films waiting for you`);
  await expect(scr.locator(".membfree")).toHaveText("Your first month is free.");
  const text = await scr.innerText();
  expect(text).toContain("films waiting for you");
  expect(text).toContain("By becoming a member you agree");
  expect(text).not.toContain("By continuing");
  expect(await scr.locator(".membtop").count()).toBe(0);
  expect(await scr.locator("h2", { hasText: /^Membership$/ }).count()).toBe(0);
  await expect(page.locator("#membEmail")).toBeVisible();
  await expect(page.locator(".membcta")).toHaveText("Become a member");
  for(const loc of ["#membPromoLink", '#membScreen .pnote button[onclick^="openPrivacy"]', '#membScreen .pnote a.linkbtn']){
    const el = page.locator(loc);
    expect(await el.evaluate(e => getComputedStyle(e).textDecorationLine)).toBe("none");
    await el.hover();
    expect(await el.evaluate(e => getComputedStyle(e).textDecorationLine)).toBe("none");
    expect(Number(await el.evaluate(e => getComputedStyle(e).fontWeight))).toBeGreaterThanOrEqual(700);
  }
  // The code step (State B): Check your email, with the primary button reading Continue.
  await page.evaluate(() => membShowCodeState("someone@example.com"));
  await expect(scr.locator(".membh")).toHaveText("Check your email");
  await expect(page.locator(".membcta")).toHaveText("Continue");
  expect(await scr.locator(".membtop").count()).toBe(0);
  await page.evaluate(() => membBackToEmail());
  await expect(page.locator(".membcta")).toHaveText("Become a member");
});

test("CAS-1699: Under 18, no partner, one service — welcome, who, services, favourites, people, done", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => window.oafOpen());
  const cta = page.locator("#oafCta");
  await cta.click();
  await pill(page, "age", "under18").click();
  await cta.click();
  await page.evaluate(() => { prefs.sub.clear(); prefs.sub.add([...SUB_SERVICES][0]); });
  await cta.click();                                           // services -> favourites
  await page.locator('.favcell[data-style="Action"] .favtoggle').click();
  await cta.click();                                           // favourites -> people
  await cta.click();                                           // people -> done
  expect(await shownKeys(page)).toEqual(["welcome", "who", "services", "favourites", "people", "done"]);
});
