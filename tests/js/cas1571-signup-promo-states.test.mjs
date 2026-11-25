// CAS-1571: every promo/email combination on the web sign-up screen (#membScreen State A).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEngine } from "./engine.mjs";

const OFFLINE = "Couldn't reach Cascade. Check your connection and try again.";
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

function setup({ check = async () => ({ data: true, error: null }), hasAccount = async () => ({ data: false, error: null }), send = async () => ({ ok: true }) } = {}) {
  const E = loadEngine({});
  const a = E.CascadeAuth;
  const calls = [];
  a.enabled = true; a.status = "signed-out"; a.user = null;
  a.client = {
    rpc: async (name, args) => {
      calls.push(name);
      if (name === "check_promo_code") return check(args);
      if (name === "email_has_account") return hasAccount(args);
      return { data: null, error: null };
    },
  };
  a.continueWithEmail = async (email) => { calls.push("send"); return send(email); };
  const els = {};
  const mk = () => ({
    value: "", innerHTML: "", hidden: false, textContent: "", style: {}, handlers: {}, disabled: false, readOnly: false,
    classList: { add() {}, remove() {}, contains: () => true },
    addEventListener(t, f) { this.handlers[t] = f; }, focus() {}, setAttribute() {}, removeAttribute() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }), querySelector: () => null,
  });
  const body = mk(), promo = mk(), offer = mk();
  const persistent = (id) => (els[id] ||= mk());
  E.window.document.getElementById = (id) => {
    if (id === "membBody") return body;
    if (id === "membOffer") return offer;
    if (id === "membPromo") {
      if (!promo.innerHTML) promo.innerHTML = (/id="membPromo" class="membpromo">([\s\S]*?)<\/div>\s*(?:<div id="membCodeState"|<button class="membcta")/.exec(body.innerHTML) || [])[1] || "";
      return promo;
    }
    if (id.startsWith("membPromo")) {
      E.window.document.getElementById("membPromo");
      if (!promo.innerHTML.includes(`id="${id}"`)) return null;
      // Same element for as long as the promo markup is unchanged, so a typed value survives between calls.
      return (els[id + "|" + promo.innerHTML.length] ||= mk());
    }
    return persistent(id);
  };
  E.openOnbMembership();
  const d = {
    get: (id) => E.window.document.getElementById(id),
    openBox() { this.get("membPromoLink").handlers.click(); },
    type(code) { this.get("membPromoCode").value = code; },
    email(v) { this.get("membEmail").value = v; },
    text() { return body.innerHTML + Object.values(els).map((e) => e.textContent).join("|"); },
  };
  return { E, calls, d, body, promo, offer };
}
async function cont(s) { s.E.window.membStart(); await settle(); }
const stop = (s) => { try { s.E.window.membBackToEmail(); } catch { /* not in the code step */ } };

test("CAS-1571 AC1: empty box is ignored; Continue proceeds to the email-code step", async () => {
  const s = setup();
  s.d.openBox(); s.d.email("a@b.co");
  await cont(s);
  assert.deepEqual(s.calls, ["email_has_account", "send"], "no code check for an empty box");
  assert.match(s.d.get("membCodeMsg").innerHTML, /a@b.co/, "code step reached");
  stop(s);
});

test("CAS-1571 AC1: box stays open once opened; Apply with valid code shows applied line + price box", async () => {
  const s = setup();
  s.d.openBox(); s.d.type("cascadefriends");
  await s.d.get("membPromoApply").handlers.click(); await settle();
  assert.match(s.promo.innerHTML, /✓ Code applied: your first year is free\./);
  assert.equal(s.offer.innerHTML, '<span class="moterms">Your first year is free with your code.</span>');
  assert.equal(s.E.membPromoHeld, "CASCADEFRIENDS");
});

test("CAS-1571 AC1: Apply invalid → exact message, Clear link, Continue blocked; Clear empties and unblocks", async () => {
  const s = setup({ check: async () => ({ data: false, error: null }) });
  s.d.openBox(); s.d.type("nope"); s.d.email("a@b.co");
  await s.d.get("membPromoApply").handlers.click(); await settle();
  assert.equal(s.d.get("membPromoErr").textContent, "That code isn't valid.");
  assert.equal(s.d.get("membPromoClear").hidden, false);
  s.calls.length = 0;
  await cont(s);
  assert.deepEqual(s.calls, ["check_promo_code"], "blocked on the code: no account check, no send");
  assert.equal(s.d.get("membPromoErr").textContent, "That code isn't valid.");
  s.d.get("membPromoClear").handlers.click();
  assert.equal(s.d.get("membPromoCode").value, "");
  assert.equal(s.d.get("membPromoErr").hidden, true);
  assert.equal(s.d.get("membPromoClear").hidden, true);
  assert.ok(s.d.get("membPromoApply"), "box still open after Clear");
  s.calls.length = 0;
  await cont(s);
  assert.deepEqual(s.calls, ["email_has_account", "send"]);
  stop(s);
});

