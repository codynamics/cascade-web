// CAS-1565: promo code CASCADEFRIENDS on the web sign-up screen replaces the approved list.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEngine } from "./engine.mjs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// A tiny id-addressed DOM: just enough for the membership screen's promo block.
function dom(E) {
  const els = {};
  const mk = () => ({
    value: "", innerHTML: "", hidden: false, textContent: "", style: {}, handlers: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(t, f) { this.handlers[t] = f; }, focus() {}, setAttribute() {}, removeAttribute() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
  });
  const body = mk(), promo = mk(), scr = mk(), offer = mk();
  E.window.document.getElementById = (id) => {
    if (id === "membBody") return body;
    if (id === "membScreen") return scr;
    if (id === "membOffer") return /id="membOffer"/.test(body.innerHTML) ? offer : null;
    if (id === "membPromo") {
      if (!/id="membPromo"/.test(body.innerHTML)) return null;
      if (!promo.innerHTML) promo.innerHTML = (/id="membPromo" class="membpromo">([\s\S]*?)<\/div>\s*(?:<div id="membCodeState"|<button class="membcta")/.exec(body.innerHTML) || [])[1] || "";
      return promo;
    }
    if (id.startsWith("membPromo")) {
      E.window.document.getElementById("membPromo");
      if (!promo.innerHTML.includes(`id="${id}"`)) return null;
      return (els[id + promo.innerHTML.length] ||= mk());
    }
    return mk();
  };
  return { body, promo, offer, get: (id) => E.window.document.getElementById(id) };
}
function setup({ native = false, rpc, signedIn = false, row = null } = {}) {
  const E = loadEngine({});
  const a = E.CascadeAuth;
  const calls = [];
  a.enabled = true; a.status = signedIn ? "signed-in" : "signed-out";
  a.user = signedIn ? { id: "11111111-1111-4111-8111-111111111111" } : null;
  a.client = {
    from() { return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }; },
    rpc: async (name, args) => { calls.push([name, args]); return rpc(name, args); },
  };
  if (native) E.window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  return { E, calls, d: dom(E) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("CAS-1565 AC2: web sign-up has #membPromoLink; native has no promo element", () => {
  const w = setup({ rpc: async () => ({ data: false }) });
  w.E.openOnbMembership();
  assert.match(w.d.body.innerHTML, /id="membPromoLink"/);
  assert.match(w.d.body.innerHTML, /Have a promo code\?/);
  const n = setup({ native: true, rpc: async () => ({ data: false }) });
  n.E.openOnbMembership();
  assert.doesNotMatch(n.d.body.innerHTML, /membPromo/);
});

test("CAS-1565 AC2: the invite-only screen has the promo link on web, with the new message", () => {
  const { E, d } = setup({ signedIn: true, rpc: async () => ({ data: null }) });
  E.membShowInviteOnly();
  assert.match(d.body.innerHTML, /id="membPromoLink"/);
  assert.match(d.body.innerHTML, /If a friend gave you a promo code, enter it below\. Otherwise membership starts in the Cascade iPhone app\./);
  assert.ok(d.body.innerHTML.indexOf("membPromoLink") < d.body.innerHTML.indexOf("membSignOutBtn"), "promo sits above Sign out");
});

test("CAS-1565 AC2: no is_web_access_approved call; source promo reads Complimentary membership until", async () => {
  const row = { status: "active", expires_at: "2027-11-25T00:00:00Z", is_trial: false, source: "promo" };
  const { E, calls } = setup({ signedIn: true, row, rpc: async () => ({ data: null }) });
  await E.membLoadEntitlement();
  assert.equal(calls.length, 0);
  assert.match(E.membAccountPlanText(), /^Complimentary membership until .*2027/);
  const src = read("../../app_template.html");
  assert.doesNotMatch(src, /is_web_access_approved/);
  assert.doesNotMatch(src, /Invited access/);
});

test("CAS-1565 AC3: a valid check shows the applied state and changes the price box", async () => {
  const { E, calls, d } = setup({ rpc: async () => ({ data: true, error: null }) });
  E.openOnbMembership();
  d.get("membPromoLink").handlers.click();
  assert.match(d.promo.innerHTML, /id="membPromoApply"/);
  d.get("membPromoCode").value = " cascadefriends ";
  await d.get("membPromoApply").handlers.click();
  await tick();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(["check_promo_code", { p_code: "cascadefriends" }]));
  assert.match(d.promo.innerHTML, /✓ Code applied: your first year is free\./);
  assert.equal(E.membPromoHeld, "CASCADEFRIENDS");
  assert.equal(d.offer.innerHTML, '<span class="moterms">Your first year is free with your code.</span>');
});

