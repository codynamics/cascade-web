// CAS-1536: the "From your email" view in Alerts — an alert email's batch opens Alerts filtered to exactly that
// batch's films (read by batch_id, not from the 200-row realAlerts cap) under a band, each film carrying the
// app's own Watch On / Watched controls, every tap writing notifications.answer; and a To decide row/badge for
// emailed films not yet decided. Drives the shipped functions in the engine harness; the only stubs are the
// server reads/writes (window.loadAlertBatch / window.writeAlertAnswer) and the DOM node that records the body.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const BATCH = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// The engine's own permissive stub node (a copy of tests/js/engine.mjs's node()) for every id but #movingBody.
const node = () => new Proxy(function(){}, {
  get(t, k){
    if(k === "length") return 0;
    if(k === "children") return [];
    if(k === Symbol.iterator) return [][Symbol.iterator].bind([]);
    if(k === Symbol.toPrimitive) return hint => (hint === "string" ? "" : 0);
    if(k === "toString") return () => "";
    if(k === "valueOf") return () => 0;
    if(k === "textContent" || k === "innerHTML" || k === "value" || k === "className") return "";
    if(k === "then") return undefined;
    return node();
  },
  set(){ return true; }, apply(){ return node(); }, has(){ return true; }, deleteProperty(){ return true; },
});
const body = { html: "" };
const bodyEl = new Proxy({}, {
  get(t, k){
    if(k === "innerHTML") return body.html;
    if(k === "scrollTop") return 0;
    return node()[k];
  },
  set(t, k, v){ if(k === "innerHTML") body.html = v; return true; },
});
E.window.document.getElementById = id => (id === "movingBody" ? bodyEl : node());

function ownerCascade(id, order, name){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = order; c.name = name;
  return c;
}

