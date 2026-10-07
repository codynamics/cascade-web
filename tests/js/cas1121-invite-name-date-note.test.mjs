// CAS-1121: the Invite sheet's "Your name" (required, remembered), "Suggested date" and "Note" (both
// optional). AC1: sending inserts sender_name/suggested_date/note and updates user_prefs.display_name.
// AC3: the invite page's own ask-panel render shows both lines when present and neither when absent —
// pinned against fpInviteAskHTML directly (see app_template.html's CAS-1121 comment on why that render
// is a pure function), since the DOM insert itself is wire code this harness's stub DOM swallows.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A chainable fake query builder covering the shapes this flow needs: a plain insert() (invites,
// invite_emails), acctOp's own upsert(fields, opts) (the display_name push — CAS-1218: pushUserPrefsCols
// moved from update().match().select() to a single upsert call, so the first real column write can create
// the row a load no longer bootstrap-inserts), and update().eq() (the friends.last_used_at stamp) — same
// convention cas1095-userprefs-cols.test.mjs uses.
function makeQueryBuilder(table, calls){
  const state = { table };
  const b = {
    insert(rows){ calls.push({ table, kind: "insert", rows }); return Promise.resolve({ error: null }); },
    upsert(fields, opts){
      calls.push({ table, kind: "upsert", fields, opts });
      return Promise.resolve({ data: [fields], error: null, status: 200 });
    },
    update(fields){ state.kind = "update"; state.fields = fields; return b; },
    match(m){ state.match = m; return b; },
    eq(col, val){ state.eqCol = col; state.eqVal = val; calls.push({ ...state }); return Promise.resolve({ error: null }); },
    select(){ calls.push({ ...state }); return Promise.resolve({ data: [state.fields || {}], error: null, status: 200 }); },
  };
  return b;
}
function fakeSupabase(calls){
  return { from(table){ return makeQueryBuilder(table, calls); } };
}

function signIn(E, client, { userId = "cas1121-test-user", email = "sam@example.com" } = {}){
  const auth = E.CascadeAuth;
  auth.enabled = true;
  auth.client = client;
  auth.session = { user: { id: userId } };
  auth.status = "signed-in";
  auth.user = { email };
}

test("CAS-1121 AC1: sending with a name, date and note inserts sender_name/suggested_date/note and remembers the name", async () => {
  const E = loadEngine();
  const calls = [];
  signIn(E, fakeSupabase(calls));
  const sam = { id: 1, name: "Sam", email: "sam@example.com" };
  E.setFriends([sam]);
  E.openFilmInvite(E.MOVIES[0].tmdb_id);
  E.setInviteFriendSel(new Map([["1", { channel: "email" }]]));
  E.setInviteNameVal("Priya Lee");
  E.setInviteDateVal(E.TODAY);
  E.setInviteNoteVal("Bring snacks");

  await E.sendFilmInvite();
  await new Promise(r => setTimeout(r, 0));   // let acctOp's queued display_name push resolve

  const insert = calls.find(c => c.table === "invites" && c.kind === "insert");
  assert.ok(insert, "expected an invites insert");
  assert.equal(insert.rows[0].sender_name, "Priya Lee");
  assert.equal(insert.rows[0].suggested_date, E.TODAY);
  assert.equal(insert.rows[0].note, "Bring snacks");
  assert.equal(E.displayNameCache, "Priya Lee");
  const prefsUpdate = calls.find(c => c.table === "user_prefs" && c.kind === "upsert");
  assert.ok(prefsUpdate, "expected a user_prefs upsert");
  assert.equal(prefsUpdate.fields.display_name, "Priya Lee");
});

test("CAS-1121: date and note are optional — omitting both still sends, with neither column set", async () => {
  const E = loadEngine();
  const calls = [];
  signIn(E, fakeSupabase(calls));
  const sam = { id: 1, name: "Sam", email: "sam@example.com" };
  E.setFriends([sam]);
  E.openFilmInvite(E.MOVIES[0].tmdb_id);
  E.setInviteFriendSel(new Map([["1", { channel: "email" }]]));
  E.setInviteNameVal("Priya");

  await E.sendFilmInvite();

  const insert = calls.find(c => c.table === "invites" && c.kind === "insert");
  assert.equal(insert.rows[0].sender_name, "Priya");
  assert.equal(insert.rows[0].suggested_date, null);
  assert.equal(insert.rows[0].note, null);
});

test("CAS-1121: the name prefills from the remembered display name when the account has one", () => {
  const E = loadEngine();
  E.CascadeAuth.enabled = true;
  E.CascadeAuth.status = "signed-in";
  E.CascadeAuth.user = { email: "sam@example.com" };
  E.setDisplayNameCache("Sam Example");
  assert.equal(E.inviteDefaultName(), "Sam Example");
});

test("CAS-1121: the name falls back to the email local part when the account has no remembered name", () => {
  const E = loadEngine();
  E.CascadeAuth.enabled = true;
  E.CascadeAuth.status = "signed-in";
  E.CascadeAuth.user = { email: "sam@example.com" };
  E.setDisplayNameCache(null);
  assert.equal(E.inviteDefaultName(), "sam");
});

test("CAS-1121 AC3: the invite page's ask panel shows both lines when the sender set both", () => {
  const E = loadEngine();
  const html = E.fpInviteAskHTML({ sender_name: "Lee", suggested_date: "2026-10-20", note: "Bring popcorn" });
  assert.match(html, /Suggested: 20 Oct 26/);
  assert.match(html, /Bring popcorn/);
});

test("CAS-1121 AC3: the invite page's ask panel shows neither line when the sender set neither", () => {
  const E = loadEngine();
  const html = E.fpInviteAskHTML({ sender_name: "Lee", suggested_date: null, note: null });
  assert.doesNotMatch(html, /Suggested:/);
  assert.doesNotMatch(html, /fpinvite-note/);
});

test("CAS-1121 AC3: a note with a line break renders a <br>, escaped first", () => {
  const E = loadEngine();
  const html = E.fpInviteAskHTML({ sender_name: "Lee", suggested_date: null, note: "Line one\n<script>alert(1)</script>" });
  assert.match(html, /Line one<br>&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});
