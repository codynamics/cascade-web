// CAS-1389: the watch-next star (CAS-1295) lives on the normal card only — a tap-opened stub (stubHTML)
// no longer carries its own star button. cardHTML keeps its star, so the two must diverge on the same film.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("CAS-1389: stubHTML has no star, cardHTML still does, for the same film", () => {
  const m = E.MOVIES[0];
  assert.ok(m, "sanity: the catalogue must carry at least one film");
  assert.ok(!E.stubHTML(m).includes("data-star="), "stubHTML must not render the watch-next star");
  assert.ok(E.cardHTML(m, false).includes("data-star="), "cardHTML must still render the watch-next star");
});
