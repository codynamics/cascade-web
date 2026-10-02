// CAS-1103 AC2: pollCatalogue polls only the catalogue.json pointer, and fetches the content-hashed
// catalogue file (catalogue/catalogue.<hash>.json) only when the pointer's hash actually changes — the
// fix for the installed iOS app re-downloading and re-parsing the whole ~11MB catalogue every 3 minutes
// (its capacitor://localhost origin can't read the ETag header the old web-only 304 trick relied on).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function mockResponse(json){
  return { ok: true, json: async () => json, clone(){ return this; } };
}

test("CAS-1103: pollCatalogue fetches the hashed file zero times on an unchanged hash, once on a changed hash", async () => {
  const savedFetch = E.window.fetch;
  const savedHash = E.catalogueHash;
  // A real film shape (round-tripped through JSON, the same as the pipeline's own trimmed payload) so the
  // swap path's canonMovieAgeRatings/captureClaimedStatus/rederiveStatuses/recomputeFound all see exactly
  // the fields they already handle today, rather than a hand-built fixture that happens to be incomplete.
  // pollCatalogue REASSIGNS the engine's internal MOVIES binding wholesale (`MOVIES = ...`) rather than
  // mutating it in place — E.MOVIES was captured once at export time, so it keeps pointing at the original
  // catalogue regardless, same as it would across any other wholesale reassignment in this harness.
  const realFilm = JSON.parse(JSON.stringify(E.MOVIES[0]));
  let calls = [];

  try{
    // --- Unchanged hash: two polls must never fetch the hashed file. ---
    E.setCatalogueHash("deadbeef0000");
    E.window.fetch = async (url) => {
      calls.push(url);
      if(url === "catalogue.json"){
        return mockResponse({ file: "catalogue/catalogue.deadbeef0000.json", hash: "deadbeef0000",
          generated: "2026-10-02", count: 1 });
      }
      throw new Error("unexpected fetch in unchanged-hash case: " + url);
    };
    await E.pollCatalogue();
    await E.pollCatalogue();
    assert.equal(calls.length, 2, "both polls must still check the pointer");
    assert.ok(calls.every(u => u === "catalogue.json"),
      "an unchanged pointer hash must fetch the hashed file zero times");

    // --- Changed hash: exactly one fetch of the hashed file, even across a second poll. ---
    calls = [];
    const HASH = "c0ffee123456";
    E.window.fetch = async (url) => {
      calls.push(url);
      if(url === "catalogue.json"){
        return mockResponse({ file: `catalogue/catalogue.${HASH}.json`, hash: HASH,
          generated: "2026-10-02", count: 1 });
      }
      if(url === `catalogue/catalogue.${HASH}.json`) return mockResponse([realFilm]);
      throw new Error("unexpected fetch in changed-hash case: " + url);
    };
    await E.pollCatalogue();
    await E.pollCatalogue();   // same hash as the first poll just landed — must not refetch the file
    const hashedCalls = calls.filter(u => u === `catalogue/catalogue.${HASH}.json`);
    assert.equal(hashedCalls.length, 1, "a changed hash must fetch the hashed file exactly once");
    assert.equal(E.catalogueHash, HASH);
  } finally {
    E.window.fetch = savedFetch;
    E.setCatalogueHash(savedHash);
  }
});
