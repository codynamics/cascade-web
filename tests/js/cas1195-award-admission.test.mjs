// CAS-1195: the alert engine's admission for an agent (monitor/admit_shim.mjs's admittedIds) is now
// matchesCriteria AND awardsListOK — the listing's own rule (listedBy) — not matchesCriteria alone, which
// waives the Awards requirement for a pre-release film (CAS-780, correct for WATCHES, wrong for "would the
// listing show this"). These tests drive the two engine functions admittedIds combines directly, since
// admit_shim.mjs itself is a stdin/stdout subprocess entrypoint, not an importable module.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Admission combines matchesCriteria(m,c,false,false) && awardsListOK(m,c) — mirrors admittedIds exactly.
const admits = (m, c) => E.matchesCriteria(m, c, false, false) && E.awardsListOK(m, c);

const OPEN_MARKERS = { in_cinema: 50, premium: null, rent: 50, stream: 50 };

// selAwards is a stream-lane Mission dial — laneCrit zeroes it for kind:"cinema" (app_template.html's own
// rule, mirrored by agents-awards.test.mjs), so the fixture agent has to be kind:"stream" even though the
// ticket's own observation ("Awards set to Winner... cinema release") is about a stream-lane agent whose
// windows happen to include cinema release.
function awardsAgent(selAwards){
  return E.normCascade({ kind: "stream", status: [], selAwards, watchMarkers: { ...OPEN_MARKERS } });
}

// Shaped like the ticket's "Nominees & Awards" observation: upcoming, no award, no rating signal at all —
// wm_popularity_percentile is the only score an unreleased film can carry, set high enough to clear
// OPEN_MARKERS' TRACK_MIN floor regardless of catalogue spread.
const UPCOMING_NO_AWARD = {
  tmdb_id: 1195001, title: "CAS-1195 upcoming, no award",
  status: ["upcoming"], award: null, award_text: null,
  language: "en", popularity: 42, wm_popularity_percentile: 90,
};
const UPCOMING_WON = { ...UPCOMING_NO_AWARD, tmdb_id: 1195002, award: "won" };

const STREAMING_NO_AWARD = {
  tmdb_id: 1195003, title: "CAS-1195 streaming, no award",
  status: ["included_streaming"], award: null, award_text: null,
  offers: [{ provider: "Test" }], language: "en", popularity: 10,
  wm_critic_score: 70, wm_user_rating: 7.5,
};
const STREAMING_WON = { ...STREAMING_NO_AWARD, tmdb_id: 1195004, award: "won" };

test("CAS-1195 AC1: an Awards:Winner agent does not admit an upcoming film with no award", () => {
  const c = awardsAgent(4); // 4 = AWARD_STOPS' "Winner" index
  assert.equal(admits(UPCOMING_NO_AWARD, c), false,
    "the alert engine must not admit a pre-release film an Awards agent would never list");
});

test("CAS-1195 AC2: the same agent admits the same film once it has won", () => {
  const c = awardsAgent(4);
  assert.equal(admits(UPCOMING_WON, c), true);
});

test("CAS-1195 AC3: a released film follows the same unawarded/awarded split", () => {
  const c = awardsAgent(4);
  assert.equal(admits(STREAMING_NO_AWARD, c), false);
  assert.equal(admits(STREAMING_WON, c), true);
});

test("CAS-1195 AC4: an agent with no Awards requirement admits the same set with or without the " +
     "awardsListOK check, across the repo's real movies.json", () => {
  const c = awardsAgent(0); // selAwards falsy -> awardsListOK(m,c) is unconditionally true
  let checked = 0;
  for(const m of E.MOVIES){
    const bare = E.matchesCriteria(m, c, false, false);
    assert.equal(admits(m, c), bare,
      `movie ${m.tmdb_id} disagreed: awardsListOK must be a no-op for an agent with no Awards requirement`);
    checked++;
  }
  assert.ok(checked > 1000, "expected the real catalogue, not an empty or stub one");
});
