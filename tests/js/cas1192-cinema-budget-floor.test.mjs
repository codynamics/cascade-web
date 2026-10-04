// CAS-1192: an in-cinema film, on general release, in the Blockbuster or Must-see buzz band, with neither a
// published budget nor takings, is treated as AT LEAST Studio scale — a lower bound that can admit a floor
// at or below Studio but must never deny a higher one (selScaleMatch falls back to includeUnbudgeted there,
// exactly like a film with no inference at all). Fixtures only, never real catalogue titles (the ticket's
// own evidence names Heart of the Beast et al. — those are explicitly out of bounds for a test fixture).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

let fixtureSeq = 0;
// A popularity figure read off the engine's OWN live cuts, not a hand-picked constant, so each fixture
// lands in the intended band regardless of how the catalogue's popularity distribution moves day to day.
// cuts[2] clears Blockbuster (it may also clear Must-see if the catalogue's cuts happen to tie — both bands
// satisfy the ticket's own condition, buzzBandOf is "blockbuster" OR "mustsee").
function topBandPopularity(){ return E.BUZZ_CUTS[2]; }
function anticipatedOnlyPopularity(){
  const cuts = E.BUZZ_CUTS;
  return cuts[1] + (cuts[2] - cuts[1]) / 2;   // strictly between the Anticipated and Blockbuster cuts
}
function topBandFixture(overrides = {}){
  return {
    tmdb_id: `cas1192-fixture-${fixtureSeq++}`,
    title: "CAS-1192 Fixture",
    status: ["in_cinema"],
    cinema_release: true,
    popularity: topBandPopularity(),
    budget: 0,
    worldwide_gross: 0,
    ...overrides,
  };
}

test("CAS-1192 AC1: an in-cinema, general-release, top-buzz-band fixture with no budget/takings infers Studio and clears a Studio floor", () => {
  const m = topBandFixture();
  const band = E.buzzBandOf(m);
  assert.ok(band === "blockbuster" || band === "mustsee", `test setup: fixture landed in band "${band}", not blockbuster/mustsee`);
  const inf = E.inferredScale(m);
  assert.ok(inf, "inferredScale returned nothing for the AC1 fixture");
  assert.equal(inf.label, "Studio", `inferredScale returned ${inf && inf.label}, expected Studio`);
  assert.equal(E.selScaleMatch(m, { selScale: 15e6, includeUnbudgeted: false }), true,
    "a Studio-or-below floor did not admit the AC1 fixture");
});

test("CAS-1192 AC2: above the Studio floor, the AC1 fixture is decided by includeUnbudgeted, never denied outright", () => {
  const m = topBandFixture();
  assert.equal(E.selScaleMatch(m, { selScale: 100e6, includeUnbudgeted: false }), false,
    "a $100M floor admitted the fixture with includeUnbudgeted false");
  assert.equal(E.selScaleMatch(m, { selScale: 100e6, includeUnbudgeted: true }), true,
    "a $100M floor did not admit the fixture with includeUnbudgeted true");
});

test("CAS-1192 AC3: no inference without a general cinema release, without a top buzz band, or off a cinema status", () => {
  const notGeneralRelease = topBandFixture({ cinema_release: false });
  assert.equal(E.inferredScale(notGeneralRelease), null, "cinema_release:false must not be inferred");

  const anticipatedBand = topBandFixture({ popularity: anticipatedOnlyPopularity() });
  const band = E.buzzBandOf(anticipatedBand);
  assert.ok(band !== "blockbuster" && band !== "mustsee", `test setup: fixture must not land in the top bands, landed in "${band}"`);
  assert.equal(E.inferredScale(anticipatedBand), null, "an anticipated-or-lower-band fixture must not be inferred by the new case");

  const noBand = topBandFixture({ popularity: 0 });
  assert.equal(E.buzzBandOf(noBand), null, "test setup: fixture must carry no buzz band");
  assert.equal(E.inferredScale(noBand), null, "a film with no buzz band at all must not be inferred");

  const rental = topBandFixture({ status: ["rental"] });
  assert.equal(E.primaryStatus(rental), "rental", "test setup: fixture must read as rental");
  assert.equal(E.inferredScale(rental), null, "a rental-status fixture must not be inferred");
});

test("CAS-1192 AC4: a real budget always wins over the inference, and a below-floor real budget denies", () => {
  const m = topBandFixture({ budget: 3e6 });
  assert.equal(E.inferredScale(m), null, "a fixture with a real budget must not be inferred at all");
  assert.equal(E.selScaleMatch(m, { selScale: 15e6 }), false,
    "a $3M real budget cleared a $15M floor");
});

test("CAS-1192 AC5: the existing upcoming inference is unaffected — its floor still denies below itself, with no lowerBound flag", () => {
  const inferred = E.MOVIES.find(m => !(m.budget > 0) && !(m.worldwide_gross > 0) && E.isUpcoming(m) && E.inferredScale(m));
  assert.ok(inferred, "no real-catalogue film with an (upcoming-path) inferred scale — this test would prove nothing");
  const inf = E.inferredScale(inferred);
  assert.ok(!inf.lowerBound, "an upcoming-path inference must not carry the new lowerBound flag");
  const floor = inf.d + 1;
  assert.equal(E.selScaleMatch(inferred, { selScale: floor, includeUnbudgeted: false }), false,
    `${inferred.title}: a below-floor upcoming inference passed the scale dial with includeUnbudgeted false`);
  assert.equal(E.selScaleMatch(inferred, { selScale: floor, includeUnbudgeted: true }), false,
    "the upcoming inference's floor must still deny outright, unlike the new lower-bound case, regardless of includeUnbudgeted");
});

test("CAS-1192 AC6: budgetCell reads \"≈ Studio\" and inferScaleWhy names the in-cinema reasoning", () => {
  const m = topBandFixture();
  assert.match(E.budgetCell(m), /≈ Studio/, "budgetCell did not render \"≈ Studio\" for the AC1 fixture");
  assert.equal(E.inferScaleWhy(m),
    "No budget has been published for this film. It is in cinemas on general release and among the "
    + "most popular films showing, and most films like that were made at Studio scale or bigger. It is "
    + "an estimate, not a figure Cascade holds.");
});
