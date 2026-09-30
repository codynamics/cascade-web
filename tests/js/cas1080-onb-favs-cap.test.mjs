// CAS-1080: production QA (ONB-15) hit a clean-first-run answer set — broad cinema/rent/streaming,
// three broad styles, a partner and kids — where Personal Favs' score solve reached its 95 ceiling
// without seating watchCount() at or under ONB_AGENT_CAP_V2, because the catalogue (~5,750 films) has
// grown well past the ~2,300 the cap was set against. This asserts the fixed solve gets there by
// tightening yearsBack (its own recipe lever) once score alone can't, for exactly that answer set.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("CAS-1080: Personal Favs lands within the cap for the ONB-15 broad answer set", () => {
  const ans = {
    ...E.onbAnswersV2Default(),
    cinema: "yes", rent: "yes",
    styles: ["Drama", "Thriller", "Comedy"],
    selScale: 0,
    ages: ["M", "MA 15+"],
    partner: "yes", partnerDiff: "no", partnerStyles: [],
    kids: "yes", kidAges: ["G", "PG"],
    services: ["Apple TV Store", "Netflix", "Stan"],
  };

  const agents = E.buildOnbAgentsV2(ans);
  const favs = agents.find(a => a.name === "Personal Favs");
  assert.ok(favs, "Personal Favs must build for this answer set");

  const n = E.watchCount(favs);
  assert.ok(n >= 1 && n <= E.ONB_AGENT_CAP_V2,
    `Personal Favs watchCount ${n} must be within [1, ${E.ONB_AGENT_CAP_V2}]`);
});
