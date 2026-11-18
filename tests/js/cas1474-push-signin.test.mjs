// CAS-1474: the device's APNs token must follow whoever is signed in. Sign-in re-registers under the
// current user, sign-out removes the token from the leaving user, relaunch refreshes last_seen_at.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function makeStore(){
  const rows = [];   // { user_id, device_token, last_seen_at }
  return {
    rows,
    from(table){
      assert.equal(table, "push_tokens");
      return {
        upsert(r){
          const x = r[0];
          const i = rows.findIndex(y => y.user_id === x.user_id && y.device_token === x.device_token);
          if(i >= 0) rows[i] = { ...rows[i], ...x }; else rows.push({ ...x });
          return Promise.resolve({ error: null });
        },
        delete(){
          const f = {};
          const q = { eq(k, v){ f[k] = v; return q; },
            then(res){ for(let i = rows.length - 1; i >= 0; i--) if(Object.keys(f).every(k => rows[i][k] === f[k])) rows.splice(i, 1); return Promise.resolve({ error: null }).then(res); } };
          return q;
        },
      };
    },
    // Stand-in for the claim_push_token() SECURITY DEFINER function: strips the token from every other user.
    async rpc(name, args){
      assert.equal(name, "claim_push_token");
      return { error: null };
    },
  };
}
function setUser(E, client, id){
  const a = E.CascadeAuth;
  a.enabled = !!id; a.client = id ? client : null; a.session = id ? { user: { id } } : null;
}
function makeCapacitor(token){
  const L = {};
  return { isNativePlatform: () => true,
    Plugins: { PushNotifications: {
      async checkPermissions(){ return { receive: "granted" }; },
      addListener(ev, cb){ L[ev] = cb; },
      async register(){ await L.registration({ value: token }); },
    } } };
}

test("CAS-1474: sign-in as A, sign-out, sign-in as B moves the token; relaunch refreshes last_seen_at", async () => {
  const E = loadEngine();
  const store = makeStore();
  E.window.Capacitor = makeCapacitor("tok-1");
  try {
    setUser(E, store, "A");
    assert.equal(await E.reRegisterPushIfGranted(), true);
    assert.deepEqual(store.rows.map(r => r.user_id), ["A"]);
    assert.equal(store.rows[0].device_token, "tok-1");

    assert.equal(await E.removeMyPushToken(), true);   // sign-out click, before auth.signOut()
    setUser(E, store, null);
    assert.equal(store.rows.length, 0);

    setUser(E, store, "B");
    await E.reRegisterPushIfGranted();                 // sign-in as B
    assert.deepEqual(store.rows.map(r => r.user_id), ["B"]);

    const first = store.rows[0].last_seen_at;
    await new Promise(r => setTimeout(r, 5));
    await E.reRegisterPushIfGranted();                 // relaunch
    assert.equal(store.rows.length, 1);
    assert.ok(store.rows[0].last_seen_at > first, "last_seen_at must move on relaunch");
  } finally { delete E.window.Capacitor; setUser(E, store, null); }
});

test("CAS-1474: removeMyPushToken with no remembered token or no session is a no-op", async () => {
  const E = loadEngine();
  setUser(E, makeStore(), null);
  assert.equal(await E.removeMyPushToken(), false);
});
