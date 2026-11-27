// CAS-1610: stars are account data (view.starred) and must not leak into the next account on the same device.
// Sign-out clears the in-memory set, and no device copy (localStorage cascade_starred) exists to bring them back.
import { test, expect } from "@playwright/test";

async function gotoReset(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?reset");
  await page.waitForFunction(() => typeof toggleStarred === "function" && Array.isArray(MOVIES));
}

async function signIn(page, userId){
  await page.evaluate(({ userId }) => {
    window.CascadeAuth.enabled = true;
    window.CascadeAuth.status = "signed-in";
    window.CascadeAuth.user = { id: userId };
    window.CascadeAuth.session = { user: { id: userId } };
    window.CascadeAuth.client = {
      from(){
        return {
          select(){ return { order(){ return { range(){ return Promise.resolve({ data: [], error: null }); } }; } }; },
          upsert(rows){ return { select(){ return Promise.resolve({ data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null }); } }; },
          delete(){ return { eq(){ return { in(){ return Promise.resolve({ data: null, error: null }); } }; } }; },
        };
      },
    };
  }, { userId });
}

test("CAS-1610: sign-out clears stars, nothing is kept on the device, and the next account starts empty", async ({ page }) => {
  await gotoReset(page);
  const [A, B] = await page.evaluate(() => MOVIES.slice(0, 2).map(m => m.tmdb_id));
  expect(A).toBeTruthy(); expect(B).toBeTruthy(); expect(A).not.toBe(B);

  // A legacy device copy from before this fix is dropped at boot.
  await page.evaluate(id => localStorage.setItem("cascade_starred", JSON.stringify([id])), A);
  await page.reload();
  await page.waitForFunction(() => typeof toggleStarred === "function" && Array.isArray(MOVIES));
  expect(await page.evaluate(() => localStorage.getItem("cascade_starred"))).toBeNull();
  expect(await page.evaluate(() => starredIds.size)).toBe(0);

  // Account 1: A already starred (as loaded from view.starred), the user stars B.
  await signIn(page, "cas1610-one");
  await page.evaluate(id => { starredIds.add(id); }, A);
  await page.evaluate(id => toggleStarred(id), B);
  expect(await page.evaluate(() => [...starredIds].sort())).toEqual([A, B].sort());
  expect(await page.evaluate(() => localStorage.getItem("cascade_starred"))).toBeNull();

  // Real sign-out path.
  await page.evaluate(() => {
    window.CascadeAuth.enabled = false; window.CascadeAuth.client = null; window.CascadeAuth.session = null;
    window.CascadePersistence.signOutReset();
  });
  expect(await page.evaluate(() => starredIds.size)).toBe(0);

  // Account 2 (no view.starred): record every view write from here on.
  await signIn(page, "cas1610-two");
  await page.evaluate(() => {
    window.__cas1610Writes = [];
    const orig = window.CascadePersistence.pushViewField;
    window.CascadePersistence.pushViewField = (k, v) => { window.__cas1610Writes.push([k, v]); return orig.call(window.CascadePersistence, k, v); };
  });
  await page.evaluate(() => window.CascadePersistence.loadAccount());
  expect(await page.evaluate(() => starredIds.size)).toBe(0);
  expect(await page.evaluate(() => MOVIES.some(m => isStarred(m.tmdb_id)))).toBe(false);

  // Any later starred write carries neither A nor B.
  await page.evaluate(() => saveStarred());
  const writes = await page.evaluate(() => window.__cas1610Writes.filter(w => w[0] === "starred").map(w => w[1]));
  for(const v of writes){ expect(v).not.toContain(A); expect(v).not.toContain(B); }
  expect(await page.evaluate(() => localStorage.getItem("cascade_starred"))).toBeNull();
});
