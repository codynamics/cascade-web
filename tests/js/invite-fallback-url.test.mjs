// CAS-929: window.shareFilm's navigator.share({title, text, url}) call is gone — CAS-272/284/928/930/931
// replaced the old Web Share sheet with the friends-picker invite flow entirely, so the Outlook-drops-the-
// url bug this ticket named can no longer happen on that path. What survives is openNextInviteChannel's
// (and its Recommend twin openNextRecommendChannel's) clipboard fallback — the one place CAS-929's own
// ticket text says to apply the same rule instead: "a target that reads only text still gets the link".
// These drive the real fallback functions (window.open is stubbed to always return null in this harness,
// so the clipboard branch always fires) and assert the copied text actually carries the full URL.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withCapturedClipboard(fn){
  const saved = E.navigator.clipboard;
  let captured = null;
  E.navigator.clipboard = { writeText: text => { captured = text; return Promise.resolve(); } };
  try{ fn(() => captured); }
  finally{ E.navigator.clipboard = saved; }
}

test("CAS-929: openNextInviteChannel's clipboard fallback carries the full invite URL", () => withCapturedClipboard(get => {
  const [m] = E.MOVIES;
  const token = "abc123tok9";
  const url = E.inviteUrlFor(token, m);
  E.openNextInviteChannel([{ friend: { name: "Alex", mobile: "0412345678" }, channel: "sms", token }], m);
  const text = get();
  assert.ok(text, "AC2: the clipboard fallback must have run");
  assert.ok(text.includes(url), "AC2: the copied text must include the full invite URL");
}));

test("CAS-929: openNextRecommendChannel's clipboard fallback carries the full cascademovies.com link", () => withCapturedClipboard(get => {
  E.openNextRecommendChannel([{ friend: { name: "Sam", mobile: "0412345678" }, channel: "whatsapp", message: "Come try Cascade" }]);
  const text = get();
  assert.ok(text, "AC2: the clipboard fallback must have run");
  assert.ok(text.includes("https://cascademovies.com"), "AC2: the copied text must include the full link");
}));

function withProtocol(protocol, fn){
  const saved = E.window.location.protocol;
  E.window.location.protocol = protocol;
  try{ fn(); } finally{ E.window.location.protocol = saved; }
}

// CAS-1175 AC1: the iPhone app's own origin (capacitor://localhost) is not an address anyone outside the
// app can open — inviteUrlFor falls back to the real cascademovies.com host whenever the page isn't
// served over http/https, and keeps linking to its own origin/path otherwise (a preview host or a test).
test("CAS-1175 AC1: inviteUrlFor falls back to https://cascademovies.com under capacitor:, keeps its own origin under http/https", () => {
  const m = { tmdb_id: 1228834 };
  withProtocol("capacitor:", () => {
    assert.equal(E.inviteUrlFor("abc", m), "https://cascademovies.com/?inv=abc#/film/1228834");
  });
  withProtocol("https:", () => {
    E.window.location.origin = "https://cascade-web-3x1.pages.dev";
    E.window.location.pathname = "/";
    try{
      assert.equal(E.inviteUrlFor("abc", m), "https://cascade-web-3x1.pages.dev/?inv=abc#/film/1228834");
    } finally {
      E.window.location.origin = "http://localhost";
      E.window.location.pathname = "/";
    }
  });
});

// CAS-1175 AC2: inviteMessageFor's four combinations, character for character, including the note's
// whitespace collapse (a multi-line/blank-line paste must still read as one line).
test("CAS-1175 AC2: inviteMessageFor returns the exact text for all four date/note combinations", () => {
  const url = "https://cascademovies.com/?inv=abc#/film/1228834";
  const base = { name: "Test", title: "The Fix", url };

  assert.equal(
    E.inviteMessageFor({ ...base, date: null, note: null }),
    "Test has invited you to watch The Fix with them.\n" + url,
  );
  assert.equal(
    E.inviteMessageFor({ ...base, date: "2026-10-05", note: null }),
    "Test has invited you to watch The Fix with them, and suggests Mon 05 Oct.\n" + url,
  );
  assert.equal(
    E.inviteMessageFor({ ...base, date: null, note: "Booked gold class, you in?" }),
    "Test has invited you to watch The Fix with them.\nTest says: “Booked gold class, you in?”\n" + url,
  );
  assert.equal(
    E.inviteMessageFor({ ...base, date: "2026-10-05", note: "Booked gold class, you in?" }),
    "Test has invited you to watch The Fix with them, and suggests Mon 05 Oct.\nTest says: “Booked gold class, you in?”\n" + url,
  );
  assert.equal(
    E.inviteMessageFor({ ...base, date: null, note: "  line one\n\nline two  " }),
    "Test has invited you to watch The Fix with them.\nTest says: “line one line two”\n" + url,
  );
});

// CAS-1175 AC3: the text handed to the sms:/wa.me URLs by openNextInviteChannel, once decoded, is exactly
// inviteMessageFor's own output for the date/note the sheet held — proven via the clipboard fallback
// (window.open is stubbed to always return null in this harness, same technique as the CAS-929 tests above).
test("CAS-1175 AC3: openNextInviteChannel's text equals inviteMessageFor's for the same name/date/note", () => withCapturedClipboard(get => {
  const [m] = E.MOVIES;
  const token = "abc123tok9";
  const queueItem = { friend: { name: "Alex", mobile: "0412345678" }, channel: "sms", token, name: "Test", date: "2026-10-05", note: "Booked gold class, you in?" };
  E.openNextInviteChannel([queueItem], m);
  const text = get();
  const expected = E.inviteMessageFor({ name: "Test", title: m.title, date: "2026-10-05", note: "Booked gold class, you in?", url: E.inviteUrlFor(token, m) });
  assert.equal(text, expected, "AC3: openNextInviteChannel's text must equal inviteMessageFor's output");
}));
