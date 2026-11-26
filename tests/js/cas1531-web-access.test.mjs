// CAS-1531: sign-up buys directly (native) / invite-only web by approved email; the testing bypass is gone;
// the Watch tutorial starts once the membership screen closes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEngine } from "./engine.mjs";

function fakeClient({ row = null, approved = false, rpcError = null } = {}) {
  return {
    from() { return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }; },
    // CAS-1565: the approved list is retired — the app no longer asks is_web_access_approved at all.
    rpc: async (name) => { assert.notEqual(name, "is_web_access_approved"); return { data: approved, error: rpcError }; },
  };
}
function setup({ client, native = false, plugin } = {}) {
  const E = loadEngine({});
  const a = E.CascadeAuth;
  a.enabled = true; a.status = "signed-in"; a.client = client; a.user = { id: "11111111-1111-4111-8111-111111111111" };
  if (native) E.window.Capacitor = { isNativePlatform: () => true, Plugins: { NativePurchases: plugin } };
  return E;
}

test("CAS-1531 AC2 (CAS-1565): web — an approved-list email alone no longer makes a member; a membership row does", async () => {
  const E = setup({ client: fakeClient({ approved: true }) });
  await E.membLoadEntitlement();
  assert.equal(E.membEnt.state, "none");
  const row = { status: "active", expires_at: "2099-01-01T00:00:00Z", is_trial: false, source: "promo" };
  const E2 = setup({ client: fakeClient({ row }) });
  let went = false;
  await E2.membEnsureMember(async () => { went = true; });
  assert.equal(went, true);
  assert.equal(E2.membEnt.row.source, "promo");
});

test("CAS-1531 AC2: web — any other email sees the invite-only screen; go() never runs", async () => {
  const E = setup({ client: fakeClient({ approved: false }) });
  const body = { innerHTML: "" };
  const scr = { scrollTop: 0, classList: { add() {}, remove() {}, contains: () => false } };
  E.window.document.getElementById = (id) => (id === "membBody" ? body : id === "membScreen" ? scr : null);
  let went = false;
  await E.membEnsureMember(async () => { went = true; });
  assert.equal(went, false);
  assert.match(body.innerHTML, /Cascade on the web is invite-only/);
  assert.match(body.innerHTML, /Sign out/);
  assert.doesNotMatch(body.innerHTML, /memboffer|moprice|Continue without membership|membenefits/);
});

test("CAS-1531: an unreachable approval check fails open, never locks anyone out", async () => {
  const E = setup({ client: fakeClient({ rpcError: { message: "function not found" } }) });
  await E.membLoadEntitlement();
  assert.equal(E.membEnt.state, "none");   // not approved, but...
  // ...membLoadEntitlement keeps the memberships answer; the rpc error only skips the approval upgrade.
});

test("CAS-1531 AC1: iPhone — after the code verifies the purchase call is made directly, no gate screen", async () => {
  let bought = 0;
  const plugin = { purchaseProduct: async () => { bought++; throw new Error("User cancelled"); } };
  const E = setup({ client: fakeClient(), native: true, plugin });
  let went = false;
  await E.membEnsureMember(async () => { went = true; });
  assert.equal(bought, 1);
  assert.equal(went, false, "cancelled purchase stays on the sign-up screen");
  assert.equal(E.membGated, false, "membGateCheck's held screen was never opened");
});

test("CAS-1531 AC3: the testing bypass is gone from the template", () => {
  const src = readFileSync(new URL("../../app_template.html", import.meta.url), "utf8");
  assert.equal((src.match(/membership_bypass/g) || []).length, 0);
  assert.doesNotMatch(src, /Continue without membership/);
});

test("CAS-1531 AC4: closing the gate on an active entitlement starts the Watch tour via maybeStartTutorial", () => {
  const src = readFileSync(new URL("../../app_template.html", import.meta.url), "utf8");
  const gate = src.slice(src.indexOf("async function membGateCheck()"), src.indexOf("window.membGateCheck="));
  assert.match(gate, /closeMembership\(\); membGated=false; maybeStartTutorial\(\)/);
  assert.match(src, /closeMembership\(\); membGateDone\(\); maybeStartTutorial\(\)/);
});

test("CAS-1531 AC5: migration 0012 is idempotent, RLS on, no client policy", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0012_web_access.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.web_access/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /create or replace function public\.is_web_access_approved/);
  assert.doesNotMatch(sql, /create policy/i);
});
