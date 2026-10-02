// CAS-1119: the invite/share-link film page's top now renders from cardTopHTML(m) — the exact same code
// the expanded card's own top (poster..director/cast) and release band use — instead of its own bespoke
// markup, so it can never show a film differently than the card does. These pin the ticket's AC2 (content
// parity) and the CTA copy/behaviour changes (AC3); AC1 (the tutorial never showing over a #/film/ route)
// is a DOM/timing behaviour the engine.mjs stub's always-truthy querySelector can't represent meaningfully,
// so it is left to the existing e2e film-page coverage per the ticket's own AC wording.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function filmWithCredits(){
  const m = E.MOVIES.find(x => x.director && (x.cast || []).length && x.synopsis);
  assert.ok(m, "sanity: the catalogue must carry at least one film with a director, cast and synopsis");
  return m;
}

test("CAS-1119 AC2: filmPageHTML's top is literally cardTopHTML's output, not a re-derived copy", () => {
  const m = filmWithCredits();
  const top = E.cardTopHTML(m);
  const page = E.filmPageHTML(m);
  assert.ok(page.includes(top), "the invite/film page must embed cardTopHTML(m) verbatim");
});

test("CAS-1119 AC2: that shared top carries the synopsis, scores row, director and cast", () => {
  const m = filmWithCredits();
  const top = E.cardTopHTML(m);
  assert.ok(top.includes(`<p class="synopsis">${m.synopsis.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/'/g,"&#39;")}</p>`),
    "AC2: the full synopsis must be present");
  assert.match(top, /<div class="mrow r-scores">/, "AC2: the scores row must be present");
  assert.ok(top.includes(m.director), "AC2: the director must be present");
  for(const actor of m.cast) assert.ok(top.includes(actor), `AC2: cast member "${actor}" must be present`);
});

test("CAS-1119 AC3: the CTA reads exactly \"Become a Cascade Member\", and the old copy is gone", () => {
  const m = filmWithCredits();
  const page = E.filmPageHTML(m);
  assert.ok(page.includes(">Become a Cascade Member<"), "AC3: the CTA button copy must match exactly");
  assert.ok(!page.includes("Get Cascade — find more like this"), "AC3: the old CTA copy must be gone");
  assert.ok(page.includes("Cascade finds and tracks your favorite cinema, rental and streaming for you."),
    "the line under the CTA must match exactly");
});

test("CAS-1119: Become a Cascade Member opens cascademovies.com in a new tab and leaves the film page open", () => {
  const calls = [];
  const savedOpen = E.window.open;
  E.window.open = (...args) => { calls.push(args); return null; };
  try{
    E.filmPageCta();
  } finally {
    E.window.open = savedOpen;
  }
  assert.equal(calls.length, 1, "filmPageCta must call window.open exactly once");
  assert.deepEqual(calls[0], ["https://cascademovies.com/", "_blank", "noopener"]);
});

test("CAS-1119: no account controls — a visitor signed in on their OWN account still gets no sender-side invite button", () => {
  const m = filmWithCredits();
  const auth = E.CascadeAuth;
  const saved = { enabled: auth.enabled, status: auth.status };
  auth.enabled = true; auth.status = "signed-in";
  try{
    const page = E.filmPageHTML(m);
    assert.ok(!page.includes("filminvcta"), "AC: no account-gated controls on the invite/film page");
  } finally {
    auth.enabled = saved.enabled; auth.status = saved.status;
  }
});
