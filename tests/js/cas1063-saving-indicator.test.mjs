// CAS-1063: the account banner's "Not yet saved to your account" line was ordinary saving noise — CAS-1035's
// durable outbox raised it on every routine save, and renderAcctBanner's own syncHeaderHeight() call meant
// showing/hiding it reflowed the listing underneath the header. It is replaced by #savingDot, a fixed-size
// dot whose box is always in the layout (only CSS visibility toggles, never display) so it can never move
// anything, and which only appears once a save has been outstanding for longer than
// SAVING_INDICATOR_DELAY_MS. These tests drive the pure decision half (acctSavePending/savingIndicatorVisible)
// directly, the same convention acctBannerText's own tests (acct-read.test.mjs) use, plus the real (shrunk)
// timer via the wire half (renderAcctBanner/updateSavingIndicator).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const P = E.CascadePersistence;

// acctTablePending is exposed by reference (like cascadeKnown elsewhere) — mutate it directly, then call
// renderAcctBanner(), the same chokepoint every real save chokepoint (setAcctTablePending, recordSyncOutcome)
// already routes through on a state change. "cascades" stands in for any pending table — acctSavePending
// only cares whether ANY table is pending.
function setOutboxPending(hasRow){
  P.acctTablePending.cascades = hasRow;
  P.renderAcctBanner();
}

test.afterEach(() => { setOutboxPending(false); });

test("acctSavePending: false with nothing pending, true the instant a row is owed, false again once it clears", () => {
  assert.equal(P.acctSavePending(), false, "sanity: nothing pending before this test seeds anything");
  setOutboxPending(true);
  assert.equal(P.acctSavePending(), true);
  setOutboxPending(false);
  assert.equal(P.acctSavePending(), false);
});

test("CAS-1063 AC1/AC4: acctBannerText never mentions an outstanding save — that's the dot's job now, the genuine banners are untouched", () => {
  setOutboxPending(true);
  assert.doesNotMatch(P.acctBannerText() || "", /not yet saved/i, "an ordinary pending save must not raise banner text any more");

  // The two genuine-problem banners this ticket says must stay exactly as they are.
  P.acctTableFail.cascades = true;
  assert.match(P.acctBannerText(), /Couldn't refresh your account just now/);
  P.acctTableFail.cascades = false;
});

test("CAS-1063 AC3: a save that clears before the delay elapses never reveals the indicator", async () => {
  const realDelay = P.SAVING_INDICATOR_DELAY_MS;
  P.SAVING_INDICATOR_DELAY_MS = 30;   // shrunk so this test doesn't sit through the real 2s
  try {
    setOutboxPending(true);
    setOutboxPending(false);   // drains well inside the 30ms delay — a normal fast save
    await new Promise(r => setTimeout(r, 80));
    assert.equal(P.savingIndicatorVisible(), false, "a save that completed quickly must never show the dot");
  } finally {
    P.SAVING_INDICATOR_DELAY_MS = realDelay;
  }
});

test("a save outstanding past the delay reveals the indicator, and it clears the instant the save drains", async () => {
  const realDelay = P.SAVING_INDICATOR_DELAY_MS;
  P.SAVING_INDICATOR_DELAY_MS = 20;
  try {
    setOutboxPending(true);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(P.savingIndicatorVisible(), true, "a save outstanding past the delay must reveal the dot");

    setOutboxPending(false);
    assert.equal(P.savingIndicatorVisible(), false, "the dot must clear the instant the save drains, with no further wait");
  } finally {
    P.SAVING_INDICATOR_DELAY_MS = realDelay;
  }
});
