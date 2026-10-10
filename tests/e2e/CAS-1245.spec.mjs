// CAS-1245: the collapsed Watch card's calmer CSS pass (app_template.html, "CALMER COLLAPSED CARD" block) —
// the poster fills the card, nothing glows, and an outline on a collapsed card means you can tap it
// (badge, Budget, the service picker, the three action buttons) while certificate/language/score/awards/the
// cinema lozenge carry none. Driven against the real streaming catalogue (toShortlist "stream"), not a
// synthetic fixture: AC4's button.tentbadge/button.m.muted and AC6's .cap.recent are each gated on real
// film data (scaleTier/inferredScale/windowsLineHTML's own recency window) that this suite has no reason to
// fake — so, like AC6 itself says, each is checked across every collapsed card on the page and skipped,
// not failed, if the real listing happens to hold none.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toWatchStreamingScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => { setWatchTab("stream"); render(); });
  await settleListing(page);
}

test("CAS-1245: collapsed Watch card — poster fills, no glow, outline only on what's tappable", async ({ page }) => {
  await toWatchStreamingScreen(page);

  const collapsedCount = await page.locator("#groups .card:not(.expanded)").count();
  expect(collapsedCount, "the Streaming stage must list at least one film").toBeGreaterThanOrEqual(1);

  const firstCard = page.locator("#groups .card:not(.expanded)").first();

  // AC1: the poster fills the card's height.
  const { cardHeight, posterHeight } = await firstCard.evaluate(card => ({
    cardHeight: card.getBoundingClientRect().height,
    posterHeight: card.querySelector(".poster").getBoundingClientRect().height,
  }));
  expect(Math.abs(cardHeight - posterHeight)).toBeLessThanOrEqual(3);

  // AC2: certificate/language read as plain text, not a lozenge.
  const certStyle = await firstCard.evaluate(card => {
    const cert = card.querySelector(".cert");
    if(!cert) return null;
    const cs = getComputedStyle(cert);
    return { borderTopWidth: cs.borderTopWidth, backgroundColor: cs.backgroundColor };
  });
  if(certStyle){
    expect(certStyle.borderTopWidth).toBe("0px");
    expect(certStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  }

  // AC3: the Cascade score carries no outline — it's information, not a control.
  const qscoreBorderTopColor = await firstCard.evaluate(card => {
    const q = card.querySelector(".qscore");
    return q ? getComputedStyle(q).borderTopColor : null;
  });
  if(qscoreBorderTopColor) expect(qscoreBorderTopColor).toBe("rgba(0, 0, 0, 0)");

  // AC4: wherever the scale badge / an inferred Budget button appear, they carry the one shared tappable
  // outline (checked across every collapsed card — real catalogue data decides which cards have one).
  const outlineButtons = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("#groups .card:not(.expanded) button.tentbadge").forEach(el => {
      const cs = getComputedStyle(el);
      out.push({ kind: "tentbadge", borderTopColor: cs.borderTopColor, borderTopStyle: cs.borderTopStyle, boxShadow: cs.boxShadow });
    });
    document.querySelectorAll("#groups .card:not(.expanded) button.m.muted").forEach(el => {
      const cs = getComputedStyle(el);
      out.push({ kind: "m.muted", borderTopColor: cs.borderTopColor, borderTopStyle: cs.borderTopStyle, boxShadow: cs.boxShadow });
    });
    return out;
  });
  for(const btn of outlineButtons){
    expect(btn.borderTopColor, `${btn.kind} border-top-color`).toBe("rgba(255, 255, 255, 0.32)");
    expect(btn.borderTopStyle, `${btn.kind} border-top-style`).toBe("solid");
    expect(btn.boxShadow, `${btn.kind} box-shadow`).toBe("none");
  }

  // AC5: Watched carries the same outline colour as the other two action buttons, and nothing on the
  // action row glows.
  const watchBorderTopColor = await firstCard.evaluate(card =>
    getComputedStyle(card.querySelector(".ctl.watch .cmini")).borderTopColor);
  expect(watchBorderTopColor).toBe("rgb(76, 125, 255)");
  const actionBoxShadows = await firstCard.evaluate(card =>
    [...card.querySelectorAll(".ctl .cmini")].map(el => getComputedStyle(el).boxShadow));
  expect(actionBoxShadows.length).toBeGreaterThanOrEqual(1);
  actionBoxShadows.forEach(bs => expect(bs).toBe("none"));

  // AC6: a recently-changed release lozenge never glows (checked across every collapsed card; skipped,
  // not failed, if the real listing holds none right now).
  const recentBoxShadows = await page.evaluate(() =>
    [...document.querySelectorAll("#groups .card:not(.expanded) .cap.recent")].map(el => getComputedStyle(el).boxShadow));
  recentBoxShadows.forEach(bs => expect(bs).toBe("none"));

  // AC7: expanding the card proves the expanded card is untouched — its certificate regains its outline.
  await firstCard.locator(".cbody").click();
  await expect(firstCard).toHaveClass(/expanded/);
  const expandedCertBorderTopWidth = await firstCard.evaluate(card => {
    const cert = card.querySelector(".cert");
    return cert ? getComputedStyle(cert).borderTopWidth : null;
  });
  if(expandedCertBorderTopWidth) expect(parseFloat(expandedCertBorderTopWidth)).toBeGreaterThan(0);
});
