// CAS-1373: turning a genre on (off→on) sets its Cinema/Rent/Stream alerts on, unless it has remembered
// alerts from before it was turned off — in which case those are restored instead. Drives the real shipped
// engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly, the same convention
// tests/js/cas1339-agent-screen.test.mjs uses for oaToggleStyleOn/oaTurnStyleOn.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function oneAgent(overrides){
  return { id:"cas1373-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[], ...overrides };
}
function styleOn(bar, al){
  return { bar, al: { cinema:false, rent:false, stream:false, ...al } };
}
function withCascades(agents, fn){
  const saved = [...E.cascades];
  E.cascades.length = 0;
  agents.forEach(a => E.cascades.push(a));
  try{ return fn(); }
  finally{ E.cascades.length = 0; saved.forEach(a => E.cascades.push(a)); }
}
// JSON.stringify, not deepEqual: these `al` objects are built inside the vm sandbox, whose Object.prototype
// is a different realm's — node:assert/strict's deepEqual is deepStrictEqual, which compares prototypes and
// fails even on structurally identical objects across that boundary (same note as cas1198-alerts-switch.
// test.mjs / cas1193-alert-moments-sync.test.mjs).
function assertAl(al, expected, msg){
  assert.equal(JSON.stringify(al), JSON.stringify(expected), msg);
}

test("CAS-1373 AC1: ticking an off style on sets Cinema/Rent/Stream alerts all on", () => {
  withCascades([oneAgent({ styles: {} })], () => {
    const c = E.cascades[0];
    E.oaToggleStyleOn("Horror"); // never had an entry before — the Agent screen's own tick
    assertAl(c.styles.Horror.al, { cinema:true, rent:true, stream:true });
    const m = { genres:["Horror"] };
    assert.equal(E.oneAgentAlerts(m, "cinema"), true);
    assert.equal(E.oneAgentAlerts(m, "rent"), true);
    assert.equal(E.oneAgentAlerts(m, "stream"), true);
  });
});

test("CAS-1373 AC2: switching a style off remembers its alerts as lastAl; re-ticking restores them exactly", () => {
  withCascades([oneAgent({ styles: { "War": styleOn(50, { cinema:true, rent:false, stream:true }) } })], () => {
    const c = E.cascades[0];
    E.oaToggleStyleOn("War"); // off
    assert.equal(c.styles.War.bar, null);
    assertAl(c.styles.War.lastAl, { cinema:true, rent:false, stream:true }, "lastAl snapshots the mixed state");
    E.oaToggleStyleOn("War"); // on again
    assert.equal(c.styles.War.bar, 50, "lastBar still restores the share (CAS-1367)");
    assertAl(c.styles.War.al, { cinema:true, rent:false, stream:true }, "lastAl restores, not all-on");
  });
});

test("CAS-1373: a style turned off with every alert off still restores to every-alert-off, not all-on", () => {
  withCascades([oneAgent({ styles: { "Crime": styleOn(70, { cinema:false, rent:false, stream:false }) } })], () => {
    const c = E.cascades[0];
    E.oaToggleStyleOn("Crime"); // off
    E.oaToggleStyleOn("Crime"); // on again
    assertAl(c.styles.Crime.al, { cinema:false, rent:false, stream:false });
  });
});

test("CAS-1373 AC3: oaTurnStyleOn — the function Find's \"Turn <Genre> on\" (oamWilTurnOnGenre) shares with the Agent screen's tick — applies the same restore-or-all-on rule", () => {
  withCascades([oneAgent({ styles: {} })], () => {
    const c = E.cascades[0];
    c.styles.Mystery = { al: { cinema:false, rent:false, stream:false } };
    E.oaTurnStyleOn(c.styles.Mystery);
    assertAl(c.styles.Mystery.al, { cinema:true, rent:true, stream:true }, "no lastAl yet: defaults all-on");

    c.styles.Mystery.lastAl = { cinema:false, rent:true, stream:false };
    c.styles.Mystery.al = { cinema:false, rent:false, stream:false };
    E.oaTurnStyleOn(c.styles.Mystery);
    assertAl(c.styles.Mystery.al, { cinema:false, rent:true, stream:false }, "restores lastAl when present");
  });
});

test("CAS-1373: changing an on style's share (slider release) or applying a bar suggestion never touches its alerts", () => {
  withCascades([oneAgent({ styles: { "Thriller": styleOn(65, { cinema:true, rent:false, stream:true }) } })], () => {
    const c = E.cascades[0];
    E.oaOnRelease({ dataset:{style:"Thriller"}, value:"20" });
    assertAl(c.styles.Thriller.al, { cinema:true, rent:false, stream:true }, "slider release leaves alerts untouched");
    E.oaApplySuggestion("Thriller", 80);
    assertAl(c.styles.Thriller.al, { cinema:true, rent:false, stream:true }, "applying a suggestion leaves alerts untouched");
  });
});
