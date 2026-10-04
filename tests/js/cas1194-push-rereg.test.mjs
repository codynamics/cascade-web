// CAS-1194: registerPush() only ever ran when the user exercised the in-app toggle, so a device
// that was granted permission on an earlier launch never refreshed its APNs token again —
// push_tokens.last_seen_at sat frozen at the original grant while the app kept being opened on
// newer builds. reRegisterPushIfGranted() is the fix: on every native launch, ask the OS what it
// already decided (checkPermissions, never requestPermissions) and only register/upsert when the
// answer is already "granted" — never a prompt either way.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeFakeClient(){
  const upsertCalls = [];
  return {
    upsertCalls,
    from(table){
      return {
        upsert(rows, opts){
          upsertCalls.push({ table, rows, opts });
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1194-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function makeCapacitor({ granted }){
  const registerCalls = [];
  const listeners = {};
  return {
    isNativePlatform(){ return true; },
    Plugins: {
      PushNotifications: {
        async checkPermissions(){ return { receive: granted ? "granted" : "prompt" }; },
        addListener(event, cb){ listeners[event] = cb; },
        async register(){ registerCalls.push(true); },
      },
    },
    _registerCalls: registerCalls,
    _listeners: listeners,
  };
}

test("CAS-1194: a launch with permission already granted re-registers and upserts a fresh token", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  signIn(E, client);
  const cap = makeCapacitor({ granted: true });
  E.window.Capacitor = cap;
  try {
    const result = await E.reRegisterPushIfGranted();
    assert.equal(result, true);
    assert.equal(cap._registerCalls.length, 1, "register() must be called once permission is already granted");
    assert.ok(cap._listeners.registration, "a registration listener must be attached before register()");
    // Simulate the native layer delivering this launch's (possibly refreshed) device token.
    await cap._listeners.registration({ value: "fresh-device-token" });
    assert.equal(client.upsertCalls.length, 1);
    const { table, rows } = client.upsertCalls[0];
    assert.equal(table, "push_tokens");
    assert.equal(rows[0].device_token, "fresh-device-token");
    assert.ok(rows[0].last_seen_at, "last_seen_at must be stamped fresh on every re-registration");
  } finally {
    delete E.window.Capacitor;
    signOut(E);
  }
});

test("CAS-1194: a launch without permission makes no registration call and shows no prompt", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  signIn(E, client);
  const cap = makeCapacitor({ granted: false });
  let requestedPermission = false;
  cap.Plugins.PushNotifications.requestPermissions = async () => {
    requestedPermission = true;
    return { receive: "granted" };
  };
  E.window.Capacitor = cap;
  try {
    const result = await E.reRegisterPushIfGranted();
    assert.equal(result, false);
    assert.equal(cap._registerCalls.length, 0, "register() must never be called without permission already granted");
    assert.equal(cap._listeners.registration, undefined, "no listener should be attached either");
    assert.equal(requestedPermission, false, "checkPermissions must never escalate into a permission prompt");
    assert.equal(client.upsertCalls.length, 0);
  } finally {
    delete E.window.Capacitor;
    signOut(E);
  }
});
