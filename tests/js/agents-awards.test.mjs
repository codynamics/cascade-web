// CAS-780: matchesCriteria's Awards rung (selAwards) explicitly waives pre-release films — correct for the
// WATCH question (a stream radar must keep tracking an in-cinema film so it can alert when it lands) and
// wrong for the SHOW question (a listed card claims the film meets the agent's standard TODAY). These tests
// drive listedBy/watchesFilm directly against a synthetic film, isolating the Awards rung from the unrelated
// Cascade-score floor via listedBy's own ignoreScoreGate escape hatch (the same trick scoreHeldBackCount
// already uses) — watchesFilm carries no such escape hatch, so its film is instead given a real buzz figure
// it comfortably clears, exercising the actual score gate rather than dodging it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Cinema/Rental/Streaming usable, all markers at TRACK_MIN — the lowest real score the track allows
// (agentFloor reads the minimum of the ENABLED windows' markers; Premium stays off/null exactly like the
// real default). CAS-1128 retires CAS-762's "a marker of 0 is Off, no score requirement" reading for the
// Cascade score control — normCascade now migrates any literal 0 up to TRACK_MIN — so this agent carries an
// ordinary 50+ requirement, same as any other agent; UPCOMING_NO_AWARD's own buzz figure below is chosen to
// clear it easily, keeping this suite's isolation of the Awards rung intact.
const OPEN_MARKERS = { in_cinema: 50, premium: null, rent: 50, stream: 50 };

function awardsAgent(selAwards){
  return E.normCascade({ kind: "stream", status: [], selAwards, watchMarkers: { ...OPEN_MARKERS } });
}

// The CAS-780 Observation film, shaped like Practical Magic 2: upcoming, no awards record at all, and no
// IMDb/Metacritic/RT figure either — wm_popularity_percentile (the field cascadeScore's upcoming branch
// actually reads, via wmCinemaScore/wmBuzzPctlOf) is the only signal a pre-release film can carry, set high
// enough here to clear OPEN_MARKERS' own TRACK_MIN floor regardless of the fixture catalogue's own spread.
const UPCOMING_NO_AWARD = {
  tmdb_id: 780001, title: "CAS-780 upcoming, no awards",
  status: ["upcoming"], award: null, award_text: null,
  language: "en", popularity: 42, wm_popularity_percentile: 90,
};

// A released film with a qualifying awardRank — a real nomination, no Oscar wording, so parseAwards has
// nothing to read and awardRank falls back to its "nominated, no count" floor of 1 (see awardRank's own
// Math.max(...,1) clause), which clears an agent's selAwards:1 stop (rank 1).
const RELEASED_QUALIFIES = {
  tmdb_id: 780002, title: "CAS-780 released, nominated",
  status: ["included_streaming"], award: "nominated", award_text: null,
  offers: [{ provider: "Test" }], language: "en", popularity: 10,
};

test("CAS-780 AC1: an upcoming film with no awards is rejected by listedBy but still watched", () => {
  const c = awardsAgent(1);
  assert.equal(E.listedBy(UPCOMING_NO_AWARD, c, true), false,
    "an award-less, pre-release film must not be LISTED by an Awards-gated agent — a listed card claims " +
    "the film meets the standard today, and this one has no award at all");
  assert.equal(E.watchesFilm(UPCOMING_NO_AWARD, c), true,
    "the same film must still be WATCHED — matchesCriteria's pre-release waiver on selAwards must survive " +
    "unchanged, so a stream radar keeps tracking it and can alert once it actually lands");
});

test("CAS-780 AC2: a released film with a qualifying awardRank is still listed", () => {
  const c = awardsAgent(1);
  assert.equal(E.listedBy(RELEASED_QUALIFIES, c, true), true,
    "a released, nominated film must clear the Awards rung and list normally — this ticket only closes the " +
    "pre-release gap, it must not narrow the released case");
});

test("CAS-780 AC3: the prestige preset is scoped to the stream lane's own windows, not wide open", () => {
  const prestige = E.STARTERS.find(s => s.key === "prestige");
  assert.ok(prestige, "the prestige preset must still exist under that key");
  assert.ok(prestige.crit.status.length > 0,
    "prestige's crit.status was [] — nothing scoped it to streaming windows, so \"Streaming\" was only " +
    "in the preset's name, not its criteria");
  for(const w of prestige.crit.status){
    assert.ok(E.HOME_KEYS.includes(w), `prestige's crit.status carries ${w}, which is not one of the stream lane's own windows`);
  }
});