// Run `fn` signed in (CascadePersistence stubbed active) with the server reads/writes stubbed, restoring after.
async function withBatch({films, owned, realAlertCount = 0, batch = {}}, fn){
  const cp = E.window.CascadePersistence;
  const saved = {
    active: cp.accountActive, ready: cp.agentFilmsReady, load: E.window.loadAlertBatch, write: E.window.writeAlertAnswer,
    hadAccount: E.localStorage.getItem("cascade_had_account"), onboarded: E.localStorage.getItem("cascade_onboarded"),
    cascades: [...E.cascades], realAlerts: [...E.realAlerts], watched: new Set(E.watched), blocked: new Set(E.blocked),
    notify: { ...E.notify },
  };
  const writes = [];
  cp.accountActive = () => true; cp.agentFilmsReady = true;
  E.localStorage.setItem("cascade_had_account", "1"); E.localStorage.setItem("cascade_onboarded", "1");
  E.setMovingReady(true);
  E.cascades.length = 0;
  const owner = ownerCascade("cas1536-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  owned.forEach(m => { E.notify[m.tmdb_id] = E.notify[m.tmdb_id] || {}; });
  E.realAlerts.length = 0;
  for(let i = 0; i < realAlertCount; i++){
    E.realAlerts.push({ id: `ra${i}`, movie_id: films[0].tmdb_id, moment: "hits_rent", title: "x", cascade_name: "x",
      found_at: new Date().toISOString(), read_at: null });
  }
  E.window.loadAlertBatch = async id => (id === BATCH ? {
    batch: { id: BATCH, sydney_date: "2026-11-22", kind: "daily", headline: "Max found 10 films for you", ...batch },
    rows: films.map((m, i) => ({ id: `n${i}`, movie_id: m.tmdb_id, moment: i === 0 ? "catchup" : "hits_rent",
      title: m.title, cascade_name: "Owner Agent", found_at: new Date(Date.UTC(2026, 10, 21, 20, 0, i)).toISOString(),
      read_at: null, answer: null, answered_at: null, batch_id: BATCH })),
  } : null);
  E.window.writeAlertAnswer = (movieId, key, at, ids) => { writes.push({ movieId, key, at, ids }); };
  try{ await fn({ writes, owner }); }
  finally{
    cp.accountActive = saved.active; cp.agentFilmsReady = saved.ready;
    E.window.loadAlertBatch = saved.load; E.window.writeAlertAnswer = saved.write;
    saved.hadAccount === null ? E.localStorage.removeItem("cascade_had_account") : E.localStorage.setItem("cascade_had_account", saved.hadAccount);
    saved.onboarded === null ? E.localStorage.removeItem("cascade_onboarded") : E.localStorage.setItem("cascade_onboarded", saved.onboarded);
    E.cascades.length = 0; E.cascades.push(...saved.cascades);
    E.realAlerts.length = 0; E.realAlerts.push(...saved.realAlerts);
    E.watched.clear(); saved.watched.forEach(x => E.watched.add(x));
    E.blocked.clear(); saved.blocked.forEach(x => E.blocked.add(x));
    Object.keys(E.notify).forEach(k => delete E.notify[k]); Object.assign(E.notify, saved.notify);
    E.setAlertBatches([]); E.setPendingBatch(null);
    if(E.movingBatch) E.closeBatchView();
    E.closeMovingScreen();
  }
}

const films = n => E.MOVIES.filter(m => !E.watched.has(m.tmdb_id)).slice(0, n);

test("CAS-1536 AC1: ?dl=alerts:batch:<uuid>[&film=] parses; anything not a well-formed uuid is ignored", () => {
  assert.equal(JSON.stringify(E.parseBatchLink(`alerts:batch:${BATCH}`, null)), JSON.stringify({ id: BATCH, film: null }));
  assert.equal(JSON.stringify(E.parseBatchLink(`alerts:batch:${BATCH.toUpperCase()}`, "603")), JSON.stringify({ id: BATCH, film: 603 }));
  assert.equal(E.parseBatchLink(`alerts:batch:${BATCH}`, "nope").film, null);
  for(const bad of ["alerts:batch:", "alerts:batch:123", `alerts:batch:${BATCH}x`, `alerts:batch:${BATCH.slice(1)}`,
                    `alerts:other:${BATCH}`, "moving", "", null, undefined]){
    assert.equal(E.parseBatchLink(bad, null), null, `${bad} must be ignored`);
  }
  assert.equal(E.pendingBatch, null, "no ?dl= at boot, so nothing pending");
});

test("CAS-1536 AC1: a signed-out device ignores a batch link and lands as today", async () => {
  E.setPendingBatch({ id: BATCH, film: null });
  let loaded = 0;
  const prev = E.window.loadAlertBatch;
  E.window.loadAlertBatch = async () => { loaded++; return null; };
  try{
    E.applyPendingBatch();   // guest: CascadePersistence.accountActive() is false
    assert.equal(loaded, 0, "no server read signed out");
    assert.equal(E.movingBatch, null);
  } finally { E.window.loadAlertBatch = prev; E.setPendingBatch(null); }
});

test("CAS-1536 AC1: signed in but mid-onboarding, the link is held and not consumed", async () => {
  await withBatch({ films: films(2), owned: [] }, async () => {
    E.localStorage.setItem("cascade_onboarded", "0");
    E.setPendingBatch({ id: BATCH, film: null });
    E.applyPendingBatch();
    assert.equal(E.movingBatch, null);
    assert.deepEqual(E.pendingBatch, { id: BATCH, film: null }, "still pending for the arrival call sites");
    E.localStorage.setItem("cascade_onboarded", "1");
    await E.applyPendingBatch();
    assert.equal(E.pendingBatch, null, "consumed once the main app is up");
    assert.equal(E.movingBatch.id, BATCH);
  });
});

test("CAS-1536 AC2: a 12-film batch shows all 12 under the band even with 200 newer realAlerts; All alerts returns", async () => {
  const fs = films(12);
  await withBatch({ films: fs, owned: fs, realAlertCount: 200 }, async () => {
    assert.equal(await E.openBatchView(BATCH, null), true);
    assert.equal(E.batchViewRows().length, 12);
    assert.match(body.html, /From your email · Sun 22 Nov · Max found 10 films for you/);
    assert.match(body.html, /All alerts/);
    fs.forEach(m => assert.ok(body.html.includes(`id="card-${m.tmdb_id}"`), `film ${m.tmdb_id} is in the view`));
    E.closeBatchView();
    assert.equal(E.movingBatch, null);
    assert.ok(!/From your email/.test(body.html), "the band is gone in the normal view");
  });
});

test("CAS-1536 AC2: a batch that isn't this member's (or doesn't exist) opens nothing", async () => {
  await withBatch({ films: films(2), owned: [] }, async () => {
    assert.equal(await E.openBatchView("11111111-2222-4333-8444-555555555555", null), false);
    assert.equal(E.movingBatch, null);
  });
});

test("CAS-1536 AC3: a watched, an ownerless and a Never film all stay in the batch view; the normal view is unchanged", async () => {
  const [a, b, c] = films(3);
  await withBatch({ films: [a, b, c], owned: [] }, async ({ owner }) => {
    await E.openBatchView(BATCH, null);
    // No agent owns any of them (no agent_films row, no pin): all three still show, in a lane with no agent name.
    assert.equal(JSON.stringify([...E.batchViewRows().map(r => r.m.tmdb_id)].sort()), JSON.stringify([a, b, c].map(m => m.tmdb_id).sort()));
    assert.ok(!body.html.includes("Owner Agent"), "ownerless rows sit without an agent lane name");
    E.setOpinion(a.tmdb_id, "enjoyed");   // watched
    E.pickNever(b.tmdb_id);               // Never
    E.openBatchView(BATCH, null);
    await E.openBatchView(BATCH, null);
    assert.equal(E.batchViewRows().length, 3, "watched / Never films do not vanish");
    assert.match(body.html, /mvchip watched">Watched</);
    assert.match(body.html, /mvitem mvnever/);
    // The unfiltered view still drops all of them (watched, Never films are not "moved"; ownerless are CAS-858-dropped).
    E.closeBatchView();
    E.realAlerts.length = 0;
    [a, b, c].forEach(m => E.realAlerts.push({ id: `r${m.tmdb_id}`, movie_id: m.tmdb_id, moment: "hits_rent",
      title: m.title, cascade_name: "x", found_at: new Date().toISOString(), read_at: null }));
    const ids = E.movingData().rows.map(r => r.m.tmdb_id);
    assert.ok(!ids.includes(a.tmdb_id), "a watched film is still dropped from the normal view");
    assert.ok(!ids.includes(c.tmdb_id) || owner, "an ownerless film is still dropped from the normal view");
    assert.equal(E.movingData().dropped.length >= 1, true);
  });
});

test("CAS-1536 AC4: each row has the app's own Watch On + Never and Watched controls; taps write answer", async () => {
  const [m] = films(1);
  await withBatch({ films: [m], owned: [m] }, async ({ writes }) => {
    await E.openBatchView(BATCH, null);
    const html = E.batchControlsHTML({ m });
    const labels = [...html.matchAll(/<span class="cl">([^<]*)<\/span>/g)].map(x => x[1]);
    const tracked = E.WATCH_LEVEL_KEYS.filter(E.windowEnabled).map(k => E.WATCH_LEVEL_SHORT_LABEL[k]);
    assert.deepEqual(labels, [...tracked, "Never", ...E.WATCH_STEPS.map(s => s.lbl)]);
    assert.ok(!labels.includes("Will never"), "no new wording: Never, as the Watch On label");
    // Only the tracked windows are drawn.
    E.WATCH_LEVEL_KEYS.filter(k => !E.windowEnabled(k)).forEach(k => assert.ok(!labels.includes(E.WATCH_LEVEL_SHORT_LABEL[k])));
    // Spent levels are greyed and inert exactly as on the card.
    const spent = E.watchLevelsFor(m.tmdb_id).filter(l => l.spent && E.windowEnabled(l.key));
    spent.forEach(l => assert.match(html, new RegExp(`cseg[^"]* spent" data-key="${l.key}"[^>]*disabled`)));

    // The alert-ledger write: a Watched tap, then a Watch On tap, then Never — last tap wins, with answered_at.
    E.setAlertBatches([{ id: BATCH, sydney_date: E.sydneyYMD(Date.now()), headline: "h", films: [{ movie_id: m.tmdb_id, answer: null }] }]);
    await E.openBatchView(BATCH, null);
    E.setOpinion(m.tmdb_id, "wow");
    assert.deepEqual(writes.at(-1).key, "wow");
    assert.equal(writes.at(-1).movieId, m.tmdb_id);
    assert.equal(JSON.stringify([...writes.at(-1).ids]), JSON.stringify([BATCH]));
    assert.ok(!isNaN(Date.parse(writes.at(-1).at)), "answered_at is a timestamp");
    const open = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent && E.windowEnabled(l.key));
    if(open){
      E.toggleFilmOpt(m.tmdb_id, open.key);
      assert.equal(writes.at(-1).key, open.key, "a later tap overwrites");
    }
    E.pickNever(m.tmdb_id);
    assert.equal(writes.at(-1).key, "never");
    assert.equal(writes.filter(w => w.key === "notfor").length, 0, "setOpinion's internal notfor is not a separate answer");
    assert.equal(E.movingBatch.rows[0].answer, "never");
    assert.ok(E.movingBatch.rows[0].answered_at);
  });
});

test("CAS-1536 AC4: a film outside every emailed batch writes nothing", async () => {
  const [m, other] = films(2);
  await withBatch({ films: [m], owned: [m] }, async ({ writes }) => {
    E.setAlertBatches([{ id: BATCH, sydney_date: E.sydneyYMD(Date.now()), headline: "h", films: [{ movie_id: m.tmdb_id, answer: null }] }]);
    E.setOpinion(other.tmdb_id, "wow");
    assert.equal(writes.length, 0);
  });
});

test("CAS-1536 AC4: the answer keys written are exactly the app's own button keys", () => {
  const appKeys = [...E.WATCH_LEVEL_KEYS, "never", ...E.WATCH_STEPS.map(s => s.key)];
  assert.deepEqual([...E.BATCH_ANSWER_KEYS].sort(), appKeys.sort());
});

test("CAS-1536 AC5: To decide shows while a film is undecided, drops on an answer / watched, ignores >30 days; badge = films left", async () => {
  const [a, b, c, d] = films(4);
  await withBatch({ films: [a, b], owned: [a, b] }, async () => {
    const today = E.sydneyYMD(Date.now());
    const old = E.sydneyYMD(Date.now() - 45 * 864e5);
    E.setAlertBatches([
      { id: BATCH, sydney_date: today, headline: "Max found 2 films", films: [{ movie_id: a.tmdb_id, answer: null }, { movie_id: b.tmdb_id, answer: null }] },
      { id: "99999999-2222-4333-8444-555555555555", sydney_date: old, headline: "ancient", films: [{ movie_id: c.tmdb_id, answer: null }] },
    ]);
    assert.equal(E.toDecideBatches().length, 1, "a batch older than 30 days never shows");
    assert.equal(E.toDecideBatches()[0].left, 2);
    assert.match(E.toDecideHTML(), /To decide/);
    assert.match(E.toDecideHTML(), /2 left/);
    E.updateMovingBadge();
    assert.equal(E.toDecideCount(), 2, "the badge counts films still to decide");
    // An answer (app or email) decides one film...
    E.alertBatches[0].films[0].answer = "stream";
    assert.equal(E.toDecideBatches()[0].left, 1);
    assert.equal(E.toDecideCount(), 1);
    // ...and marking the other watched anywhere decides it too: the row goes.
    E.watched.add(b.tmdb_id);
    assert.equal(E.toDecideBatches().length, 0);
    assert.equal(E.toDecideHTML(), "");
    assert.equal(E.toDecideCount(), 0);
  });
});

test("CAS-1536 AC5: several open batches give one row each, newest first; guests get none", async () => {
  const [a, b] = films(2);
  await withBatch({ films: [a], owned: [a] }, async () => {
    const d1 = E.sydneyYMD(Date.now() - 2 * 864e5), d2 = E.sydneyYMD(Date.now() - 864e5);
    E.setAlertBatches([
      { id: "aaaaaaaa-2222-4333-8444-555555555555", sydney_date: d1, headline: "older", films: [{ movie_id: a.tmdb_id, answer: null }] },
      { id: "bbbbbbbb-2222-4333-8444-555555555555", sydney_date: d2, headline: "newer", films: [{ movie_id: b.tmdb_id, answer: null }] },
    ]);
    assert.equal(JSON.stringify([...E.toDecideBatches().map(x => x.batch.headline)]), JSON.stringify(["newer", "older"]));
    E.localStorage.removeItem("cascade_had_account");
    assert.equal(E.toDecideBatches().length, 0, "signed out / guest: no To decide");
  });
});

test("CAS-1536 AC6: a push payload carrying a batch opens the batch view (same pending/apply path)", async () => {
  const fs = films(3);
  await withBatch({ films: fs, owned: fs }, async () => {
    // The push listener turns {open:"alerts", batch} into this exact pending value and applies it.
    const tap = E.parseBatchLink("alerts:batch:" + BATCH, fs[1].tmdb_id);
    E.setPendingBatch(tap);
    await E.applyPendingBatch();
    assert.equal(E.movingBatch.id, BATCH);
    assert.equal(E.movingBatch.film, fs[1].tmdb_id);
    assert.match(body.html, /From your email/);
    // A malformed batch in the payload is ignored entirely.
    assert.equal(E.parseBatchLink("alerts:batch:" + "not-a-uuid", null), null);
  });
});

test("CAS-1536: the band date is the batch's own Sydney date, weekday + day + short month", () => {
  assert.equal(E.batchDateLabel("2026-11-22"), "Sun 22 Nov");
  assert.equal(E.batchDateLabel("2026-01-05"), "Mon 5 Jan");
  assert.equal(E.batchDateLabel("garbage"), "");
});
