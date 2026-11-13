// CAS-971: the membership purchase flow (four distinct outcomes), the restore path, and the rule that the
// entitlement is a SERVER fact — clearing localStorage never changes it. Runs the built index.html's own
// engine against a mocked purchase plugin and a fake Supabase client.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const PRODUCT = "au.com.codynamics.cascade.membership.monthly";

function fakeClient({ row = null, readError = null, verifyError = null } = {}) {
  const verifyCalls = [];
  return {
    verifyCalls,
    from(table) {
      assert.equal(table, "memberships");
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: readError }) }) }) };
    },
    functions: { invoke: async (name, opts) => { verifyCalls.push({ name, opts }); return { data: null, error: verifyError }; } },
  };
}
function setup({ client, plugin, native = true, store } = {}) {
  const E = loadEngine({ localStorageStore: store });
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.status = "signed-in"; auth.client = client; auth.user = { id: "11111111-1111-4111-8111-111111111111" };
  if (native) E.window.Capacitor = { isNativePlatform: () => true, Plugins: { NativePurchases: plugin } };
  return E;
}
const future = () => new Date(Date.now() + 864e5 * 20).toISOString();

test("CAS-971 AC2: success — verified server-side, then the entitlement is re-read", async () => {
  const row = { status: "active", expires_at: future(), is_trial: true, source: "apple" };
  const client = fakeClient({ row });
  const plugin = { purchaseProduct: async (o) => { assert.equal(o.productIdentifier, PRODUCT); return { jwsRepresentation: "a.b.c" }; } };
  const E = setup({ client, plugin });
  const r = await E.membBuy();
  assert.equal(r.outcome, "success");
  assert.equal(client.verifyCalls[0].name, "membership-verify");
  assert.equal(client.verifyCalls[0].opts.body.signedTransaction, "a.b.c");
  assert.equal(E.membEnt.state, "active");
  assert.equal(E.membLastMessage, "");
});

test("CAS-971 AC2: user cancel — outcome 'cancelled' and NO error shown", async () => {
  const plugin = { purchaseProduct: async () => { throw new Error("User cancelled"); } };
  const E = setup({ client: fakeClient(), plugin });
  const r = await E.membBuy();
  assert.equal(r.outcome, "cancelled");
  assert.equal(E.membLastMessage, "");
});

test("CAS-971 AC2: failure — outcome 'failed' and an error is shown", async () => {
  const plugin = { purchaseProduct: async () => { throw new Error("Network down"); } };
  const E = setup({ client: fakeClient(), plugin });
  const r = await E.membBuy();
  assert.equal(r.outcome, "failed");
  assert.match(E.membLastMessage, /didn't go through/);
});

test("CAS-971 AC2: pending — outcome 'pending' and the pending state is shown (not an error)", async () => {
  const plugin = { purchaseProduct: async () => { throw new Error("Transaction pending"); } };
  const E = setup({ client: fakeClient(), plugin });
  const r = await E.membBuy();
  assert.equal(r.outcome, "pending");
  assert.match(E.membLastMessage, /waiting for approval/);
});

test("CAS-971: a purchase whose server verification fails is reported as failed, not success", async () => {
  const plugin = { purchaseProduct: async () => ({ jwsRepresentation: "a.b.c" }) };
  const E = setup({ client: fakeClient({ verifyError: new Error("500") }), plugin });
  const r = await E.membBuy();
  assert.equal(r.outcome, "failed");
  assert.match(E.membLastMessage, /Restore Purchases/);
});

test("CAS-971: restore re-verifies the newest membership transaction", async () => {
  const client = fakeClient({ row: { status: "active", expires_at: future(), is_trial: false, source: "apple" } });
  const plugin = {
    restorePurchases: async () => {},
    getPurchases: async () => ({ purchases: [{ productIdentifier: PRODUCT, jwsRepresentation: "x.y.z" }] }),
  };
  const E = setup({ client, plugin });
  assert.equal((await E.membRestore()).outcome, "success");
  assert.equal(client.verifyCalls.length, 1);
});

test("CAS-971 AC4: clearing localStorage does not change the membership state", async () => {
  const store = new Map();
  const row = { status: "active", expires_at: future(), is_trial: false, source: "apple" };
  const E = setup({ client: fakeClient({ row }), plugin: {}, store });
  await E.membLoadEntitlement();
  assert.equal(E.membEnt.state, "active");
  store.clear();
  assert.equal(E.membEnt.state, "active", "state is held in memory from the server read, never in localStorage");
  // and a fresh page load with an empty localStorage reads the same answer from the server
  const E2 = setup({ client: fakeClient({ row }), plugin: {}, store: new Map() });
  await E2.membLoadEntitlement();
  assert.equal(E2.membEnt.state, "active");
});

test("CAS-971: no row means 'none'; a read error fails OPEN ('unknown')", async () => {
  const E = setup({ client: fakeClient({ row: null }), plugin: {} });
  await E.membLoadEntitlement();
  assert.equal(E.membEnt.state, "none");
  const E2 = setup({ client: fakeClient({ readError: { message: "relation does not exist" } }), plugin: {} });
  await E2.membLoadEntitlement();
  assert.equal(E2.membEnt.state, "unknown");
});

test("CAS-971: expired / revoked rows are not active; grace and billing_retry are", () => {
  const E = loadEngine();
  const t = Date.now();
  assert.equal(E.membRowActive({ status: "active", expires_at: new Date(t + 1000).toISOString() }, t), true);
  assert.equal(E.membRowActive({ status: "active", expires_at: new Date(t - 1000).toISOString() }, t), false);
  assert.equal(E.membRowActive({ status: "revoked", expires_at: new Date(t + 1000).toISOString() }, t), false);
  assert.equal(E.membRowActive({ status: "grace", expires_at: new Date(t + 1000).toISOString() }, t), true);
  assert.equal(E.membRowActive(null, t), false);
});

test("CAS-971: price and trial text come from StoreKit's product info", () => {
  const E = loadEngine();
  const line = E.membPriceLine({ priceString: "A$3.99", introductoryPrice: { price: 0, subscriptionPeriod: { numberOfUnits: 1, unit: 2 } } });
  assert.equal(line, "1 month free, then A$3.99/month · cancel any time.");
  assert.equal(E.membPriceLine(null), "");
});

test("CAS-971: on the web there is no purchase action — and no fine-print line (Lee, 14 Nov: the offer box carries the terms)", () => {
  const E = loadEngine();
  assert.equal(E.membCtaLabel(), "Continue");
  assert.equal(E.membFineText(), "");
});
