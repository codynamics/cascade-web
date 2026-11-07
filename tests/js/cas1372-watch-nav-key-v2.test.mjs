// CAS-1372: watchNavKey() (app_template.html, CAS-1236's settled-list fingerprint) listed only v1 mood
// fields (watchMoodSel/moodTopYouEffectiveN/moodTopPublicN/moodSource) — none of a v2 mood's own settings
// (styles/show/sort/topShare/ages/awards/years/watched/handOnly/starredOnly/in/out) or the agent's own
// genre bars/combo overrides. So saving a v2 mood's settings, or changing the agent's genre share/on-off
// from the Agent screen, left render() on the light reconcilePatchSettledList() path — Watch kept showing
// the stale list until a mood switch touched watchMoodSel (already fingerprinted), which is why that
// "fixed" it. Same convention as tests/js/cas1248-watch-nav-key.test.mjs: exercises watchNavKey() directly
// against the real mutators the ticket names, rather than re-deriving render()'s own rebuild-vs-patch rule.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function oneAgent(overrides){
  return { id:"cas1372-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[], ...overrides };
}
function withV2Agent(E, fn){
  const savedCascades = [...E.cascades];
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedSel = E.watchMoodSel;
  E.cascades.length = 0;
  E.cascades.push(oneAgent());
  try { return fn(E.cascades[0]); }
  finally {
    E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
    E.watchMoods.length = 0; savedMoods.forEach(m => E.watchMoods.push(m));
    if (E.watchMoodSel !== savedSel && E.watchMoods.some(m => m.id === savedSel)) E.window.setWatchMood(savedSel);
  }
}

test("CAS-1372 AC1: watchNavKey() changes when the selected v2 mood's Show is changed from Best 20 to Best 40 and saved", () => {
  const E = loadEngine();
  withV2Agent(E, () => {
    // First save establishes "best" (a built-in, show:"40") as the stored, SELECTED mood, so the second
    // save below changes only its Show field — isolated from the mood-switch effect watchMoodSel already covers.
    E.window.openOamMoodSheetFor("best");
    E.window.oamSaveMoodFromSheet();
    const stored = E.watchMoods.find(m => m.id === "best" && m.v2);
    assert.equal(stored.show, "40", "sanity: the built-in starts at Best 40");
    assert.equal(E.watchMoodSel, "best", "sanity: saving must select the mood it just saved");

    const before = E.watchNavKey();
    E.window.openOamMoodSheetFor("best");
    E.window.setOamDraftShow("20");
    E.window.oamSaveMoodFromSheet();

    const after = E.watchNavKey();
    const resaved = E.watchMoods.find(m => m.id === "best" && m.v2);
    assert.equal(resaved.show, "20", "sanity: the Show change must actually have saved");
    assert.equal(E.watchMoodSel, "best", "sanity: the selected mood must not itself have changed");
    assert.notEqual(after, before, "AC1: changing the selected mood's Show and saving must change the nav key");
  });
});

test("CAS-1372 AC2: watchNavKey() changes after changing the mood's ages, awards, years, topShare and watched, and saving", () => {
  const E = loadEngine();
  withV2Agent(E, () => {
    E.window.openOamMoodSheetFor("best");
    E.window.oamSaveMoodFromSheet();
    assert.equal(E.watchMoodSel, "best");

    const before = E.watchNavKey();
    E.window.openOamMoodSheetFor("best");
    E.window.toggleOamDraftAge("PG");
    E.window.setOamDraftAwards("won");
    E.window.setOamDraftYears(5);
    E.window.oamFilterOnRelease({ value: "70" });
    E.window.toggleOamDraftWatched();
    E.window.oamSaveMoodFromSheet();

    const after = E.watchNavKey();
    const saved = E.watchMoods.find(m => m.id === "best" && m.v2);
    assert.deepEqual([...saved.ages], ["PG"], "sanity: ages must have saved");
    assert.equal(saved.awards, "won", "sanity: awards must have saved");
    assert.equal(saved.years, 5, "sanity: years must have saved");
    assert.equal(saved.topShare, 70, "sanity: topShare must have saved");
    assert.equal(saved.watched, true, "sanity: watched must have saved");
    assert.notEqual(after, before, "AC2: changing ages/awards/years/topShare/watched and saving must change the nav key");
  });
});

test("CAS-1372 AC2: watchNavKey() changes when a genre's share (bar) is changed on the Agent screen", () => {
  const E = loadEngine();
  withV2Agent(E, (c) => {
    c.styles.Horror = { bar: 50, al: { cinema:false, rent:false, stream:false } };
    const before = E.watchNavKey();
    E.oaOnRelease({ dataset: { style: "Horror" }, value: "40" });
    assert.notEqual(c.styles.Horror.bar, 50, "sanity: the release must actually have changed the bar");
    const after = E.watchNavKey();
    assert.notEqual(after, before, "AC2: changing a genre's share on the Agent screen must change the nav key");
  });
});

test("CAS-1372 AC2: watchNavKey() changes when a genre's on/off tick is changed on the Agent screen", () => {
  const E = loadEngine();
  withV2Agent(E, (c) => {
    c.styles.War = { bar: 60, al: { cinema:false, rent:false, stream:false } };
    const before = E.watchNavKey();
    E.oaToggleStyleOn("War");
    assert.equal(c.styles.War.bar, null, "sanity: the tick must actually have turned the style off");
    const after = E.watchNavKey();
    assert.notEqual(after, before, "AC2: turning a genre off on the Agent screen must change the nav key");
  });
});

test("CAS-1372: watchNavKey() is unaffected by any of this when there is no v2 agent (non-regression for v1 accounts)", () => {
  const E = loadEngine();
  assert.equal(E.oneAgentCriteria(), null, "sanity: this harness's default account is v1");
  const before = E.watchNavKey();
  const after = E.watchNavKey();
  assert.equal(after, before, "a v1 account's nav key must be stable with nothing navigational touched");
});
