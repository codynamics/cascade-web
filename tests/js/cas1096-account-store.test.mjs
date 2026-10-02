// CAS-1096 AC2 — verdicts (user_films) moved off the whole-set diff sync onto acctOp: every verdict change
// is one operation on that one row, never a whole-table upsert/delete pass. This drives the real seam
// (window.setOpinion -> pushFilmVerdict -> CascadeAccountStore.acctOp) against a stubbed Supabase client,
// the same convention cas1039-sync-chunking.test.mjs's own makeFakeClient used before its film_watch/
// user_films cases moved here (see that file's own header comment).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// acctOp's real shapes: an "upsert" kind calls .upsert(oneRowObject, {onConflict}); a "delete" kind calls
// .delete().match(op.match); acctLoad calls .select("*").order(pk,{ascending:true}).range(from,to).
function makeFakeClient(){
  const upsertCalls = [];
  const deleteCalls = [];
  return {
    upsertCalls, deleteCalls,
    from(table){
      return {
        select(){
          const thenable = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          thenable.order = () => thenable; thenable.range = () => thenable;
          return thenable;
        },
        upsert(row){
          upsertCalls.push({ table, row });
          return { then(resolve){ return Promise.resolve({ data: [row], error: null }).then(resolve); } };
        },
        delete(){
          const chain = {
            match(obj){ deleteCalls.push({ table, match: obj }); return chain; },
            then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); },
          };
          return chain;
        },
      };
    },
  };
}
function signIn(E, client, userId = "cas1096-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

test("CAS-1096 AC2: clearing one verdict issues exactly one delete, filtered on that movie_id", async () => {
  const E = loadEngine();
  const client = makeFakeClient();
  signIn(E, client);
  try{
    const id = 1096001;
    E.setOpinion(id, "liked");
    await new Promise(r => setTimeout(r, 0));   // let the upsert's own acctOp call resolve
    client.upsertCalls.length = 0; client.deleteCalls.length = 0;

    E.setOpinion(id, "liked");   // tapping the lit answer again clears it (CAS-100)
    await new Promise(r => setTimeout(r, 0));

    const deletes = client.deleteCalls.filter(c => c.table === "user_films");
    assert.equal(deletes.length, 1, "clearing one verdict must issue exactly one delete");
    assert.equal(deletes[0].match.movie_id, String(id), "the delete must be filtered on that one movie_id");
    assert.equal(client.upsertCalls.filter(c => c.table === "user_films").length, 0,
      "clearing a verdict must not also upsert");
  } finally{ signOut(E); }
});
