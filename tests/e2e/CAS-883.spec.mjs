// CAS-883: Invite replaces Share — an invite is now a real record (public.invites) with a per-send token,
// a named recipient and a reply, not the CAS-837 stateless ref-code link. Captures the invites insert and
// the navigator.share call the same way CAS-838's spec captures contact_messages.
//
// Unlike CAS-740/CAS-835/CAS-837/CAS-838's fake-config/fake-supabase-js network-route technique, this spec
// sets window.CascadeAuth directly: toggleExpand only flips a CSS class and never re-runs cardHTML (see
// CAS-831's comment in smoke.spec.mjs), so a card's Invite control is baked into its markup at CARD-CREATE
// time — it has to be signed in before the roster first renders, which a config.js/supabase-js network
// race can't guarantee deterministically the way the other specs' post-hoc "wait for signed-in" checks do.
// window.CascadeAuth is a plain object the app never reassigns once boot decides guest vs configured (see
// app_template.html's auth module — the `if(!configured){ ...; return; }` guard), so mutating it directly
// after freshApp() and before the roster is built is safe and exercises the exact same code paths
// (inviteFilmHTML reads window.CascadeAuth; sendFilmInvite calls window.CascadeAuth.client.from(...)).
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, finishFlow, toListing } from "./helpers.mjs";

