// CAS-1131: Recommend Cascade must never queue the same address twice in one send. sendRecommend
// de-dupes its selected recipients by lower-cased email before inserting (the monitor-side fold for
// rows that already made it into the table is covered by monitor/tests/test_recommend.py). This pins
// AC2 directly: two friends who share one email insert exactly one `recommendations` row.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function fakeSupabase(calls){
  return {
    from(table){
      return {
        insert(rows){ calls.push({ table, rows }); return Promise.resolve({ error: null }); },
        update(){ return { eq(){ return Promise.resolve({ error: null }); } }; },
      };
    },
  };
}

function signIn(E, client, userId = "cas1131-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true;
  auth.client = client;
  auth.session = { user: { id: userId } };
}

test("CAS-1131 AC2: selecting two friends with the same email (different case) inserts one recommendations row", async () => {
  const E = loadEngine();
  const calls = [];
  signIn(E, fakeSupabase(calls));
  const sam = { id: 1, name: "Sam", email: "Sam@Example.com" };
  const sammy = { id: 2, name: "Sammy", email: "sam@example.com" };
  E.setFriends([sam, sammy]);
  E.setRecommendFriendSel(new Map());
  E.toggleFriendSelect("recommend", "1");
  E.toggleFriendSelect("recommend", "2");
  assert.equal(E.recommendFriendSel.size, 2);

  await E.sendRecommend();

  const inserts = calls.filter(c => c.table === "recommendations");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].rows.length, 1);
});

test("CAS-1131: two friends with different emails still each insert their own row", async () => {
  const E = loadEngine();
  const calls = [];
  signIn(E, fakeSupabase(calls));
  const sam = { id: 1, name: "Sam", email: "sam@example.com" };
  const priya = { id: 2, name: "Priya", email: "priya@example.com" };
  E.setFriends([sam, priya]);
  E.setRecommendFriendSel(new Map());
  E.toggleFriendSelect("recommend", "1");
  E.toggleFriendSelect("recommend", "2");

  await E.sendRecommend();

  const inserts = calls.filter(c => c.table === "recommendations");
  assert.equal(inserts.length, 2);
});
