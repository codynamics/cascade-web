// CAS-923: laneCrit's cinema branch used to zero cinemaReleaseOnly along with the three Mission dials
// it's actually meant to clear (CAS-261), so the "Had a cinema release" switch turned on, painted on, and
// was wiped back to false before onbApply's caller (briefSave -> commitDraft) ever saw it. Drives the real
// UI: Agents screen -> Edit -> flip the switch -> Save -> reopen the Briefing, for both a CINEMA-kind and a
// STREAM-kind agent (the stream lane was never known to be broken; it's covered so a future regression on
// either lane is caught the same way).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, openAgentsScreenFromMenu } from "./helpers.mjs";

async function openFirstAgentBriefing(page){
  await openAgentsScreenFromMenu(page);
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(".ag-edit").first().click();
  await expect(page.locator("#onbCinemaRelease")).toBeVisible();
}

async function cinemaReleaseSwitchOn(page){
  return page.locator("#onbCinemaRelease").evaluate(el => el.classList.contains("on"));
}

for(const kind of ["cinema", "stream"]){
  test(`Briefing: "Had a cinema release" survives Save on a ${kind.toUpperCase()}-kind agent (CAS-923 AC4)`, async ({ page }) => {
    await toShortlist(page, kind);
    await finishFlow(page);
    await toListing(page);

    await openFirstAgentBriefing(page);
    const agentId = await page.evaluate(() => onbFlow.draft.id);

    // CAS-1179: the first-built agent is Massive Movies (rank 0, which `.ag-edit.first()` always opens),
    // and that recipe now builds with this switch ON by design — it no longer starts every agent off.
    // Toggle whichever state it actually opens on, and prove THAT value (not a hardcoded one) survives Save.
    const before = await cinemaReleaseSwitchOn(page);
    await page.locator("#onbCinemaRelease").click();
    const after = !before;
    expect(await cinemaReleaseSwitchOn(page)).toBe(after);

    // CAS-934 retired the Briefing's own Save button — Back (#onbStep .osback) is the only exit now, and
    // commits the draft on its way out (briefClose -> briefCommit), same as every other Briefing edit.
    await page.locator("#onbStep .osback").click();
    await expect(page.locator("#onbStep")).not.toHaveClass(/open/);   // briefClose closes back to Agents

    const saved = await page.evaluate(id => cascades.find(c => c.id === id).cinemaReleaseOnly, agentId);
    expect(saved).toBe(after);

    // Reopen — the switch must still read the toggled value, not have been quietly reset by laneCrit on
    // the way to disk.
    await page.locator(`.agrow[data-id="${agentId}"] .ag-edit`).click();
    await expect(page.locator("#onbCinemaRelease")).toBeVisible();
    expect(await cinemaReleaseSwitchOn(page)).toBe(after);
  });
}