async function primeFakeAccount(page){
  await page.evaluate(() => {
    window.__inviteInserts = [];
    window.__inviteShouldFail = false;
    window.__friendInserts = [];
    window.__inviteEmailInserts = [];
    window.__shareCalls = [];
    window.__shareShouldAbort = false;
    window.__opens = [];
    window.open = (url) => { window.__opens.push(url); return { closed: false }; };
    navigator.share = (opts) => {
      window.__shareCalls.push(opts);
      if(window.__shareShouldAbort){ const e = new Error("cancelled"); e.name = "AbortError"; return Promise.reject(e); }
      return Promise.resolve();
    };
    window.CascadeAuth.enabled = true;
    window.CascadeAuth.status = "signed-in";
    window.CascadeAuth.user = { id: "cas883-user", email: "cas883@example.com" };
    window.CascadeAuth.session = { user: { id: "cas883-user" } };
    window.CascadeAuth.client = { from: (table) => {
      // CAS-928: the Invite sheet's recipient field is now the shared friend picker — sending "with a
      // name" means adding+selecting a friend first, which round-trips through friends.insert().select().
      if(table === "friends") return {
        insert: (rows) => ({ select: () => ({ single: () => {
          const row = { id: 900 + window.__friendInserts.length + 1, ...rows[0] };
          window.__friendInserts.push(row);
          return Promise.resolve({ data: row, error: null });
        } }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
      // CAS-930: an email recipient's invite is queued into invite_emails rather than shared.
      if(table === "invite_emails") return {
        insert: (rows) => { window.__inviteEmailInserts.push(...rows); return Promise.resolve({ data: rows, error: null }); },
      };
      return {
        insert: (rows) => {
          if(table !== "invites") return Promise.resolve({ data: [], error: null });
          if(window.__inviteShouldFail) return Promise.resolve({ data: null, error: { message: "insert failed" } });
          window.__inviteInserts.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        },
      };
    } };
  });
}

/** Opens the Invite sheet's "+ Add someone new" form, adds a friend, and returns to the picker with
 * them selected — CAS-928's replacement for typing a name into the old free-text field. */
async function addAndSelectFriend(page, name, email){
  await page.locator('#filmInviteBody button:has-text("Add someone new")').click();
  await page.locator("#ffName").fill(name);
  await page.locator("#ffEmail").fill(email);
  await page.locator('#filmInviteBody button:has-text("Add and select")').click();
  await page.waitForFunction(() => window.__friendInserts.length > 0, null, { timeout: 5000 });
}

/** Signed in (faked, see primeFakeAccount), landed on the listing with at least one visible card. */
async function signedInListing(page){
  await toShortlist(page, "cinema");
  await primeFakeAccount(page);
  await finishFlow(page);
  await toListing(page);
}

async function expandFirstCard(page){
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));
  await card.locator(".metaline").click();
  await expect(page.locator(`#card-${id}`)).toHaveClass(/expanded/);
  return id;
}

// AC4a, superseded by CAS-1119: the film page (filmPageHTML) dropped every account-gated control,
// including Invite — it's the account-agnostic "door" a share link opens for a visitor who may not have
// one yet (see filmPageHTML's own comment), so it never carries Invite now regardless of sign-in state.
// The card keeps its own Invite control; neither surface ever says Share.
test("CAS-883 AC4a: the expanded card shows Invite, never Share; the film page (CAS-1119) shows neither", async ({ page }) => {
  await signedInListing(page);
  const id = await expandFirstCard(page);

  const cardBtn = page.locator(`#card-${id} .exsharebtn`);
  await expect(cardBtn).toBeVisible();
  await expect(cardBtn).toContainText("Invite");
  await expect(cardBtn).not.toContainText("Share");

  await page.evaluate(fid => openFilmPage(fid), id);
  await expect(page.locator("#filmPage .filminvcta")).toHaveCount(0);
  expect(await page.locator("#filmPage").innerText()).not.toContain("Share");
});

// AC4b: activating Invite opens the #filmInvite sheet showing the film's title.
test("CAS-883 AC4b: activating Invite opens the sheet showing the film's title", async ({ page }) => {
  await signedInListing(page);
  const id = await expandFirstCard(page);
  const title = await page.evaluate(fid => MOVIES.find(m => m.tmdb_id === fid).title, id);

  await page.locator(`#card-${id} .exsharebtn`).click();
  await expect(page.locator("#filmInvite")).toHaveClass(/open/);
  await expect(page.locator("#filmInviteBody .filminvtitle")).toHaveText(title);
});

// AC4c/AC4d, superseded by CAS-930: sending to one selected (email) friend inserts one invites row
// with that name, the right tmdb_id and a 10-char [a-z0-9] token, and queues one invite_emails row
// carrying that same token — Cascade sends the email itself now, so navigator.share is never called
// for an email recipient (CAS-930's own "the share-sheet hand-off survives only as a fallback").
test("CAS-883 AC4c/4d: sending to one email friend inserts once and queues one invite_emails row", async ({ page }) => {
  await signedInListing(page);
  const id = await expandFirstCard(page);
  await page.locator(`#card-${id} .exsharebtn`).click();
  await addAndSelectFriend(page, "Sam", "sam@example.com");
  await page.locator("#filmInviteSend").click();
  await page.waitForFunction(() => window.__inviteInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__inviteInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].to_name).toBe("Sam");
  expect(rows[0].tmdb_id).toBe(id);
  expect(rows[0].token).toMatch(/^[a-z0-9]{10}$/);

  await page.waitForFunction(() => window.__inviteEmailInserts.length > 0, null, { timeout: 5000 });
  const emails = await page.evaluate(() => window.__inviteEmailInserts);
  expect(emails.length).toBe(1);
  expect(emails[0].to_email).toBe("sam@example.com");
  expect(emails[0].token).toBe(rows[0].token);

  expect(await page.evaluate(() => window.__shareCalls.length)).toBe(0);
});

// AC4e, superseded by CAS-930: with nobody selected, Send is disabled and nothing is inserted — an
// unnamed invite no longer exists (CAS-930 change 1: "disabled with nothing selected").
test("CAS-883 AC4e: with nobody selected, Send is disabled and inserts nothing", async ({ page }) => {
  await signedInListing(page);
  const id = await expandFirstCard(page);
  await page.locator(`#card-${id} .exsharebtn`).click();

  await expect(page.locator("#filmInviteSend")).toBeDisabled();
  expect(await page.evaluate(() => window.__inviteInserts.length)).toBe(0);
});

// AC4f: when the insert rejects, navigator.share is never called and an error is visible.
test("CAS-883 AC4f: a rejected insert never calls navigator.share and shows an error", async ({ page }) => {
  await signedInListing(page);
  await page.evaluate(() => { window.__inviteShouldFail = true; });
  const id = await expandFirstCard(page);
  await page.locator(`#card-${id} .exsharebtn`).click();
  await addAndSelectFriend(page, "Sam", "sam@example.com");
  await page.locator("#filmInviteSend").click();

  await expect(page.locator("#filmInviteErr")).toBeVisible();
  await page.waitForTimeout(300);
  const rows = await page.evaluate(() => window.__inviteInserts);
  const calls = await page.evaluate(() => window.__shareCalls);
  expect(rows.length).toBe(0);
  expect(calls.length).toBe(0);
});

// AC4g: signed out, no Invite control is rendered on the film page.
test("CAS-883 AC4g: signed out, the film page renders no Invite control", async ({ page }) => {
  await freshApp(page);
  const id = await page.evaluate(() => MOVIES[0].tmdb_id);
  await page.evaluate(fid => openFilmPage(fid), id);

  await expect(page.locator("#filmPage .filminvcta")).toHaveCount(0);
  await expect(page.locator("#filmPage .exsharebtn")).toHaveCount(0);
});
