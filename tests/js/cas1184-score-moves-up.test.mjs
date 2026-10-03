// CAS-1184: a stale marker on a window that's off in Service tracking (e.g. Premium, off by default for
// every new account) used to sit untouched by setAgentScore's account-enabled filter — normCascade's own
// floor collapse then pulled every other marker down to that leftover on every load, so the score could
// drop but never rise. Fixed by having setAgentScore/toggleAgentWindow move every marker that exists,
// on or off in Service tracking, together.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Premium off, the other three on — matches the account shape in the ticket's observation.
const WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...WATCH_PREFS });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}

test("AC1/AC2: setAgentScore moves every marker together, so the score can rise again after it drops", () => withWatchPrefs(() => {
  const c = E.normCascade({ kind: "stream", status: [], trackV: 2,
    watchMarkers: { in_cinema: 62, premium: 62, rent: 62, stream: 62 } });

  E.setAgentScore(c, 80);
  E.normCascade(c);
  assert.equal(c.watchMarkers.in_cinema, 80, "AC1: up must reach the account-enabled windows");
  assert.equal(c.watchMarkers.rent, 80);
  assert.equal(c.watchMarkers.stream, 80);

  E.setAgentScore(c, 70);
  E.normCascade(c);
  assert.equal(c.watchMarkers.in_cinema, 70, "AC2: down must still work");
  assert.equal(c.watchMarkers.rent, 70);
  assert.equal(c.watchMarkers.stream, 70);

  E.setAgentScore(c, 90);
  E.normCascade(c);
  assert.equal(c.watchMarkers.in_cinema, 90, "AC2: up must work again after a prior down");
  assert.equal(c.watchMarkers.rent, 90);
  assert.equal(c.watchMarkers.stream, 90);
}));

test("AC3: Off nulls every marker including an off-Service-tracking window, and re-arming a pill restores the remembered score, not a lower one", () => withWatchPrefs(() => {
  const c = E.normCascade({ kind: "stream", status: [], trackV: 2,
    watchMarkers: { in_cinema: 90, premium: 90, rent: 90, stream: 90 } });

  E.setAgentScore(c, 0);
  assert.deepEqual(c.watchMarkers, { in_cinema: null, premium: null, rent: null, stream: null },
    "AC3: Off must null every marker, Premium included");

  E.toggleAgentWindow(c, "stream");
  E.normCascade(c);
  assert.equal(c.watchMarkers.stream, 90, "AC3: re-arming a pill must restore the remembered score, not something lower");
}));
