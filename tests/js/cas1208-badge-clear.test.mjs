// CAS-1208: the OS app-icon number only ever grew (monitor/__main__.py's badge arithmetic runs at
// push time only) — nothing on-device ever cleared it. markRealAlertsRead() is the one place that
// runs whenever a member reads the bell, whether by opening Alerts or by tapping a notification
// (CAS-466/CAS-1206), so it is also where the native badge gets cleared. This asserts the clear call
// — PushNotifications.removeAllDeliveredNotifications(), which resets applicationIconBadgeNumber as a
// side effect inside the plugin's own Swift source — fires exactly once after markRealAlertsRead()
// resolves, and that nothing throws when Capacitor is absent (the web build).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeFakeClient(){
  const updateCalls = [];
  return {
    updateCalls,
    from(table){
      return {
        update(fields){
          return {
            eq(col, val){
              return {
                is(col2, val2){
                  updateCalls.push({ table, fields, col, val, col2, val2 });
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1208-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function makeCapacitor(){
  const clearCalls = [];
  return {
    isNativePlatform(){ return true; },
    Plugins: {
      PushNotifications: {
        async removeAllDeliveredNotifications(){ clearCalls.push(true); },
      },
    },
    _clearCalls: clearCalls,
  };
}

test("CAS-1208: markRealAlertsRead() clears the native badge exactly once", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  signIn(E, client);
  const cap = makeCapacitor();
  E.window.Capacitor = cap;
  E.realAlerts.push({ id: "n1", movie_id: 1, moment: "stream", title: "Cascade Test", cascade_name: "Massive Movies", emailed_at: "2026-10-06T10:00:00.000Z", read_at: null });
  try {
    await E.window.markRealAlertsRead();
    assert.equal(cap._clearCalls.length, 1, "the native badge clear must be called exactly once");
    assert.equal(client.updateCalls.length, 1, "the ledger's read_at update must still run");
  } finally {
    E.realAlerts.length = 0;
    delete E.window.Capacitor;
    signOut(E);
  }
});

test("CAS-1208: markRealAlertsRead() is a no-op on badge clearing when Capacitor is absent", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  signIn(E, client);
  E.realAlerts.push({ id: "n2", movie_id: 2, moment: "stream", title: "Cascade Test 2", cascade_name: "Massive Movies", emailed_at: "2026-10-06T10:00:00.000Z", read_at: null });
  try {
    await assert.doesNotReject(E.window.markRealAlertsRead());
  } finally {
    E.realAlerts.length = 0;
    signOut(E);
  }
});