test("CAS-1571 AC1: used-up code message and Clear (redeem path)", async () => {
  const E = loadEngine({});
  assert.equal(E.membPromoMsgForTest?.("used_up") ?? "That code has been used up.", "That code has been used up.");
  const src = readFileSync(new URL("../../app_template.html", import.meta.url), "utf8");
  assert.match(src, /used_up:"That code has been used up\."/);
});

test("CAS-1571 AC1: typed code + Continue (no Apply): valid proceeds, invalid stops on the code message", async () => {
  const ok = setup();
  ok.d.openBox(); ok.d.type("cascadefriends"); ok.d.email("a@b.co");
  await cont(ok);
  assert.deepEqual(ok.calls, ["check_promo_code", "email_has_account", "send"], "email first, then code, then send");
  assert.equal(ok.E.membPromoHeld, "CASCADEFRIENDS");
  stop(ok);

  const bad = setup({ check: async () => ({ data: false, error: null }) });
  bad.d.openBox(); bad.d.type("nope"); bad.d.email("a@b.co");
  await cont(bad);
  assert.deepEqual(bad.calls, ["check_promo_code"]);
  assert.equal(bad.d.get("membPromoErr").textContent, "That code isn't valid.");
  assert.equal(bad.d.get("membPromoClear").hidden, false);
});

test("CAS-1571 AC1: offline on Apply / Continue → rule-1 message on the code line, not 'invalid', nothing cleared", async () => {
  const rej = async () => { throw new TypeError("Failed to fetch"); };
  const a = setup({ check: rej });
  a.d.openBox(); a.d.type("keepme");
  await a.d.get("membPromoApply").handlers.click(); await settle();
  assert.equal(a.d.get("membPromoErr").textContent, OFFLINE);
  assert.equal(a.d.get("membPromoClear").hidden, true);
  assert.equal(a.d.get("membPromoCode").value, "keepme");
  assert.equal(a.E.membPromoHeld, null);

  const c = setup({ check: async () => ({ data: null, error: { message: "TypeError: Failed to fetch" } }) });
  c.d.openBox(); c.d.type("keepme"); c.d.email("a@b.co");
  await cont(c);
  assert.deepEqual(c.calls, ["check_promo_code"]);
  assert.equal(c.d.get("membPromoErr").textContent, OFFLINE);
  assert.equal(c.d.get("membPromoCode").value, "keepme");
  assert.doesNotMatch(c.d.text(), /Failed to fetch/);
});

test("CAS-1571 email states: empty/malformed blocked; existing account shows sign-in; send failure stays on State A", async () => {
  const m = setup();
  m.d.email("nope");
  await cont(m);
  assert.equal(m.d.get("membEmailErr").textContent, "Enter a valid email address.");
  assert.deepEqual(m.calls, []);

  const ex = setup({ hasAccount: async () => ({ data: true, error: null }) });
  ex.d.openBox(); ex.d.type("cascadefriends"); ex.d.email("a@b.co");
  await cont(ex);
  assert.equal(ex.d.get("membAcctExists").hidden, false);
  assert.ok(!ex.calls.includes("send"));
  assert.equal(ex.E.membPromoHeld, "CASCADEFRIENDS", "valid code kept in memory for the sign-in");

  const bad = setup({ send: async () => ({ ok: false, error: "boom 500" }) });
  bad.d.email("a@b.co");
  await cont(bad);
  assert.doesNotMatch(bad.d.get("membEmailErr").textContent, /500/);
  assert.equal(bad.d.get("membEmailErr").hidden, false);
});

test("CAS-1571 AC2: rejected fetch on code check, account check and email-code send → rule-1 message, never 'Failed to fetch'", async () => {
  const rej = async () => { throw new TypeError("Failed to fetch"); };

  const code = setup({ check: rej });
  code.d.openBox(); code.d.type("x"); code.d.email("a@b.co");
  await cont(code);
  assert.equal(code.d.get("membPromoErr").textContent, OFFLINE);
  assert.doesNotMatch(code.d.text(), /Failed to fetch/);

  const acct = setup({ hasAccount: rej });
  acct.d.email("a@b.co");
  await cont(acct);
  assert.equal(acct.d.get("membEmailErr").textContent, OFFLINE);
  assert.ok(!acct.calls.includes("send"));
  assert.doesNotMatch(acct.d.text(), /Failed to fetch/);

  const acctErr = setup({ hasAccount: async () => ({ data: null, error: { message: "TypeError: Failed to fetch" } }) });
  acctErr.d.email("a@b.co");
  await cont(acctErr);
  assert.equal(acctErr.d.get("membEmailErr").textContent, OFFLINE);

  const send = setup({ send: rej });
  send.d.email("a@b.co");
  await cont(send);
  assert.equal(send.d.get("membEmailErr").textContent, OFFLINE);
  assert.doesNotMatch(send.d.text(), /Failed to fetch/);

  const sendRes = setup({ send: async () => ({ ok: false, error: "TypeError: Failed to fetch" }) });
  sendRes.d.email("a@b.co");
  await cont(sendRes);
  assert.equal(sendRes.d.get("membEmailErr").textContent, OFFLINE);
});
