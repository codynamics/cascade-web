// CAS-1205: a signed-in member landing on a film page (an alert email's answer link, or any other
// #/film/<id>) gets the member version — a confirmation panel when the page was opened by an applied
// answer, the Watch On/Watched columns, and a Done button — never the visitor's "Become a Cascade Member"
// pitch. A signed-out visitor keeps today's page, byte-for-byte.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";
import { freshFilmId } from "./fresh-film-id.mjs";

function signIn(E){
  E.CascadeAuth.enabled = true;
  E.CascadeAuth.client = {};
  E.CascadeAuth.session = { user: { id: "cas1205-test-user" } };
  E.CascadeAuth.status = "signed-in";
}

test("CAS-1205: signed out, the film page is exactly today's visitor markup", () => {
  const E = loadEngine();
  const m = E.MOVIES[0];
  const html = E.filmPageHTML(m);
  assert.ok(html.includes("Become a Cascade Member"), "the visitor CTA must still be there");
  assert.ok(html.includes("fpfoot"), "the visitor footer line must still be there");
  assert.ok(!html.includes("fpcols"), "no member columns for a visitor");
});

test("CAS-1205: signed in, no membership pitch and no visitor footer", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[0];
  const html = E.filmPageHTML(m);
  assert.ok(!html.includes("Become a Cascade Member"), "a member must never see the membership pitch");
  assert.ok(!html.includes("fpfoot"), "a member must never see the visitor footer");
  assert.ok(html.includes("WATCH ON") && html.includes("WATCHED"), "both columns must be present");
  assert.ok(/class="fpcta"[^>]*onclick="closeFilmPage\(\)">Done</.test(html), "the Done button must close the page");
});

test("CAS-1205: the WATCH ON column runs Cinema, Rent, Stream, then Never, on default Service tracking", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[1];
  const html = E.filmPageHTML(m);
  const iCin = html.indexOf('data-key="in_cinema"');
  const iRent = html.indexOf('data-key="rent"');
  const iStream = html.indexOf('data-key="stream"');
  const iNever = html.indexOf('data-key="never"');
  assert.ok(iCin >= 0 && iRent > iCin && iStream > iRent && iNever > iStream,
    "order must be Cinema, Rent, Stream, Never — Premium is off by default and must not appear");
  assert.ok(!html.includes('data-key="premium"'), "Premium is off in default Service tracking — no segment for it");
});

test("CAS-1205: tapping a Watch On segment calls toggleFilmOpt, Never calls pickNever — same as the card", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[2];
  const html = E.filmPageHTML(m);
  assert.ok(html.includes(`onclick="toggleFilmOpt(${m.tmdb_id},'in_cinema')"`));
  assert.ok(html.includes(`onclick="toggleFilmOpt(${m.tmdb_id},'rent')"`));
  assert.ok(html.includes(`onclick="toggleFilmOpt(${m.tmdb_id},'stream')"`));
  assert.ok(html.includes(`onclick="pickNever(${m.tmdb_id})"`));
});

test("CAS-1205: a Watch On tick lights its own segment, through the real toggleFilmOpt", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[3];
  E.toggleFilmOpt(m.tmdb_id, "rent");
  const html = E.filmPageHTML(m);
  assert.ok(html.includes('class="cseg on" data-key="rent"'), "the Rent segment must be lit");
  assert.ok(!html.includes('class="cseg on" data-key="in_cinema"'), "Cinema must not also be lit — single-select");
});

test("CAS-1205: the WATCHED column is watchStepsSegmentsHTML, wired to the real pickWatch", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[4];
  const html = E.filmPageHTML(m);
  for(const step of E.WATCH_STEPS){
    assert.ok(html.includes(`onclick="pickWatch(${m.tmdb_id},'${step.key}')"`),
      `${step.key} must be wired to the real pickWatch, same as the card's own ramp`);
  }
});

test("CAS-1205: an applied cinema/rent/stream answer shows the confirmation panel, with no toast", () => {
  const E = loadEngine();
  signIn(E);
  const used = new Set();
  const cases = [
    ["cinema", "in_cinema", "Saved: watch at the Cinema"],
    ["rent", "rent", "Saved: watch on Rent"],
    ["stream", "stream", "Saved: watch on Stream"],
  ];
  for(const [answer, levelKey, lead] of cases){
    const m = freshFilmId(E, used, levelKey);
    E.location.hash = `#/film/${m.tmdb_id}`;
    E.setPendingAnswer(answer);
    E.applyPendingAnswer();
    const html = E.filmPageHTML(m);
    assert.ok(html.includes(lead), `panel must read "${lead}" for a ${answer} answer`);
    assert.ok(html.includes(`class="cseg on" data-key="${levelKey}"`), `the ${levelKey} segment must be lit`);
  }
});

test("CAS-1205: the confirmation panel names what's actually in cinemas/renting/streaming now, vs later", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[5];
  m.status = ["in_cinema"];
  E.location.hash = `#/film/${m.tmdb_id}`;
  E.setPendingAnswer("cinema");
  E.applyPendingAnswer();
  assert.ok(E.filmPageHTML(m).includes(`${m.title} is in cinemas now.`));

  const m2 = E.MOVIES[6];
  m2.status = ["upcoming"];
  E.location.hash = `#/film/${m2.tmdb_id}`;
  E.setPendingAnswer("cinema");
  E.applyPendingAnswer();
  assert.ok(E.filmPageHTML(m2).includes(`We'll alert you when ${m2.title} opens.`));
});

test("CAS-1205: a never answer shows Saved: Never", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[7];
  E.location.hash = `#/film/${m.tmdb_id}`;
  E.setPendingAnswer("never");
  E.applyPendingAnswer();
  const html = E.filmPageHTML(m);
  assert.ok(html.includes("Saved: Never"));
  assert.ok(html.includes(`You won't hear about ${m.title} again.`));
  assert.ok(html.includes('class="cseg on" data-key="never"'));
});

test("CAS-1205: a watched answer shows Saved: <the step's own label>", () => {
  const E = loadEngine();
  signIn(E);
  const used = new Set();
  for(const step of E.WATCH_STEPS){
    const m = freshFilmId(E, used);
    E.location.hash = `#/film/${m.tmdb_id}`;
    E.setPendingAnswer(step.key);
    E.applyPendingAnswer();
    const html = E.filmPageHTML(m);
    assert.ok(html.includes(`Saved: ${step.lbl}`), `panel must read "Saved: ${step.lbl}" for ${step.key}`);
    assert.ok(html.includes("Marked as watched."));
  }
});

test("CAS-1205: a seen landing shows no confirmation panel — the Watched column is there to answer in", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[8];
  E.location.hash = `#/film/${m.tmdb_id}`;
  E.setPendingAnswer("seen");
  E.applyPendingAnswer();
  const html = E.filmPageHTML(m);
  assert.ok(!html.includes("fpconfirm"), "seen must never show the confirmation panel");
  assert.ok(html.includes("WATCHED"), "the Watched column is the answer surface instead");
});

test("CAS-1205: no applied answer, no panel — an ordinary #/film/<id> landing stays plain", () => {
  const E = loadEngine();
  signIn(E);
  const m = E.MOVIES[9];
  const html = E.filmPageHTML(m);
  assert.ok(!html.includes("fpconfirm"), "nothing was just saved, so there is nothing to confirm");
});
