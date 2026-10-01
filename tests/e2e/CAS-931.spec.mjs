// CAS-931: Recommend Cascade hosts the CAS-928 friend picker (its own selMap, independent of the
// Invite sheet's) in place of the old single Name+Email pair, and can send to several people at once —
// one recommendations row per selected recipient who has an email, a WhatsApp/SMS device hand-off for a
// mobile-only recipient, and a Done button (not Cancel) once it has sent.
//
// Same direct-CascadeAuth-mutation technique as CAS-884.spec.mjs/CAS-930.spec.mjs (see those files' own
// header comments for why): sendRecommend's onclick reads window.CascadeAuth synchronously, so a client
// that exists before the listing renders is all that's needed here too.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

async function primeFakeAccount(page){
  await page.evaluate(() => {
    window.__recommendInserts = [];
    window.__friendInserts = [];
    window.__friendUpdates = [];
    window.__opens = [];
    window.open = (url) => { window.__opens.push(url); return { closed: false }; };
    window.CascadeAuth.enabled = true;
    window.CascadeAuth.status = "signed-in";
    window.CascadeAuth.user = { id: "cas931-user", email: "lee@example.com" };
    window.CascadeAuth.session = { user: { id: "cas931-user" } };
    window.CascadeAuth.client = { from: (table) => {
      if(table === "friends") return {
        insert: (rows) => ({ select: () => ({ single: () => {
          const row = { id: 900 + window.__friendInserts.length + 1, ...rows[0] };
          window.__friendInserts.push(row);
          return Promise.resolve({ data: row, error: null });
        } }) }),
        update: (fields) => ({ eq: (_col, id) => { window.__friendUpdates.push({ id, ...fields }); return Promise.resolve({ data: null, error: null }); } }),
      };
      return {
        insert: (rows) => {
          if(table !== "recommendations") return Promise.resolve({ data: [], error: null });
          window.__recommendInserts.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        },
      };
    } };
  });
}

/** Signed in (faked, see primeFakeAccount), landed on the listing with the nav menu reachable. */
async function signedInListing(page){
  await toShortlist(page, "cinema");
  await primeFakeAccount(page);
  await finishFlow(page);
  await toListing(page);
}

async function openRecommendSheet(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Recommend Cascade" }).click();
  await expect(page.locator("#recommend")).toHaveClass(/open/);
}

/** Opens the Recommend sheet's "+ Add someone new" form, adds an email friend, and returns to the
 * picker with them selected (same technique as CAS-930.spec.mjs's addAndSelectEmailFriend). */
async function addAndSelectEmailFriend(page, name, email){
  await page.locator('#recommendBody button:has-text("Add someone new")').click();
  await page.locator("#ffName").fill(name);
  await page.locator("#ffEmail").fill(email);
  const before = await page.evaluate(() => window.__friendInserts.length);
  await page.locator('#recommendBody button:has-text("Add and select")').click();
  await page.waitForFunction(n => window.__friendInserts.length > n, before, { timeout: 5000 });
}

/** Same, but a mobile-only friend — no email means the picker defaults their channel to WhatsApp. */
async function addAndSelectMobileFriend(page, name, mobile){
  await page.locator('#recommendBody button:has-text("Add someone new")').click();
  await page.locator("#ffName").fill(name);
  await page.locator("#ffMobile").fill(mobile);
  const before = await page.evaluate(() => window.__friendInserts.length);
  await page.locator('#recommendBody button:has-text("Add and select")').click();
  await page.waitForFunction(n => window.__friendInserts.length > n, before, { timeout: 5000 });
}

