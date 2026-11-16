// CAS-1458: temporary membership-gate bypass, switched by public.app_config 'membership_bypass'.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function fakeClient({ bypass }) {
  return {
    from(table) {
      const rows = { memberships: null, app_config: bypass === undefined ? null : { value: bypass } };
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[table], error: null }) }) }) };
    },
  };
}
function setup(bypass, store = new Map()) {
  const E = loadEngine({ localStorageStore: store });
  const a = E.CascadeAuth;
  a.enabled = true; a.status = "signed-in"; a.client = fakeClient({ bypass });
  a.user = { id: "11111111-1111-4111-8111-111111111111" };
  // The permissive DOM stub answers truthy for oafScreen.classList.contains("open"), which would read as
  // "another full-screen flow is open" and skip the gate — give the lookups a real, closed answer.
  const closed = () => new Proxy({}, { get: (t, k) => (k === "classList" ? { contains: () => false, add(){}, remove(){} } : () => {}) });
  E.window.document.getElementById = () => closed();
  return { E, store };
}

test("CAS-1458: bypass true + no membership -> button shown; tap releases the gate, writes nothing to localStorage", async () => {
  const { E, store } = setup(true);
  await E.membGateCheck();
  const before = JSON.stringify([...store]);   // the screen's own analytics/etc. writes are not the bypass's
  assert.equal(E.membGated, true, "gate holds");
  assert.equal(E.membBypassShown, true, "bypass button visible");
  E.window.membBypassTap();
  assert.equal(E.membGated, false, "screen closed");
  await E.membGateCheck();
  assert.equal(E.membGated, false, "stays released through the session");
  assert.equal(JSON.stringify([...store]), before, "no localStorage writes");
});

for (const [label, v] of [["false", false], ["missing", undefined]]) {
  test(`CAS-1458: bypass ${label} -> no button, gate holds`, async () => {
    const { E } = setup(v);
    await E.membGateCheck();
    assert.equal(E.membGated, true);
    assert.equal(E.membBypassShown, false);
  });
}
