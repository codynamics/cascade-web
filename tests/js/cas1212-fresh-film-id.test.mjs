// CAS-1212: freshFilmId's own level-awareness — the shared helper cas1196-answer-param.test.mjs and
// cas1205-film-page-member.test.mjs both use to pick a film for a cinema/rent/stream case must never hand
// back a film whose requested level is already spent in the real, daily-refreshed catalogue (see both
// files' own freshFilmId calls for why "already spent" is a real, daily-moving condition, not a fixture
// bug — CAS-280).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";
import { freshFilmId } from "./fresh-film-id.mjs";

test("CAS-1212: freshFilmId picks a film whose requested level is not spent", () => {
  const E = loadEngine();
  for(const levelKey of ["in_cinema", "rent", "stream"]){
    const used = new Set();
    const m = freshFilmId(E, used, levelKey);
    const level = E.watchLevelsFor(m.tmdb_id).find(l => l.key === levelKey);
    assert.ok(level, `${levelKey} must be one of the film's own WATCH_LEVEL_KEYS`);
    assert.notEqual(level.spent, true, `freshFilmId must never hand back a film with a spent "${levelKey}" level`);
  }
});
