// CAS-1179: the Massive Movies onboarding recipe must build with cinemaReleaseOnly on — never shown or
// asked about in onboarding, simply on when the agent is later opened. Pins the exact literal landing in
// the built HTML (AC1), the flag's value on every onboarding agent (AC2/AC3), and that the reveal step's
// own render never mentions it (AC4).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const E = loadEngine();

test("AC1: the cinemaReleaseOnly literal lands exactly once in the built index.html", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const needle = "selCrowd: 0, selCritScore: 0, selAwards: 0, selScale: 0, cinemaReleaseOnly: true,";
  assert.equal(html.split(needle).length - 1, 1);
});

test("AC2: Massive Movies builds with cinemaReleaseOnly true for both cinema answers", () => {
  ["yes", "no"].forEach(cinema => {
    const agents = E.buildOnbAgentsV2({ cinema });
    const massive = agents.find(a => a.template === "onb_massive");
    assert.ok(massive, `setup: cinema:"${cinema}" must still produce a Massive Movies agent`);
    assert.equal(massive.cinemaReleaseOnly, true,
      `AC2: Massive Movies must have cinemaReleaseOnly===true for cinema:"${cinema}"`);
  });
});

test("AC3: every other onboarding agent builds with cinemaReleaseOnly false", () => {
  ["yes", "no"].forEach(cinema => {
    const agents = E.buildOnbAgentsV2({ cinema, partner: "yes", kids: "yes" });
    const others = agents.filter(a => a.template !== "onb_massive");
    assert.ok(others.some(a => a.template === "onb_favs"), "setup: onb_favs must be present");
    others.forEach(a => assert.equal(a.cinemaReleaseOnly, false,
      `AC3: ${a.template} must have cinemaReleaseOnly===false (cinema:"${cinema}")`));
  });
});

test("AC4: onbAgentRevealHTML for Massive Movies never mentions \"cinema release\"", () => {
  const agents = E.buildOnbAgentsV2({ cinema: "yes" });
  const massive = agents.find(a => a.template === "onb_massive");
  const html = E.onbAgentRevealHTML(massive, 1, "Your first agent", "");
  assert.equal(/cinema release/i.test(html), false);
});