test("CAS-1565 AC3: an invalid check shows the error and holds nothing", async () => {
  const { E, d } = setup({ rpc: async () => ({ data: false, error: null }) });
  E.openOnbMembership();
  d.get("membPromoLink").handlers.click();
  d.get("membPromoCode").value = "nope";
  await d.get("membPromoApply").handlers.click();
  await tick();
  const err = d.get("membPromoErr");
  assert.equal(err.textContent, "That code isn't valid.");
  assert.equal(err.hidden, false);
  assert.equal(E.membPromoHeld, null);
});

async function applyThenSignIn(rpc) {
  const s = setup({ rpc: async (n, a) => (n === "check_promo_code" ? { data: true } : rpc(n, a)) });
  s.E.openOnbMembership();
  s.d.get("membPromoLink").handlers.click();
  s.d.get("membPromoCode").value = "CASCADEFRIENDS";
  await s.d.get("membPromoApply").handlers.click();
  await tick();
  s.E.CascadeAuth.status = "signed-in"; s.E.CascadeAuth.user = { id: "11111111-1111-4111-8111-111111111111" };
  return s;
}

test("CAS-1565 AC3: after sign-in redeem runs exactly once with the held code; on ok the gate opens", async () => {
  let member = false;
  const s = await applyThenSignIn(async (n) => { if (n === "redeem_promo_code") { member = true; return { data: { ok: true } }; } return { data: null }; });
  s.E.CascadeAuth.client.from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: member ? { status: "active", expires_at: "2099-01-01T00:00:00Z", source: "promo" } : null, error: null }) }) }) });
  let went = false;
  await s.E.membEnsureMember(async () => { went = true; });
  assert.equal(went, true);
  assert.equal(JSON.stringify(s.calls.filter(([n]) => n === "redeem_promo_code")), JSON.stringify([["redeem_promo_code", { p_code: "CASCADEFRIENDS" }]]));
  await s.E.membEnsureMember(async () => {});
  assert.equal(s.calls.filter(([n]) => n === "redeem_promo_code").length, 1, "never redeemed twice");
});

test("CAS-1565 AC3: used_up leaves the invite-only screen saying so", async () => {
  const s = await applyThenSignIn(async (n) => (n === "redeem_promo_code" ? { data: { ok: false, error: "used_up" } } : { data: null }));
  let went = false;
  await s.E.membEnsureMember(async () => { went = true; });
  assert.equal(went, false);
  assert.match(s.d.body.innerHTML, /That code has been used up\./);
  assert.match(s.d.body.innerHTML, /Cascade on the web is invite-only/);
});

test("CAS-1565: invite-only Apply redeems directly", async () => {
  const s = setup({ signedIn: true, rpc: async (n) => (n === "redeem_promo_code" ? { data: { ok: false, error: "already_used" } } : { data: null }) });
  s.E.membShowInviteOnly();
  s.d.get("membPromoLink").handlers.click();
  s.d.get("membPromoCode").value = "CASCADEFRIENDS";
  await s.d.get("membPromoApply").handlers.click();
  await tick();
  assert.equal(JSON.stringify(s.calls[0]), JSON.stringify(["redeem_promo_code", { p_code: "CASCADEFRIENDS" }]));
  assert.equal(s.d.get("membPromoErr").textContent, "That code has already been used on this account.");
});

test("CAS-1565: the code is never logged; the code step hides the promo block", () => {
  const src = read("../../app_template.html");
  assert.match(src, /logEvent\("promo_check",\{valid:out==="valid"\}\)/);
  assert.match(src, /logEvent\("promo_redeem",\{ok:out\.ok, error:out\.error\|\|null\}\)/);
  assert.match(src, /\$\("membEmailField"\), \$\("membPromo"\)/);
});

test("CAS-1565 AC1: migration + schema.sql define tables, functions, grants; backfill only in the migration", () => {
  const mig = read("../../supabase/migrations/0016_promo_codes.sql");
  const sch = read("../../supabase/schema.sql");
  for (const sql of [mig, sch]) {
    assert.match(sql, /create table if not exists public\.promo_codes/);
    assert.match(sql, /create table if not exists public\.promo_redemptions/);
    assert.match(sql, /create or replace function public\.check_promo_code/);
    assert.match(sql, /create or replace function public\.redeem_promo_code/);
    assert.match(sql, /grant execute on function public\.check_promo_code\(text\) to anon, authenticated/);
    assert.match(sql, /grant execute on function public\.redeem_promo_code\(text\) to authenticated/);
  }
  assert.match(mig, /to_regclass\('public\.web_access'\)/);
  assert.doesNotMatch(sch, /to_regclass\('public\.web_access'\)/);
  assert.doesNotMatch(sch, /counts\) *\n? *select r\.user_id/);
});
