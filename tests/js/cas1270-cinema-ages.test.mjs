// CAS-1270: the first onboarding agent becomes the cinema agent ("In Cinema") when the person says
// they go to the cinema, keeping its old name ("Massive Movies") otherwise; a new question right after
// v2_cinema confirms the age ratings wanted there, replacing the budget question outright.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
// CAS-1143/agents.test.mjs: arrays crossing the vm sandbox boundary carry the SANDBOX Array's
// [[Prototype]], not this file's own, so assert.deepEqual on a raw engine array fails even when the
// values match — spread it into a real, this-realm array first.
const arr = a => [...(a || [])];

test("AC1: buildOnbAgentsV2[0] is named In Cinema with the chosen cinemaAges when cinema is yes, Massive Movies with the fixed ladder when no", () => {
  const yes = E.buildOnbAgentsV2({
    ...E.onbAnswersV2Default(),
    cinema: "yes", rent: "yes", cinemaAges: ["PG", "M"],
  })[0];
  assert.equal(yes.name, "In Cinema");
  assert.deepEqual(arr(yes.age), ["PG", "M"]);

  const no = E.buildOnbAgentsV2({
    ...E.onbAnswersV2Default(),
    cinema: "no", rent: "yes",
  })[0];
  assert.equal(no.name, "Massive Movies");
  assert.deepEqual(arr(no.age), ["M", "MA 15+", "R 18+"]);
});

test("AC2: FLOWS carries v2_cinema_ages right after v2_cinema and no v2_budget anywhere, and stepSkipped follows the cinema answer", () => {
  ["cinema", "stream"].forEach(lane => {
    const seq = E.FLOWS[lane];
    assert.ok(!seq.includes("v2_budget"), `FLOWS.${lane} must not include v2_budget`);
    const i = seq.indexOf("v2_cinema");
    assert.ok(i >= 0, `FLOWS.${lane} must include v2_cinema`);
    assert.equal(seq[i + 1], "v2_cinema_ages", `FLOWS.${lane} must walk v2_cinema_ages immediately after v2_cinema`);
  });

  E.onbFlow.answersV2 = { ...E.onbAnswersV2Default(), cinema: "no" };
  assert.equal(E.stepSkipped("v2_cinema_ages"), true);

  E.onbFlow.answersV2 = { ...E.onbAnswersV2Default(), cinema: "yes" };
  assert.equal(E.stepSkipped("v2_cinema_ages"), false);
});
