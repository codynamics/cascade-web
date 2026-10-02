// CAS-959: onboarding must be idempotent against the ACCOUNT, not the device. Two shapes of the same
// defect: (1) a device walks the v2 wizard, commits a fresh roster locally, then the membership step's
// own email gate (CAS-387) signs into an account that already had its own agents — the draft used to be
// folded straight into the account, duplicating the roster; (2) a device signs out and back in on the
// SAME account — the agent count and ids must not move. Same direct-CascadeAuth-mutation technique as
// CAS-884/CAS-930 (a card-create-time or membership-time fake client, no config.js/supabase-js network
// route), extended here to drive window.CascadePersistence.loadAccount()/signOutReset() directly, the way
// the real sign-in/sign-out chokepoints do.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow } from "./helpers.mjs";

async function gotoReset(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?reset");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
}

/** Signs the page in with a fake Supabase-shaped client serving exactly `existingRows` from the
 * cascades table, recording every upsert TO THE cascades TABLE into window.__cas959Upserts (reset each
 * call) — CAS-1097 widened acctOp/acctLoad sync to every account table (agent_films, user_films, ...), so
 * an ordinary signed-in session now legitimately upserts far more than cascades; only a re-upserted
 * cascade row is this ticket's own concern. */
async function signInWithRows(page, userId, existingRows){
  await page.evaluate(({ userId, existingRows }) => {
    window.__cas959Upserts = [];
    window.CascadeAuth.enabled = true;
    window.CascadeAuth.status = "signed-in";
    window.CascadeAuth.user = { id: userId };
    window.CascadeAuth.session = { user: { id: userId } };
    window.CascadeAuth.client = {
      from(table){
        return {
          // CAS-1109/CAS-1142: acctLoad() pages with .select().order().range(), not .select().order() alone
          // — see CAS740_FAKE_SUPABASE_GLOBAL in smoke.spec.mjs for the same fix on the same bug class.
          select(){ return { order(){ return { range(){ return Promise.resolve({ data: table === "cascades" ? existingRows : [], error: null }); } }; } }; },
          upsert(rows){
            if(table === "cascades") window.__cas959Upserts.push(...rows);
            return { select(){ return Promise.resolve({ data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null }); } };
          },
          delete(){ return { eq(){ return { in(){ return Promise.resolve({ data: null, error: null }); } }; } }; },
        };
      },
    };
  }, { userId, existingRows });
}

test("CAS-959 observation: a committed onboarding draft is dropped, not duplicated, once the account it signs into already has its own agents", async ({ page }) => {
  await gotoReset(page);
  await toShortlist(page, "cinema");
  await finishFlow(page);   // walks through v2_done — the roster commits, still guest at this point
  const draftIds = await page.evaluate(() => cascades.map(c => c.id));
  expect(draftIds.length).toBeGreaterThan(0);

  // The membership email gate now resolves — to an account that already has two agents of its own
  // (a second device's earlier onboarding run, per the ticket's own observed shape).
  await signInWithRows(page, "cas959-obs", [
    { id: "a0000000-0000-4000-8000-000000000959", user_id: "cas959-obs", name: "Massive Movies", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "b0000000-0000-4000-8000-000000000959", user_id: "cas959-obs", name: "Personal Favs", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:01.000Z" },
  ]);
  await page.evaluate(() => window.CascadePersistence.loadAccount());

  const finalIds = await page.evaluate(() => cascades.map(c => c.id).sort());
  expect(finalIds).toEqual(["a0000000-0000-4000-8000-000000000959", "b0000000-0000-4000-8000-000000000959"]);
  await page.evaluate(() => window.CascadePersistence.syncNow());
  expect(await page.evaluate(() => window.__cas959Upserts.length)).toBe(0);
});

test("CAS-959 AC4: sign in, sign out, sign back in on the same device — the agent count is unchanged and no new agent ids appear", async ({ page }) => {
  await gotoReset(page);
  const oneRow = [{ id: "c0000000-0000-4000-8000-000000000959", user_id: "cas959-ac4", name: "Massive Movies", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" }];

  await signInWithRows(page, "cas959-ac4", oneRow);
  await page.evaluate(() => window.CascadePersistence.loadAccount());
  expect(await page.evaluate(() => cascades.map(c => c.id))).toEqual(["c0000000-0000-4000-8000-000000000959"]);

  // Sign out — the real chokepoint, per CAS-957's own test convention.
  await page.evaluate(() => {
    window.CascadeAuth.enabled = false; window.CascadeAuth.client = null; window.CascadeAuth.session = null;
    window.CascadePersistence.signOutReset();
  });
  expect(await page.evaluate(() => cascades.length)).toBe(0);

  // Sign back in as the SAME account, which still has exactly that one agent.
  await signInWithRows(page, "cas959-ac4", oneRow);
  await page.evaluate(() => window.CascadePersistence.loadAccount());

  expect(await page.evaluate(() => cascades.map(c => c.id))).toEqual(["c0000000-0000-4000-8000-000000000959"]);
  await page.evaluate(() => window.CascadePersistence.syncNow());
  expect(await page.evaluate(() => window.__cas959Upserts.length)).toBe(0);
});

// AC3 (regression guard): the signed-out first run must still reach the generator and commit its own
// roster — CAS-911's own specs already cover this walk in full; this just pins it under CAS-959 too,
// since this ticket touches the exact fold-in code the commit's later sync depends on.
test("CAS-959 AC3: the signed-out first run still reaches the generator and commits its roster", async ({ page }) => {
  await gotoReset(page);
  await toShortlist(page, "cinema");
  expect(await page.evaluate(() => cascades.length)).toBe(0);
  await finishFlow(page);
  expect(await page.evaluate(() => cascades.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem("cascade_onboarded"))).toBe("1");
});
