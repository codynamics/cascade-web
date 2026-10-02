// CAS-1125: Recommend Cascade's friend row becomes one tap target (no separate selection circle), and
// its default message no longer greets anyone by name. These pin AC1 and AC3 directly.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const FRIEND = { id: 1, name: "Sam", email: "sam@example.com" };

test("CAS-1125 AC1: friendRowHTML's only onclick is the row itself calling toggleFriendSelect — no separate .fcheck button", () => {
  E.setFriends([FRIEND]);
  E.setRecommendFriendSel(new Map());
  const html = E.friendRowHTML(FRIEND, { selectable: true, ctx: "recommend", selMap: E.recommendFriendSel });
  const rowOpenTag = html.slice(0, html.indexOf(">") + 1);
  assert.match(rowOpenTag, /onclick="toggleFriendSelect\('recommend','1'\)"/);
  assert.doesNotMatch(html, /<button[^>]*class="fcheck/);
});

test("CAS-1125 AC1: toggling the same friend twice selects then deselects", () => {
  E.setFriends([FRIEND]);
  E.setRecommendFriendSel(new Map());
  assert.equal(E.recommendFriendSel.size, 0);
  E.toggleFriendSelect("recommend", "1");
  assert.equal(E.recommendFriendSel.size, 1);
  assert.ok(E.recommendFriendSel.has("1"));
  E.toggleFriendSelect("recommend", "1");
  assert.equal(E.recommendFriendSel.size, 0);
});

test("CAS-1125 AC1: channel buttons are hidden on an unselected row and shown once selected", () => {
  E.setFriends([FRIEND]);
  E.setRecommendFriendSel(new Map());
  const unselected = E.friendRowHTML(FRIEND, { selectable: true, ctx: "recommend", selMap: E.recommendFriendSel });
  assert.doesNotMatch(unselected, /<button[^>]*class="fchan/);

  E.toggleFriendSelect("recommend", "1");
  const selected = E.friendRowHTML(FRIEND, { selectable: true, ctx: "recommend", selMap: E.recommendFriendSel });
  assert.match(selected, /class="frow fchoice fsel"/);
  assert.match(selected, /class="fchan on"[^>]*onclick="event\.stopPropagation\(\);setFriendChannel\('recommend','1','email'\)/);
});

test("CAS-1125 AC3: recommendMessageFor(\"Sam\",\"lee+c20\") returns exactly the new text, ignoring the friend's name", () => {
  assert.equal(
    E.recommendMessageFor("Sam", "lee+c20"),
    "Hi there — I've been using Cascade to find and keep track of films I mean to see. Thought you'd like it. — lee+c20",
  );
});
