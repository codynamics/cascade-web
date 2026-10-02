// CAS-957: device caches (the agent list first among them) used to be keyed to the DEVICE, not the
// account — a second account signing in on the same device inherited whatever the first account left in
// localStorage, and the account fan-out's own "offer up what's genuinely new" merge then tried to push those
// inherited rows back to Supabase under the wrong owner, which RLS correctly refused (42501) — or, worse,
// silently accepted for an id the account had simply never seen. These tests drive the real seam
// (loadAccount/loadGuest/CascadePersistence.syncCascadesToAccount, the same ones the auth-change listener
// calls in production) with a stubbed Supabase client.
//
// CAS-1109: agents moved onto the account store (acctLoad/acctOp) — rewritten against that architecture's own
// fake-client conventions (acctLoad pages with .select().order().range(); an acctOp "insert" calls
// .upsert(fields, {onConflict:"id", ignoreDuplicates:true}); an "update" calls
// .update(fields).match(match)[.eq("updated_at", v)].select()), the same shapes cas1096-account-store.test.mjs
// and cas1097-agent-films-acctop.test.mjs use for their own tables.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const settle = () => new Promise(r => setTimeout(r, 0));

function fakeCascadesClient({ selectRows = [], upsertHandler, updateHandler } = {}){
  const upsertCalls = [];
  const updateCalls = [];
  return {
    upsertCalls, updateCalls,
    from(table){
      assert.equal(table, "cascades", "this fake only serves the cascades table");
      return {
        select(){
          const thenable = { then(resolve){ return Promise.resolve({ data: selectRows, error: null }).then(resolve); } };
          thenable.order = () => thenable; thenable.range = () => thenable;
          return thenable;
        },
        upsert(fields){
          upsertCalls.push(fields);
          const result = upsertHandler ? upsertHandler(fields) : { data: [fields], error: null };
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
        update(fields){
          const call = { fields };
          updateCalls.push(call);
          const chain = {
            match(m){ call.match = m; return chain; },
            eq(col, v){ call.eq = { col, v }; return chain; },
            select(){
              const result = updateHandler ? updateHandler(call) : { data: [{ ...call.match, ...fields }], error: null };
              return Promise.resolve(result);
            },
          };
          return chain;
        },
      };
    },
  };
}
function signIn(E, userId, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}

test("CAS-957 AC2: a second account signing in on the same device never inherits the first account's agents, and never writes either account's ids under the wrong owner", async () => {
  const E = loadEngine();

  // Sign in as A, create two agents.
  signIn(E, "cas957-acct-A", fakeCascadesClient({ selectRows: [] }));
  await E.CascadePersistence.loadAccount();
  assert.equal(E.cascades.length, 0, "sanity: A's account starts empty");
  E.cascades.push(
    E.normCascade({ id: "a0000000-0000-4000-8000-000000000a01", kind: "stream", status: [] }),
    E.normCascade({ id: "a0000000-0000-4000-8000-000000000a02", kind: "stream", status: [] }),
  );
  const clientA = fakeCascadesClient({ selectRows: [] });
  signIn(E, "cas957-acct-A", clientA);
  E.CascadePersistence.syncCascadesToAccount();
  await settle();
  assert.deepEqual(clientA.upsertCalls.map(r => r.id).sort(), ["a0000000-0000-4000-8000-000000000a01", "a0000000-0000-4000-8000-000000000a02"],
    "sanity: A's own two agents really did get inserted under A's account");

  // Sign out.
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.CascadePersistence.loadGuest();
  assert.equal(E.cascades.length, 0, "signed out shows no agents");

  // Sign in as B, whose account already has one agent of its own. Built through the real cascadeToRow (not
  // hand-rolled) so alert_moments/criteria are exactly what that agent's own normCascade defaults compute —
  // a mismatched fixture would make the very first sync pass see (correct, but here unwanted) drift to push.
  const B_ID = "b0000000-0000-4000-8000-000000000001";
  const bRowBase = E.CascadeShape.cascadeToRow(E.normCascade({ id: B_ID, name: "B agent" }));
  const bRow = { ...bRowBase, user_id: "cas957-acct-B", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  const clientB = fakeCascadesClient({ selectRows: [bRow] });
  signIn(E, "cas957-acct-B", clientB);
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify([B_ID]), "B's list must contain exactly B's own agent, none of A's");
  E.CascadePersistence.syncCascadesToAccount();
  await settle();
  assert.equal(clientB.upsertCalls.length, 0, "no insert must be attempted — B's own unchanged agent is already known to the account store");
  assert.equal(clientB.updateCalls.length, 0, "no update must be attempted either — nothing about B's agent actually changed");
});

test("CAS-957 AC3: a refused (42501) new-agent insert is dropped from the local list, not retried, and the sync-degraded flag clears", async () => {
  const E = loadEngine();
  signIn(E, "cas957-acct-c", fakeCascadesClient({ selectRows: [] }));
  await E.CascadePersistence.loadAccount();
  E.cascades.push(E.normCascade({ id: "c0000000-0000-4000-8000-000000000c01", kind: "stream", status: [] }));

  const refusingClient = fakeCascadesClient({
    selectRows: [],
    upsertHandler: () => ({ data: null, error: { code: "42501", message: "new row violates row-level security policy" }, status: 403 }),
  });
  signIn(E, "cas957-acct-c", refusingClient);
  E.CascadePersistence.syncCascadesToAccount();
  await settle();

  assert.equal(E.cascades.length, 0, "the refused row must be dropped from the local list");
  assert.equal(E.CascadePersistence.anySyncTargetDegraded(), false, "a single handled 42501 must not read as a degraded sync target");

  const secondClient = fakeCascadesClient({ selectRows: [] });
  signIn(E, "cas957-acct-c", secondClient);
  E.CascadePersistence.syncCascadesToAccount();
  await settle();
  assert.equal(secondClient.upsertCalls.length, 0, "a dropped row must never be retried on the next sync — it no longer exists in `cascades`");
});

test("CAS-957 AC4: a device carrying pre-namespacing cascade_cascades data does not leak it into a different account signing in, and the legacy key is cleaned up", async () => {
  const E = loadEngine();
  E.localStorage.setItem("cascade_cascades", JSON.stringify([
    { id: "legacy-a-1", name: "A's old agent", kind: "stream", status: [] },
  ]));

  const B_ID = "b0000000-0000-4000-8000-0000000000b1";
  const bRow = { id: B_ID, user_id: "cas957-acct-d-B", name: "B real agent", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  signIn(E, "cas957-acct-d-B", fakeCascadesClient({ selectRows: [bRow] }));
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify([B_ID]), "the legacy account's agents must never reach a different account signing in");
  assert.equal(E.localStorage.getItem("cascade_cascades"), null, "the unnamespaced legacy key must be gone after the one-time migration");
});

test("CAS-957 AC5: every read of the agent-list cache goes through the namespaced accessor, never the bare literal key", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const count = (src.match(/localStorage\.getItem\("cascade_cascades"\)/g) || []).length;
  assert.equal(count, 0, "grep -c 'localStorage.getItem(\"cascade_cascades\")' app_template.html must return 0");
});
