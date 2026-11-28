// CAS-1553: the agent-behaviour suite for the one-agent (v2) model. Run on request via `npm run test:agents`,
// never as part of `npm run qa` — see QA-AGENTS.md. It replaces CAS-789/790/791's checks A to L, which tested
// only the retired multi-agent engine (ownership between agents, per-agent markers, moving films between
// agents). Every check here drives the SHIPPED engine out of the built index.html (tests/js/engine.mjs), the
// same harness `npm run test:engine` uses, against a v2 criteria object (`v:2`) — never a re-implementation of
// the engine's rules. Fixture films are synthetic and carry an exact public score, so a check never depends on
// what today's catalogue happens to hold.
//
// Check ids (the text before the first colon in each test name) are what qa-agents-report.txt lists. A check that
// is known to fail must carry its bug ticket key in its name (e.g. "ADM-9 (CAS-1234): ...").
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- fixtures ------------------------------------------------------------------------------------------------
// The engine runs in its own vm realm, so its arrays fail strict deepEqual against ours on prototype alone; compare as JSON.
const deq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
function ratingForScore(target){
  let lo = 0, hi = 100;
  for(let i = 0; i < 60; i++){ const mid = (lo + hi) / 2; if(Math.round(E.wmScaled(mid)) < target) lo = mid; else hi = mid; }
  let v = hi;
  for(let i = 0; i < 2000 && Math.round(E.wmScaled((v/10)*10)) !== target; i++) v += 0.01;
  return v / 10;
}
const SVC = "Amazon Prime Video";
const OTHER_SVC = "Disney+";
let _id = 95530001;
// A film whose public score is exactly `score`. `over` may change stage/offers/people/age.
function film(genres, score, over){
  const id = _id++;
  const m = { tmdb_id:id, title:`CAS-1553 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true, availability_confidence:"confirmed",
    offers:[{service:SVC, type:"sub", price:null, format:null}], ...(over || {}) };
  if(E.cascadeScore(m) !== score) throw new Error(`test setup: fixture ${id} scored ${E.cascadeScore(m)}, wanted ${score}`);
  return m;
}
const RENT = { status:["rental"], offers:[{service:"Apple TV", type:"rent", price:5, format:"HD"}] };
const CINEMA = { status:["in_cinema"], offers:[], cinema_release:true, cinema_date:"2026-11-10" };
const noAl = () => ({cinema:false, rent:false, stream:false});
// A v2 agent: `styles` maps main genre -> bar (or a full {bar, al} object).
function agent(styles, extra){
  const s = {};
  Object.entries(styles).forEach(([g, v]) => { s[g] = typeof v === "number" ? {bar:v, al:noAl()} : v; });
  return { id:"cas1553", name:"A", v:2, combo:{}, seenAdj:{}, dismissed:[], styles:s, ...(extra || {}) };
}
const VERDICT_SETS = ["watched","disliked","indifferent","wowed","enjoyed","blocked"];
function withWorld(films, fn){
  const savedV = {}; VERDICT_SETS.forEach(k => { savedV[k] = new Set(E[k]); E[k].clear(); });
  const savedCascades = [...E.cascades];
  const savedSub = new Set(E.prefs.sub), savedStore = new Set(E.prefs.store), savedOn = E.prefs.on;
  films.forEach(m => E.MOVIES.push(m));
  E.invalidateComputeCaches();
  try{ return fn(); }
  finally{
    films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
    VERDICT_SETS.forEach(k => { E[k].clear(); savedV[k].forEach(id => E[k].add(id)); });
    E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
    E.prefs.sub.clear(); savedSub.forEach(s => E.prefs.sub.add(s));
    E.prefs.store.clear(); savedStore.forEach(s => E.prefs.store.add(s));
    E.prefs.on = savedOn;
    E.invalidateComputeCaches();
  }
}
function withAgent(c, fn){
  E.cascades.length = 0; E.cascades.push(c);
  return fn();
}
function mark(m, kind){
  E.watched.add(m.tmdb_id);
  if(kind === "disliked") E.disliked.add(m.tmdb_id);
  if(kind === "wow") E.wowed.add(m.tmdb_id);
  E.invalidateComputeCaches();
}
const dislikes = (genres, n) => Array.from({length:n}, () => film(genres, 50));
const admits = (m, c) => E.matchesCriteria(m, c, false, false);
// A mood record in the shape the real list code reads.
const mood = over => ({ ...E.oamMoodDefaultFields(), id:"t", name:"T", watched:true, ...(over || {}) });

// ---- 1. Admission --------------------------------------------------------------------------------------------
test("ADM-1: a film is in when its main genre is on and its one score meets that genre's bar", () => {
  const atBar = film(["Comedy"], 70), below = film(["Comedy"], 69), above = film(["Comedy"], 90);
  withWorld([atBar, below, above], () => {
    const c = agent({Comedy:70});
    withAgent(c, () => {
      assert.equal(E.oneScoreFor ? E.oneScoreFor(atBar, c) : E.oneScore(atBar, c), 70);
      assert.equal(admits(atBar, c), true, "score equal to the bar is in");
      assert.equal(admits(above, c), true);
      assert.equal(admits(below, c), false, "one point under the bar is out");
    });
  });
});

test("ADM-2: a film is out when its main genre is off (no entry for it in the agent)", () => {
  const m = film(["Horror"], 95);
  withWorld([m], () => {
    const c = agent({Comedy:60});
    withAgent(c, () => assert.equal(admits(m, c), false));
    const c2 = agent({Comedy:60, Horror:60});
    withAgent(c2, () => assert.equal(admits(m, c2), true, "switching the genre on admits it"));
  });
});

test("ADM-3: admission uses the film's MAIN genre only — a bar on a secondary genre does not admit it", () => {
  const m = film(["Drama","Comedy"], 95);
  withWorld([m], () => {
    const c = agent({Comedy:60});
    withAgent(c, () => assert.equal(admits(m, c), false));
  });
});

test("ADM-4: a combination set to never keeps a film out whatever its score", () => {
  const m = film(["Drama","Horror"], 95);
  withWorld([m], () => {
    const c = agent({Drama:60}, { combo:{"Drama|Horror":"never"} });
    withAgent(c, () => assert.equal(admits(m, c), false));
  });
});

test("ADM-5 (CAS-1479): sub-genre adjustments move the score only once applied (tasteApply), never before", () => {
  const verdicted = dislikes(["Science Fiction","Thriller"], 2);
  const probe = film(["Science Fiction","Thriller"], 87);
  withWorld([...verdicted, probe], () => {
    verdicted.forEach(m => mark(m, "disliked"));
    const c = agent({"Science Fiction":60});
    withAgent(c, () => {
      assert.equal(E.tasteSeedApplied(c), true);
      const key = "Science Fiction|Thriller";
      assert.equal(c.applied[key], E.oneComboAdj(key), "the day-one seed applies exactly what was learned");
      const s0 = E.oneScore(probe, c);
      // more dislikes: the LEARNED value moves, the APPLIED one (and so every score) must not
      const more = dislikes(["Science Fiction","Thriller"], 4);
      more.forEach(m => { E.MOVIES.push(m); mark(m, "disliked"); });
      assert.notEqual(E.oneComboAdj(key), c.applied[key], "learning moved on");
      assert.equal(E.oneScore(probe, c), s0, "a verdict alone moves no score");
      assert.equal(E.tasteRecs().length, 1);
      E.tasteApply("Science Fiction");
      assert.equal(c.applied[key], E.oneComboAdj(key));
      assert.notEqual(E.oneScore(probe, c), s0, "applying moves the score");
      more.forEach(m => E.MOVIES.splice(E.MOVIES.indexOf(m), 1));
    });
  });
});

test("ADM-6: a film that is Watched or marked Not for me is out of admission", () => {
  const w = film(["Comedy"], 90), b = film(["Comedy"], 90), ok = film(["Comedy"], 90);
  withWorld([w, b, ok], () => {
    const c = agent({Comedy:60});
    withAgent(c, () => {
      E.watched.add(w.tmdb_id); E.blocked.add(b.tmdb_id);
      assert.equal(admits(w, c), false, "watched");
      assert.equal(admits(b, c), false, "not for me");
      assert.equal(admits(ok, c), true);
    });
  });
});

// ---- 2. Stages and Watch On ----------------------------------------------------------------------------------
test("STG-1: a film is listed under the stage it is in now, and only that one", () => {
  const cin = film(["Comedy"], 80, CINEMA), rent = film(["Comedy"], 80, RENT), stream = film(["Comedy"], 80);
  withWorld([cin, rent, stream], () => {
    const tabs = ["in_cinema","premium","rent","stream"];
    const where = m => tabs.filter(t => E.filmMatchesWatchTab(m, t));
    deq(where(cin), ["in_cinema"]);
    deq(where(rent), ["rent"]);
    deq(where(stream), ["stream"]);
  });
});

test("STG-2: Watch On changes the card label, not the stage (Lee, 22 Oct)", () => {
  const m = film(["Comedy"], 80, RENT);
  withWorld([m], () => {
    const stageBefore = E.primaryStatus(m);
    const tabsBefore = ["in_cinema","premium","rent","stream"].filter(t => E.filmMatchesWatchTab(m, t));
    const id = m.tmdb_id;
    const savedNotify = E.notify[id];
    try{
      E.notify[id] = { wins:{ stream:true }, winsSource:{ stream:"manual" } };
      assert.equal(E.primaryStatus(m), stageBefore, "Watch On Streaming did not move a rental film's stage");
      deq(["in_cinema","premium","rent","stream"].filter(t => E.filmMatchesWatchTab(m, t)), tabsBefore,
        "nor which tab lists it");
      assert.ok(E.notifyChipHTML(id).length > 0);
      const st = E.filmNotifyState(id);
      assert.equal(st.on, 1, "the card's Watch On state now carries the pick");
      assert.equal(st.key, "stream");
    } finally {
      if(savedNotify === undefined) delete E.notify[id]; else E.notify[id] = savedNotify;
    }
  });
});

test("STG-3: a film's stage follows its availability — an offer appearing moves it to the next stage's tab", () => {
  const m = film(["Comedy"], 80, CINEMA);
  withWorld([m], () => {
    assert.equal(E.filmMatchesWatchTab(m, "in_cinema"), true);
    m.status = ["rental"]; m.offers = RENT.offers; m.cinema_release = false;
    E.rederiveStatuses && E.rederiveStatuses();
    E.invalidateComputeCaches();
    assert.equal(E.filmMatchesWatchTab(m, "rent"), true);
    assert.equal(E.filmMatchesWatchTab(m, "in_cinema"), false);
  });
});

// ---- 3. Alerts -----------------------------------------------------------------------------------------------
// A film alerts when the one agent has the alert on for its MAIN genre and window (styles[].al) AND the film is
// admitted for this member (services, watched, not-for-me all live in admission).
const alerts = (m, c, win) => withAgent(c, () => E.oneAgentAlerts(m, win) && admits(m, c));

test("ALR-1: a film alerts only for a genre whose alert is on for that window", () => {
  const m = film(["Comedy"], 90), d = film(["Drama"], 90);
  withWorld([m, d], () => {
    const c = agent({ Comedy:{bar:60, al:{cinema:false, rent:true, stream:true}}, Drama:{bar:60, al:noAl()} });
    assert.equal(alerts(m, c, "stream"), true);
    assert.equal(alerts(m, c, "rent"), true);
    assert.equal(alerts(m, c, "cinema"), false, "that window's alert is off for Comedy");
    for(const w of ["cinema","rent","stream"]) assert.equal(alerts(d, c, w), false, `Drama has every alert off (${w})`);
  });
});

test("ALR-2: a film alerts only on the member's services", () => {
  // _fixture:true films skip the services scope entirely (matchesServices, CAS-491), so this one test must not carry it.
  const mine = film(["Comedy"], 90, { _fixture:false }), notMine = film(["Comedy"], 90, { _fixture:false, offers:[{service:OTHER_SVC, type:"sub", price:null, format:null}] });
  withWorld([mine, notMine], () => {
    const c = agent({ Comedy:{bar:60, al:{cinema:false, rent:false, stream:true}} });
    E.prefs.sub.clear(); E.prefs.sub.add(E.svcCanon(SVC)); E.prefs.on = true;
    assert.equal(alerts(mine, c, "stream"), true);
    assert.equal(alerts(notMine, c, "stream"), false, "a service the member does not have never alerts");
  });
});

test("ALR-3: a film never alerts once Watched or marked Not for me", () => {
  const w = film(["Comedy"], 90), b = film(["Comedy"], 90), ok = film(["Comedy"], 90);
  withWorld([w, b, ok], () => {
    const c = agent({ Comedy:{bar:60, al:{cinema:true, rent:true, stream:true}} });
    assert.equal(alerts(w, c, "stream"), true, "before");
    E.watched.add(w.tmdb_id); E.blocked.add(b.tmdb_id);
    assert.equal(alerts(w, c, "stream"), false, "Watched");
    assert.equal(alerts(b, c, "stream"), false, "Not for me");
    assert.equal(alerts(ok, c, "stream"), true, "an untouched film still alerts");
  });
});

test("ALR-4: a film below its genre's bar does not alert even with the alert on", () => {
  const m = film(["Comedy"], 50);
  withWorld([m], () => {
    const c = agent({ Comedy:{bar:70, al:{cinema:true, rent:true, stream:true}} });
    assert.equal(alerts(m, c, "stream"), false);
  });
});

// ---- 4. Verdicts and learning --------------------------------------------------------------------------------
test("VRD-1: two verdicts on a sub-genre produce a recommendation (tasteRecs); one does not", () => {
  const first = film(["Science Fiction","Thriller"], 50), second = film(["Science Fiction","Thriller"], 50);
  withWorld([first, second], () => {
    const c = agent({"Science Fiction":60});
    withAgent(c, () => {
      E.tasteSeedApplied(c);                        // nothing learned yet: seed applies nothing, flag set
      assert.equal(E.tasteRecs().length, 0);
      mark(first, "disliked");
      assert.equal(E.tasteRecs().length, 0, "one verdict is not enough to propose");
      mark(second, "disliked");
      const recs = E.tasteRecs();
      assert.equal(recs.length, 1);
      assert.equal(recs[0].style, "Science Fiction");
      assert.equal(recs[0].keys[0].key, "Science Fiction|Thriller");
      assert.ok(recs[0].keys[0].to < recs[0].keys[0].from, "two dislikes recommend marking the pairing down");
    });
  });
});

test("VRD-2: Skip holds until the learned value moves by 2", () => {
  const seed = dislikes(["Science Fiction","Thriller"], 2);
  withWorld(seed, () => {
    seed.forEach(m => mark(m, "disliked"));
    const c = agent({"Science Fiction":60});
    withAgent(c, () => {
      E.tasteSeedApplied(c);
      const key = "Science Fiction|Thriller";
      const more = dislikes(["Science Fiction","Thriller"], 4);
      more.forEach(m => { E.MOVIES.push(m); mark(m, "disliked"); });
      assert.equal(E.tasteRecs().length, 1);
      const skippedAt = E.oneComboAdj(key);
      E.tasteSkip("Science Fiction");
      assert.equal(c.skipped[key], skippedAt);
      assert.equal(E.tasteRecs().length, 0, "skipped: the recommendation clears");
      // a verdict that moves the learned value by less than 2 leaves it skipped
      const nudge = film(["Science Fiction","Thriller"], 50);
      E.MOVIES.push(nudge); mark(nudge, "disliked");
      if(Math.abs(E.oneComboAdj(key) - skippedAt) < 2) assert.equal(E.tasteRecs().length, 0, "moved by <2: still held");
      // enough opposite verdicts move it by 2 or more: it comes back
      const lifts = dislikes(["Science Fiction","Thriller"], 8);
      lifts.forEach(m => { E.MOVIES.push(m); mark(m, "wow"); });
      assert.ok(Math.abs(E.oneComboAdj(key) - skippedAt) >= 2, "setup: the learned value moved by 2 or more");
      assert.equal(E.tasteRecs().length, 1, "moved by 2+: pending again");
      [...more, nudge, ...lifts].forEach(m => E.MOVIES.splice(E.MOVIES.indexOf(m), 1));
    });
  });
});

test("VRD-3: Apply writes the learned value and clears the recommendation", () => {
  const seed = dislikes(["Science Fiction","Thriller"], 2);
  withWorld(seed, () => {
    seed.forEach(m => mark(m, "disliked"));
    const c = agent({"Science Fiction":60}, { appliedSeeded:true, applied:{} });
    withAgent(c, () => {
      const key = "Science Fiction|Thriller";
      assert.equal(E.tasteRecs().length, 1, "applied 0 vs learned < 0 is a pending recommendation");
      E.tasteApply("Science Fiction");
      assert.equal(c.applied[key], E.oneComboAdj(key));
      assert.equal(E.tasteRecs().length, 0);
    });
  });
});

test("VRD-4: a pairing the person overrode is never recommended", () => {
  const seed = dislikes(["Science Fiction","Thriller"], 3);
  withWorld(seed, () => {
    seed.forEach(m => mark(m, "disliked"));
    const c = agent({"Science Fiction":60}, { appliedSeeded:true, applied:{}, combo:{"Science Fiction|Thriller": -3} });
    withAgent(c, () => assert.equal(E.tasteRecs().length, 0));
  });
});

// ---- 5. Lists ------------------------------------------------------------------------------------------------
test("LST-1: Latest and Best is pinned first, and a new account's lists open on it", () => {
  const list = E.oneAgentStarterMoods({}, ["M"]);
  assert.equal(list[0].id, "releases");
  assert.equal(list[0].name, "Cinema releases");
  assert.equal(list[0].show, "40", "Best 40 per stage");
  assert.equal(E.ONE_AGENT_MOOD_BUILTINS[0].id, "releases");
});

test("LST-2: Best N is a hard maximum of N films in each stage, taken by score", () => {
  const streams = Array.from({length:25}, (_, i) => film(["Comedy"], 60 + (i % 30)));
  const rents = Array.from({length:25}, (_, i) => film(["Comedy"], 60 + (i % 30), RENT));
  withWorld([...streams, ...rents], () => {
    const c = agent({Comedy:60});
    const m20 = mood({ show:"20" });
    const cutS = E.oamApplyShowCap(streams, m20, c, new Set());
    const cutR = E.oamApplyShowCap(rents, m20, c, new Set());
    assert.equal(cutS.length, 20, "streaming stage capped at 20");
    assert.equal(cutR.length, 20, "rental stage capped at 20, independently");
    const kept = new Set(cutS.map(m => m.tmdb_id));
    const worstKept = Math.min(...cutS.map(m => E.oneScore(m, c)));
    streams.filter(m => !kept.has(m.tmdb_id)).forEach(m =>
      assert.ok(E.oneScore(m, c) <= worstKept, "every film cut scores no higher than the lowest film kept"));
    assert.equal(E.oamApplyShowCap(streams, mood({ show:"all" }), c, new Set()).length, 25, "All keeps every film");
  });
});

test("LST-3: a genre list shows only its genres", () => {
  // CAS-1695: a list admits at the genre's top-25% bar (CAS-1690), which tracks the catalogue (Drama is 83 today), so the
  // fixtures score 95 to clear it whatever the catalogue holds; this check is about genre selection, not the bar.
  const com = film(["Comedy"], 95), dra = film(["Drama"], 95), hor = film(["Horror"], 95);
  withWorld([com, dra, hor], () => {
    const c = agent({Comedy:60, Drama:60, Horror:60});
    withAgent(c, () => {
      const comedyOnly = mood({ styles:["Comedy"] }), two = mood({ styles:["Comedy","Drama"] }), all = mood({ styles:[] });
      const inList = (m, md) => E.filmInOneAgentMood(m, md, c);
      deq([com, dra, hor].map(m => inList(m, comedyOnly)), [true, false, false]);
      deq([com, dra, hor].map(m => inList(m, two)), [true, true, false]);
      deq([com, dra, hor].map(m => inList(m, all)), [true, true, true], "no ticks = every genre the agent has on");
    });
  });
});

test("LST-4: a name list shows every film of that person regardless of the agent (Lee, 8 Nov)", () => {
  const off = film(["Horror"], 95, { cast:["Zed Quillfeather"] });                 // genre not on in the agent
  const low = film(["Comedy"], 20, { cast:["Zed Quillfeather"] });                 // far below the bar
  const dir = film(["Comedy"], 90, { director:"Zed Quillfeather" });
  const other = film(["Comedy"], 90, { cast:["Someone Else"] });
  withWorld([off, low, dir, other], () => {
    const c = agent({Comedy:70});
    withAgent(c, () => {
      const md = mood({ people:"Zed Quillfeather", mode:"keyword" });
      assert.equal(E.filmInOneAgentMood(off, md, c), true, "genre off in the agent");
      assert.equal(E.filmInOneAgentMood(low, md, c), true, "score below the bar");
      assert.equal(E.filmInOneAgentMood(dir, md, c), true, "director matches too");
      assert.equal(E.filmInOneAgentMood(other, md, c), false, "a film without that person is not listed");
    });
  });
});

test("LST-5: a name list still honours Watched and Not for me", () => {
  const w = film(["Comedy"], 90, { cast:["Zed Quillfeather"] }), b = film(["Comedy"], 90, { cast:["Zed Quillfeather"] });
  withWorld([w, b], () => {
    const c = agent({Comedy:70});
    withAgent(c, () => {
      E.watched.add(w.tmdb_id); E.blocked.add(b.tmdb_id);
      const md = mood({ people:"Zed Quillfeather", mode:"keyword", watched:false });
      assert.equal(E.filmInOneAgentMood(w, md, c), false, "Include watched is off");
      assert.equal(E.filmInOneAgentMood(b, md, c), false, "Not for me stays out");
      assert.equal(E.filmInOneAgentMood(w, mood({ people:"Zed Quillfeather", mode:"keyword", watched:true }), c), true,
        "Include watched on lists the watched film");
    });
  });
});

test("LST-6: hand add and take out win over the rules", () => {
  const low = film(["Comedy"], 20), high = film(["Comedy"], 95), offGenre = film(["Horror"], 95);
  withWorld([low, high, offGenre], () => {
    const c = agent({Comedy:70});
    withAgent(c, () => {
      const base = mood({});
      assert.equal(E.filmInOneAgentMood(low, base, c), false);
      assert.equal(E.filmInOneAgentMood(high, base, c), true);
      assert.equal(E.filmInOneAgentMood(low, mood({ in:[low.tmdb_id] }), c), true, "hand add beats a score below the bar");
      assert.equal(E.filmInOneAgentMood(offGenre, mood({ in:[offGenre.tmdb_id] }), c), true, "hand add beats a genre that is off");
      assert.equal(E.filmInOneAgentMood(high, mood({ out:[high.tmdb_id] }), c), false, "take out beats a qualifying film");
      assert.equal(E.filmInOneAgentMood(high, mood({ in:[high.tmdb_id], out:[high.tmdb_id] }), c), false, "take out outranks add");
      assert.equal(E.filmInOneAgentMood(high, mood({ handOnly:true }), c), false, "a hand-only list ignores the rules");
      assert.equal(E.filmInOneAgentMood(low, mood({ handOnly:true, in:[low.tmdb_id] }), c), true);
    });
  });
});

test("LST-7: a hand-added film is kept by the Best N cut even when it would not rank", () => {
  const rows = Array.from({length:30}, (_, i) => film(["Comedy"], 70 + (i % 25)));
  const lowest = rows.reduce((a, b) => E.cascadeScore(a) <= E.cascadeScore(b) ? a : b);
  withWorld(rows, () => {
    const c = agent({Comedy:60});
    const md = mood({ show:"20", in:[lowest.tmdb_id] });
    const kept = E.oamApplyShowCap(rows, md, c, new Set());
    assert.equal(kept.length, 20);
    assert.ok(kept.includes(lowest), "the hand-added film holds a slot");
  });
});

// ---- 6. Starter lists ----------------------------------------------------------------------------------------
test("STR-1 (CAS-1528): starter lists follow the first-run answers, in the order the first run asks", () => {
  const all = E.oneAgentStarterMoods({ partner:true, kids:true, topSvc:"nfx", person:"Christopher Nolan",
    dateStyles:["Romance"], familyStyles:["Family"] }, ["M"]);
  deq(all.map(m => m.id), ["releases","me","topsvc","fav-person","date","family"]);
  deq(E.oneAgentStarterMoods({}, ["M"]).map(m => m.id), ["releases","me"], "no answers: just the two defaults");
  deq(E.oneAgentStarterMoods({ partner:true }, ["M"]).map(m => m.id), ["releases","me","date"]);
  deq(E.oneAgentStarterMoods({ kids:true }, ["M"]).map(m => m.id), ["releases","me","family"]);
});

test("STR-2: the Partner and Family lists carry the genres picked, and Family is limited to family ratings", () => {
  const list = E.oneAgentStarterMoods({ partner:true, kids:true, dateStyles:["Romance","Drama"], familyStyles:["Family","Animation"] }, ["R 18+"]);
  const date = list.find(m => m.id === "date"), family = list.find(m => m.id === "family");
  deq(date.styles, ["Romance","Drama"]);
  deq(family.styles, ["Family","Animation"]);
  deq(family.ages, ["G","PG","M"]);
  deq(date.ages, ["R 18+"], "other lists carry the member's own age band");
  assert.ok(list.every(m => m.watched === true), "starter lists include watched films");
});

test("STR-3: the favourite person and top service lists are named for the answer and filter on it", () => {
  const list = E.oneAgentStarterMoods({ topSvc:"nfx", person:"Christopher Nolan" }, ["M"]);
  const person = list.find(m => m.id === "fav-person"), svc = list.find(m => m.id === "topsvc");
  assert.equal(person.name, "Christopher Nolan");
  assert.equal(person.people, "Christopher Nolan");
  assert.equal(svc.svc, "nfx");
});

// ---- Python half agreement -----------------------------------------------------------------------------------
test("SHM-1: the monitor's admission shim agrees with the app for a v2 agent on 20 sample films", () => {
  // A mix of scores/genres straddling the bars, one blocked and one watched film, so agreement is not trivially
  // "everything in" or "everything out".
  const genres = [["Comedy"],["Drama","Thriller"],["Horror"],["Action","Crime"],["Comedy","Romance"]];
  const films = Array.from({length:20}, (_, i) => film(genres[i % genres.length], 40 + ((i * 7) % 55)));
  withWorld(films, () => {
    const c = agent({ Comedy:60, Drama:70, Action:50 });
    const watchedFilm = films[3], blockedFilm = films[8];
    E.watched.add(watchedFilm.tmdb_id); E.blocked.add(blockedFilm.tmdb_id);
    const inApp = films.filter(m => admits(m, c) && E.awardsListOK(m, c)).map(m => String(m.tmdb_id)).sort();
    const req = {
      users:[{ userId:"u1", langs:null, subServices:[], storeServices:[], servicesOnly:false,
        filmStatuses:[{ movie_id:String(watchedFilm.tmdb_id), status:"liked" }, { movie_id:String(blockedFilm.tmdb_id), status:"notfor" }],
        agents:[{ id:c.id, criteria:JSON.parse(JSON.stringify(c)) }] }],
      catalogues:{ today: films },
    };
    const proc = spawnSync(process.execPath, ["monitor/admit_shim.mjs"], { cwd: REPO_ROOT, input: JSON.stringify(req), encoding:"utf8" });
    assert.equal(proc.status, 0, `shim exited ${proc.status}: ${proc.stderr}`);
    const inShim = JSON.parse(proc.stdout)[c.id].today.slice().sort();
    assert.ok(inApp.length > 0 && inApp.length < films.length, "setup: the sample splits into in and out");
    deq(inShim, inApp);
  });
});

test("CAS-1701: onboarding picks drive Me (mirrored, Best 80) and Cinema releases (1 yr back)", () => {
  const list = E.oneAgentStarterMoods({ picks:{ Action:"fav", Drama:"incl" } }, ["M"]);
  const me = list.find(m => m.id === "me");
  assert.deepEqual(me.styles, ["Action","Drama"]);
  assert.deepEqual(me.favs, ["Action"]);
  assert.equal(me.show, "80");
  assert.equal(list[0].years, 1);
  assert.equal(E.oneAgentStarterMoods({}, ["M"])[0].years, 0, "repair path without picks is untouched");
});