// AC(a)/AC(b): three email friends -> three recommendations rows, each with that friend's own email
// and name, and the same message (CAS-1125: the message no longer greets anyone by name).
test("CAS-931 ACa/ACb: three email friends -> three recommendations, each with the same message", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);

  await addAndSelectEmailFriend(page, "Sam", "sam@example.com");
  await addAndSelectEmailFriend(page, "Priya", "priya@example.com");
  await addAndSelectEmailFriend(page, "Mum", "mum@example.com");
  await expect(page.locator("#recommendSend")).toContainText("Recommend to 3 people");

  await page.locator("#recommendSend").click();
  await page.waitForFunction(() => window.__recommendInserts.length >= 3, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__recommendInserts);
  expect(rows.length).toBe(3);
  expect(rows.map(r => r.to_name).sort()).toEqual(["Mum", "Priya", "Sam"]);
  rows.forEach(r => {
    expect(r.to_email).toBe({ Sam: "sam@example.com", Priya: "priya@example.com", Mum: "mum@example.com" }[r.to_name]);
    expect(r.message).toContain("Cascade");
  });
  expect(new Set(rows.map(r => r.message)).size).toBe(1);
});

// AC(c): after sending, the header shows Done and not Cancel.
test("CAS-931 ACc: after sending, the header shows Done, not Cancel", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);

  await addAndSelectEmailFriend(page, "Priya", "priya@example.com");
  await page.locator("#recommendSend").click();
  await page.waitForFunction(() => window.__recommendInserts.length > 0, null, { timeout: 5000 });

  await expect(page.locator("#recommendClose")).toHaveText("Done");
  await expect(page.locator("#recommendClose")).not.toHaveText("Cancel");
  await expect(page.locator("#recommendBody")).toContainText("Recommended to 1 person");
});

// AC(e)/AC(d): a mobile-only recipient produces no recommendations row and instead opens a wa.me/sms
// URL carrying the message and the cascademovies.com link — never an App Store URL, since there is no
// listing yet.
test("CAS-931 ACd/ACe: a mobile-only recipient gets no recommendations row, opens a wa.me link with the cascademovies.com URL", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);

  await addAndSelectMobileFriend(page, "Dex", "0433 221 109");
  await expect(page.locator("#recommendSend")).toContainText("Recommend to 1 person");

  await page.locator("#recommendSend").click();
  await page.waitForFunction(() => window.__opens.length > 0, null, { timeout: 5000 });

  expect(await page.evaluate(() => window.__recommendInserts.length)).toBe(0);

  const opens = await page.evaluate(() => window.__opens);
  expect(opens.length).toBe(1);
  expect(opens[0]).toMatch(/^https:\/\/wa\.me\/61433221109\?text=/);
  const decoded = decodeURIComponent(opens[0]);
  expect(decoded).toContain("https://cascademovies.com");
  expect(decoded).not.toContain("apps.apple.com");
  expect(decoded).not.toMatch(/App Store/i);
});

// AC(a) cap: selecting a 21st recipient is refused (INVITE_MAX_RECIPIENTS, shared with the Invite sheet).
test("CAS-931: selecting a 21st recipient is refused and inserts nothing", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);

  await page.evaluate(() => {
    friends.length = 0;
    for(let i = 1; i <= 21; i++) friends.push({ id: i, name: `Friend${i}`, email: `f${i}@example.com` });
    recommendFriendSel = new Map();
    for(let i = 1; i <= 20; i++) recommendFriendSel.set(String(i), { channel: "email" });
    renderRecommendForm();
  });
  await expect(page.locator("#recommendSend")).toContainText("Recommend to 20 people");

  await page.locator('.frow[data-fid="21"]').click();

  await expect(page.locator("#recommendErr")).toBeVisible();
  expect(await page.evaluate(() => recommendFriendSel.size)).toBe(20);
  expect(await page.evaluate(() => window.__recommendInserts.length)).toBe(0);
});

// Invite's own picker and Recommend's own picker are independent — selecting someone in one never
// selects them in the other.
test("CAS-931: Recommend's picker selection is independent of the Invite sheet's", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);
  await addAndSelectEmailFriend(page, "Priya", "priya@example.com");
  await expect(page.locator("#recommendSend")).toContainText("Recommend to 1 person");

  const inviteSelSize = await page.evaluate(() => inviteFriendSel.size);
  expect(inviteSelSize).toBe(0);
});
