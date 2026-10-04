// CAS-1191: an Upcoming film that already carries People or Critics ratings (e.g. from an overseas
// release) is scored the way an In Cinema film is — half buzz, half ratings — rather than on buzz alone
// just because it hasn't opened here yet. Fixtures only (never live catalogue titles/values — the real
// figures move with the daily catalogue, see the ticket's own measurement).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";
import { isScoreable } from "../../scripts/wm_scoreable_manifest.mjs";

const E = loadEngine();

// CAS-678: inLadderCohort only recognizes "upcoming"/"in_cinema" in the status array — a real
// opening_week film's own status is deliberately ["opening_week"] alone (deriveStatus never adds
// "in_cinema" alongside it), so it never carries a buzz figure in practice. A fixture that needs a
// real buzz figure for opening_week adds "in_cinema" to the array purely to exercise the shared blend
// formula in isolation; primaryStatus still reads "opening_week" first either way.
function cohortStatusFor(status){
  return status === "opening_week" ? [status, "in_cinema"] : [status];
}
// A fixture with a Watchmode buzz percentile high enough to clear every quantile-map bucket (100), and
// real wm_user_rating/wm_critic_score so wmQScore reads a real figure too.
function withBuzzAndRatings(status){
  return { status: cohortStatusFor(status), wm_popularity_percentile: 1e9, wm_user_rating: 8.0, wm_critic_score: 90 };
}
function withBuzzOnly(status){
  return { status: cohortStatusFor(status), wm_popularity_percentile: 1e9, wm_user_rating: null, wm_critic_score: null };
}
function withRatingsOnly(status){
  return { status: [status], wm_popularity_percentile: undefined, wm_user_rating: 8.0, wm_critic_score: 90 };
}
function withNeither(status){
  return { status: [status], wm_popularity_percentile: undefined, wm_user_rating: null, wm_critic_score: null };
}

for(const status of ["upcoming", "in_cinema", "opening_week"]){
  test(`CAS-1191 AC1/AC2: ${status} — buzz and ratings both present blends to the rounded mean`, () => {
    const m = withBuzzAndRatings(status);
    const buzz = E.wmCinemaScore(m), q = E.wmQScore(m);
    assert.ok(buzz >= 0 && q >= 0, "test setup: fixture must carry both a real buzz figure and a real wmQScore");
    assert.equal(E.cascadeScore(m), Math.round((buzz + q) / 2),
      `${status}: both present should blend to the rounded mean of buzz (${buzz}) and ratings (${q})`);
  });
  test(`CAS-1191 AC1/AC2: ${status} — buzz only gives buzz`, () => {
    const m = withBuzzOnly(status);
    const buzz = E.wmCinemaScore(m);
    assert.ok(buzz >= 0, "test setup: fixture must carry a real buzz figure");
    assert.equal(E.wmQScore(m), -1, "test setup: fixture must carry no ratings");
    assert.equal(E.cascadeScore(m), buzz, `${status}: buzz only should give buzz`);
  });
  test(`CAS-1191 AC1/AC2: ${status} — ratings only gives the ratings figure`, () => {
    const m = withRatingsOnly(status);
    const q = E.wmQScore(m);
    assert.ok(q >= 0, "test setup: fixture must carry a real wmQScore");
    assert.equal(E.wmCinemaScore(m), -1, "test setup: fixture must carry no buzz figure");
    assert.equal(E.cascadeScore(m), q, `${status}: ratings only should give the ratings figure`);
  });
  test(`CAS-1191 AC1/AC2: ${status} — neither gives -1`, () => {
    const m = withNeither(status);
    assert.equal(E.wmCinemaScore(m), -1, "test setup: fixture must carry no buzz figure");
    assert.equal(E.wmQScore(m), -1, "test setup: fixture must carry no ratings");
    assert.equal(E.cascadeScore(m), -1, `${status}: neither should give -1`);
  });
}

test("CAS-1191 AC3: cascadeScore(m) === wmCascadeScore(m) for every film in the built catalogue", () => {
  for(const m of E.MOVIES){
    assert.equal(E.cascadeScore(m), E.wmCascadeScore(m), `${m.title}: cascadeScore disagreed with wmCascadeScore`);
  }
});

test("CAS-1191 AC4: a released fixture (rental, included_streaming) is unchanged — wmQScore, buzz never read", () => {
  for(const status of ["rental", "included_streaming"]){
    const m = { status: [status], wm_popularity_percentile: 1e9, wm_user_rating: 8.0, wm_critic_score: 90 };
    const q = E.wmQScore(m);
    assert.ok(q >= 0, "test setup: fixture must carry a real wmQScore");
    assert.equal(E.cascadeScore(m), q, `${status}: released film's Cascade score should be wmQScore alone`);
  }
});

test("CAS-1191 AC5: cascadeScoreSourcesText for an upcoming fixture names Buzz and ratings, or Buzz alone", () => {
  const both = withBuzzAndRatings("upcoming");
  assert.equal(E.cascadeScoreSourcesText(both), "Buzz and People and Critics",
    "upcoming with buzz, a People rating and a Critics score should name both");

  const buzzOnly = withBuzzOnly("upcoming");
  assert.equal(E.cascadeScoreSourcesText(buzzOnly), "Buzz", "upcoming with buzz only should name Buzz alone");
});

// AC6: the manifest's own scoreable rule mirrors cascadeScore's dispatch — upcoming is scoreable on buzz
// alone OR a wmQScore clearing the floor, exactly like in_cinema/opening_week, not on buzz alone only.
test("CAS-1191 AC6: isScoreable treats upcoming the same as in_cinema/opening_week — buzz OR a wmQScore clearing the floor", () => {
  const ratedNoBuzz = { status: ["upcoming"], wm_popularity_percentile: undefined, wm_user_rating: 8.0, wm_critic_score: 90 };
  const q = E.wmQScore(ratedNoBuzz);
  assert.ok(q >= 0, "test setup: fixture must carry a real wmQScore");
  assert.equal(E.wmCinemaScore(ratedNoBuzz), -1, "test setup: fixture must carry no buzz figure");

  assert.equal(isScoreable(E, ratedNoBuzz, q), true, "an upcoming title rated at or above the floor, with no buzz, must be scoreable");
  assert.equal(isScoreable(E, ratedNoBuzz, q + 1), false, "an upcoming title rated below the floor, with no buzz, must not be scoreable");

  const buzzedOnly = { status: ["upcoming"], wm_popularity_percentile: 1e9, wm_user_rating: null, wm_critic_score: null };
  assert.ok(E.wmCinemaScore(buzzedOnly) >= 0, "test setup: fixture must carry a real buzz figure");
  assert.equal(isScoreable(E, buzzedOnly, 1000), true, "an upcoming title with real buzz must be scoreable regardless of how high the floor is");
});
