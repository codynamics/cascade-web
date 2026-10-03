// CAS-930: Invite several friends at once, sent by Cascade. Extends CAS-883/CAS-928's Invite sheet
// (one #filmInvite, hosting the CAS-928 friend picker) into a real multi-recipient send: one invites
// row per selected recipient, an email recipient's own row queued into invite_emails for the new
// outgoing-email workflow step (monitor/invitemail.py) to actually send, and a WhatsApp/SMS
// recipient's own device app opened instead (one at a time, never several window.open calls at once).
//
// Same direct-CascadeAuth-mutation technique as CAS-883.spec.mjs (see that file's own header comment
// for why): the card roster bakes in signed-in state at CARD-CREATE time, so a config.js/supabase-js
// network race can't be used here.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

async function primeFakeAccount(page){
  await page.evaluate(() => {
    window.__inviteInserts = [];
    window.__inviteEmailInserts = [];
    window.__friendInserts = [];
    window.__opens = [];
    window.open = (url) => { window.__opens.push(url); return { closed: false }; };
    window.CascadeAuth.enabled = true;
    window.CascadeAuth.status = "signed-in";
    window.CascadeAuth.user = { id: "cas930-user", email: "cas930@example.com" };
    window.CascadeAuth.session = { user: { id: "cas930-user" } };
    window.CascadeAuth.client = { from: (table) => {
      if(table === "friends") return {
        insert: (rows) => ({ select: () => ({ single: () => {
          const row = { id: 900 + window.__friendInserts.length + 1, ...rows[0] };
          window.__friendInserts.push(row);
          return Promise.resolve({ data: row, error: null });
        } }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
      if(table === "invite_emails") return {
        insert: (rows) => { window.__inviteEmailInserts.push(...rows); return Promise.resolve({ data: rows, error: null }); },
      };
      return {
        insert: (rows) => {
          if(table !== "invites") return Promise.resolve({ data: [], error: null });
          window.__inviteInserts.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        },
      };
    } };
  });
}

/** Opens the Invite sheet's "+ Add someone new" form, adds an email friend, and returns to the
 * picker with them selected (same technique as CAS-883.spec.mjs's addAndSelectFriend). */
async function addAndSelectEmailFriend(page, name, email){
  await page.locator('#filmInviteBody button:has-text("Add someone new")').click();
  await page.locator("#ffName").fill(name);
  await page.locator("#ffEmail").fill(email);
  const before = await page.evaluate(() => window.__friendInserts.length);
  await page.locator('#filmInviteBody button:has-text("Add and select")').click();
  await page.waitForFunction(n => window.__friendInserts.length > n, before, { timeout: 5000 });
}

/** Same, but a mobile-only friend — no email means the picker defaults their channel to WhatsApp. */
async function addAndSelectMobileFriend(page, name, mobile){
  await page.locator('#filmInviteBody button:has-text("Add someone new")').click();
  await page.locator("#ffName").fill(name);
  await page.locator("#ffMobile").fill(mobile);
  const before = await page.evaluate(() => window.__friendInserts.length);
  await page.locator('#filmInviteBody button:has-text("Add and select")').click();
  await page.waitForFunction(n => window.__friendInserts.length > n, before, { timeout: 5000 });
}

async function signedInListing(page){
  await toShortlist(page, "cinema");
  await primeFakeAccount(page);
  await finishFlow(page);
  await toListing(page);
}

async function openInviteSheet(page){
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));
  await card.locator(".metaline").click();
  await card.locator(".exsharebtn").click();
  return id;
}

// AC2a/2b: three email friends -> three invites rows (distinct tokens, each friend's own name and the
// film's tmdb_id) and three invite_emails rows carrying those same tokens. AC4e: Done replaces Cancel,
// and the confirmation's count matches the number selected.
test("CAS-930 AC2a/2b/4e: three email friends -> three invites + three invite_emails, Done not Cancel", async ({ page }) => {
  await signedInListing(page);
  const id = await openInviteSheet(page);

  await addAndSelectEmailFriend(page, "Sam", "sam@example.com");
  await addAndSelectEmailFriend(page, "Priya", "priya@example.com");
  await addAndSelectEmailFriend(page, "Mum", "mum@example.com");
  await expect(page.locator("#filmInviteSend")).toContainText("Invite 3 people");

  await page.locator("#filmInviteSend").click();
  await page.waitForFunction(() => window.__inviteInserts.length >= 3, null, { timeout: 5000 });

  const invites = await page.evaluate(() => window.__inviteInserts);
  expect(invites.length).toBe(3);
  expect(new Set(invites.map(r => r.token)).size).toBe(3);
  expect(invites.map(r => r.to_name).sort()).toEqual(["Mum", "Priya", "Sam"]);
  invites.forEach(r => expect(r.tmdb_id).toBe(id));

  await page.waitForFunction(() => window.__inviteEmailInserts.length >= 3, null, { timeout: 5000 });
  const emails = await page.evaluate(() => window.__inviteEmailInserts);
  expect(emails.length).toBe(3);
  const tokenByEmail = new Map(emails.map(e => [e.to_email, e.token]));
  expect(tokenByEmail.get("sam@example.com")).toBe(invites.find(r => r.to_name === "Sam").token);
  expect(tokenByEmail.get("priya@example.com")).toBe(invites.find(r => r.to_name === "Priya").token);
  expect(tokenByEmail.get("mum@example.com")).toBe(invites.find(r => r.to_name === "Mum").token);

  await expect(page.locator("#filmInviteClose")).toHaveText("Done");
  await expect(page.locator("#filmInviteBody")).toContainText("Invited 3 people");
});

// AC2c/2d: a WhatsApp recipient's invite row is still created, and the film-line-plus-invite-URL text
// is opened at a wa.me link whose number has been normalised from a local Australian mobile.
test("CAS-930 AC2c/2d: a WhatsApp recipient's mobile normalises and opens a wa.me link carrying the token", async ({ page }) => {
  await signedInListing(page);
  await openInviteSheet(page);

  await addAndSelectMobileFriend(page, "Jo", "0412 345 678");
  await expect(page.locator("#filmInviteSend")).toContainText("Invite Jo");

  await page.locator("#filmInviteSend").click();
  await page.waitForFunction(() => window.__inviteInserts.length > 0, null, { timeout: 5000 });
  const token = (await page.evaluate(() => window.__inviteInserts))[0].token;

  await page.waitForFunction(() => window.__opens.length > 0, null, { timeout: 5000 });
  const opens = await page.evaluate(() => window.__opens);
  expect(opens.length).toBe(1);
  expect(opens[0]).toContain("https://wa.me/61412345678?text=");
  expect(decodeURIComponent(opens[0])).toContain(token);

  expect(await page.evaluate(() => window.__inviteEmailInserts.length)).toBe(0);
});

// AC2d, isolated: 0412 345 678 normalises to 61412345678.
test("CAS-930 AC2d: normalizeAuMobile('0412 345 678') === '61412345678'", async ({ page }) => {
  await signedInListing(page);
  const digits = await page.evaluate(() => normalizeAuMobile("0412 345 678"));
  expect(digits).toBe("61412345678");
});

// AC2f: selecting a 21st recipient is refused, with a visible reason, and inserts nothing.
test("CAS-930 AC2f: selecting a 21st recipient is refused and inserts nothing", async ({ page }) => {
  await signedInListing(page);
  await openInviteSheet(page);

  await page.evaluate(() => {
    friends.length = 0;
    for(let i = 1; i <= 21; i++) friends.push({ id: i, name: `Friend${i}`, email: `f${i}@example.com` });
    inviteFriendSel = new Map();
    for(let i = 1; i <= 20; i++) inviteFriendSel.set(String(i), { channel: "email" });
    renderFilmInviteSheet(MOVIES.find(x => x.tmdb_id === filmInviteId));
  });
  await expect(page.locator("#filmInviteSend")).toContainText("Invite 20 people");

  await page.locator('.frow[data-fid="21"]').click();

  await expect(page.locator("#filmInviteErr")).toBeVisible();
  expect(await page.evaluate(() => inviteFriendSel.size)).toBe(20);
  expect(await page.evaluate(() => window.__inviteInserts.length)).toBe(0);
});

// CAS-1175 AC7: the Suggested date field is calendar-only — no date chosen shows "Pick a date"; setting
// the real underlying input's value and firing its input event shows "Mon 05 Oct", shows Clear, and
// passes the ISO value on; Clear resets it; keys typed while it's focused never change its value.
test("CAS-1175 AC7: the date field is pick-only (shows Pick a date / Mon 05 Oct / Clear, ignores typed keys)", async ({ page }) => {
  await signedInListing(page);
  await openInviteSheet(page);

  await expect(page.locator("#filmInviteDateLabel")).toHaveText("Pick a date");
  await expect(page.locator("#filmInviteDateClear")).toBeHidden();

  await page.evaluate(() => {
    const input = document.getElementById("filmInviteDate");
    input.value = "2026-10-05";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#filmInviteDateLabel")).toHaveText("Mon 05 Oct");
  await expect(page.locator("#filmInviteDateClear")).toBeVisible();
  expect(await page.evaluate(() => inviteDateVal)).toBe("2026-10-05");

  await page.locator("#filmInviteDate").focus();
  await page.keyboard.press("5");
  expect(await page.evaluate(() => document.getElementById("filmInviteDate").value)).toBe("2026-10-05");

  await page.locator("#filmInviteDateClear").click();
  await expect(page.locator("#filmInviteDateLabel")).toHaveText("Pick a date");
  await expect(page.locator("#filmInviteDateClear")).toBeHidden();
  expect(await page.evaluate(() => inviteDateVal)).toBe("");
});
