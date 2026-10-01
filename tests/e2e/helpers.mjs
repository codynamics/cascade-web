// CAS-232: shared driving for the e2e specs.
//
// The rule here is that anything a PERSON does, the test clicks — the splash CTA, the priority answer, an agent
// card, Continue. Only reading uses page.evaluate. A harness that drove the flow by calling flowPriority() and
// pickStarter() directly would still pass with every button on the page unwired, which is most of what an
// end-to-end suite is for.
import { expect } from "@playwright/test";

export const PRESET_NAMES = {
  // CAS-261: Nominees & Awards left the cinema lane — the cinema control set is Scale + Buzz, so there was
  // no awards criterion for it to stand on there.
  // CAS-307: Family Movies is the third cinema door, after Blockbusters and Date Night.
  cinema: ["Blockbusters", "Date Night", "Family Movies", "Totally Custom"],
  stream: ["Loved & Acclaimed", "Date Night", "Everyday Favourites", "Nominees & Awards", "Totally Custom"],
};

/** The raw navigation freshApp does, with no opinion on config.js — cas317.spec.mjs needs this bare, since
 * it registers its own config.js/esm.sh routes and a route added later always wins over one added earlier. */
export async function gotoFresh(page){
  await page.goto("/index.html");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html");
  // MOVIES and friends are top-level `const` in a classic script, so they live in the global LEXICAL scope and
  // are NOT properties of window — `window.MOVIES` is undefined while a bare `MOVIES` resolves fine. Worth
  // knowing before writing any page.evaluate against this app; it cost a run to learn.
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  return page;
}

/** A first-run app with nothing remembered — the splash, every time. */
export async function freshApp(page){
  // CAS-317: config.js is now a real, committed file carrying production Supabase credentials (that's
  // the ticket's whole point) — but the suite must stay guest-mode and network-free, exactly as it was
  // when config.js didn't exist, or every test would start hitting the live project. Only cas317.spec.mjs
  // opts back in, with a fake config + fake Supabase client of its own (via gotoFresh, above).
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  return gotoFresh(page);
}

/** Read the integer out of a "28 films match right now" / "Continue · 28 films" style string. */
export const numberIn = s => {
  const m = String(s == null ? "" : s).replace(/,/g, "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

/** CAS-911: click through the splash and the v2 sequence's own opening questions (cinema, rent),
 * then straight through every free-standing screen in between (the two agent reveals, styles, budget,
 * ages), answering "No" to partner and kids so v2_date/v2_family skip themselves — landing on
 * "v2_services", the same relative point in the flow "services" (S4) used to be the old sequence's
 * first counted step. Kept the name from the old flow's shortlist-of-agents screen this replaces;
 * `kind` only nudges the cinema question now, since every roster this builds is a MIX of agents —
 * there is no lane left to choose. */
export async function toShortlist(page, kind){
  await freshApp(page);
  await page.locator("#splashCta").click();
  // CAS-1018: scoped to #onbStepInner, not a bare ".obhd" — gotoStep's dual-pane slide leaves the
  // outgoing step's .obhd in the DOM alongside the incoming one for the length of the transition
  // (intentional, see gotoStep's own comment), and #onbStepInner is the id it moves onto the
  // incoming pane immediately, so this always resolves to exactly one element.
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Cascade finds your movies for you.");   // v2_about (CAS-953)
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Massive Movies");   // v2_intro
  await ctaLocator(page).click();
  await page.waitForTimeout(120);              // the flow slides between steps
  await expect(page.locator("#obCinemaOpts")).toBeVisible();             // v2_cinema
  await page.locator(`#obCinemaOpts .obopt[data-val="${kind === "stream" ? "no" : "yes"}"]`).click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#obRentOpts")).toBeVisible();               // v2_rent
  await page.locator('#obRentOpts .obopt[data-val="yes"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  for(const marker of ["v2_massive", "v2_handoff", "v2_styles", "v2_budget", "v2_ages", "v2_favs"]){
    await ctaLocator(page).click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator("#obPartnerOpts")).toBeVisible();            // v2_partner
  await page.locator('#obPartnerOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#obKidsOpts")).toBeVisible();               // v2_kids — v2_date skipped
  await page.locator('#obKidsOpts .obopt[data-val="no"]').click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);                                       // v2_family skipped
  await expect(page.locator("#obSvcStores")).toBeVisible();              // v2_services
}

/** Every card on the shortlist, as {name, countText, count}. */
export async function shortlistCards(page){
  return page.locator(".scard").evaluateAll(cards => cards.map(c => ({
    name: (c.querySelector(".sc-name")?.textContent || "").replace(/RECOMMENDED/, "").trim(),
    countText: (c.querySelector(".sc-match")?.textContent || "").trim(),
  })));
}

/** Tap the shortlist card whose title starts with `name`, landing on Mission. */
export async function pickCard(page, name){
  const card = page.locator(".scard", { has: page.locator(".sc-name", { hasText: name }) }).first();
  await card.click();
  await expect(page.locator(".osh", { hasText: "Mission" })).toBeVisible();
}

/** The step's own live count, read from the mirror above the controls. */
export const topCount = page => page.locator(".oscount").first().textContent().then(numberIn);

/** Whichever Continue is on screen — the flow's fixed bar, or a preview's own footer button. */
export function ctaLocator(page){
  return page.locator("#flowCta:visible, #onbStepCta:visible").first();
}
export const ctaCount = page => ctaLocator(page).textContent().then(numberIn);

/** Press Continue until the flow ends, landing on the membership page. CAS-911: this now walks
 * v2_services → v2_done (the roster commits here) → membership — generic enough that no step name
 * needs to be known here. Returns the membership recap's own "worth your time" count (`.membhaul .cnt`),
 * a roster-wide figure read off onbFlow.workingAgents, whichever generator committed it. */
export async function finishFlow(page){
  for(let i = 0; i < 15; i++){
    const stillInFlow = await page.evaluate(() => flowOn === true);
    if(!stillInFlow) break;
    await ctaLocator(page).click();
    await page.waitForTimeout(120);          // the flow slides between steps
  }
  await expect(page.locator("#membScreen.open")).toBeVisible();
  const reveal = numberIn(await page.locator(".membhaul .cnt").textContent());
  return reveal;
}

/** Close the membership page and land on the new agent's listing, fully streamed in.
 * CAS-976: finishing onboarding is also the tutorial's one automatic trigger point (a fresh account,
 * onboarded, with an agent, having never seen it — exactly what every caller here just built) — so by
 * default this also clears it, Skip-tour, the same way a person impatient to see their own listing would.
 * Every caller except CAS-976's own spec wants the plain, uninterrupted listing; pass
 * { skipTutorial: false } to see the tour as it actually first appears.
 * CAS-1030: membStart() (app_template.html) only proceeds straight to the listing for a guest (or an
 * already signed-in) device — membNeedsEmail() is also true for a device with a REAL (fake or not)
 * Supabase config that hasn't signed in yet, in which case membScreen renders an #membEmail field and
 * membStart() silently no-ops without it (an unfilled/invalid email just sets membEmailError and
 * returns), leaving #membScreen.open forever and hanging every caller's own toBeHidden() wait. Every
 * other spec here runs guest-mode (freshApp's config.js 404 keeps CascadeAuth.enabled false, so
 * #membEmail never renders) — only cas913's own configured-but-signed-out scenario hits this, so
 * filling it here when present costs the other callers nothing. */
export async function toListing(page, opts = {}){
  const { skipTutorial = true } = opts;
  const membEmail = page.locator("#membEmail");
  const needsEmail = await membEmail.count() > 0;
  if(needsEmail) await membEmail.fill("e2e-smoke@example.com");
  await page.locator(".membcta").click();
  // CAS-1056: membStart() now only requests a one-time code (continueWithEmail) — it no longer signs in
  // by itself. The rest happens in the account modal's own #authVerify step (CascadeAuth.openVerify),
  // since the membership screen carries no code-entry UI of its own; a fake client's verifyOtp in these
  // specs accepts any code, so the exact value here doesn't matter.
  if(needsEmail){
    await expect(page.locator("#authVerify")).toBeVisible({ timeout: 30_000 });
    // CAS-1056 AC2: the email alone (just submitted via .membcta above) must not have created a session —
    // only a confirmed code does that.
    expect(await page.evaluate(() => window.CascadeAuth.status)).not.toBe("signed-in");
    await page.locator("#authCode").fill("123456");
    await page.locator("#authVerifyBtn").click();
    await expect(page.locator("#authModal.open")).toBeHidden({ timeout: 30_000 });
    expect(await page.evaluate(() => window.CascadeAuth.status)).toBe("signed-in");
  }
  await expect(page.locator("#membScreen.open")).toBeHidden({ timeout: 30_000 });
  await settleListing(page);
  if(skipTutorial){
    const tour = page.locator("#tutScrim.open");
    // maybeStartTutorial() (already called synchronously above, inside membStartWork) schedules the
    // actual open via requestAnimationFrame(()=>requestAnimationFrame(startTutorial)) — a fixed
    // millisecond wait here is a guess at how long two real frames take and can race a slow/loaded
    // headless webkit. Registering our own double rAF now lands after the app's, since callbacks
    // queued earlier in the same frame always run first, so this reliably observes the tour's own
    // open (or its absence) rather than guessing at a timeout.
    if(await tour.count() === 0){
      await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
    }
    if(await tour.count() > 0){
      await page.locator("#tutSkipBtn").click();
      await expect(page.locator("#tutScrim")).not.toHaveClass(/open/);
    }
  }
}

/** The listing streams its cards in batches, so wait for the count to stop moving. */
export async function settleListing(page){
  await page.waitForFunction(() => {
    const g = document.querySelectorAll("#groups .group").length;
    return g > 0 || document.querySelector("#groups .emptyres, #groups .empty");
  }, null, { timeout: 30_000 });
  let last = -1;
  for(let i = 0; i < 60; i++){
    const n = await page.locator("#groups .card, #groups .stub").count();
    if(n === last) return n;
    last = n;
    await page.waitForTimeout(250);
  }
  return last;
}

/** CAS-1084: shared boot for specs that fake a sign-in to an account which already holds an agent, so the
 * fixture (invites/friends/whatever) loads via the app's own real 'cascade-auth-change' event instead of a
 * hand-set CascadeAuth object (which never fires it). This is the exact route CAS-740's own AC4 test
 * (smoke.spec.mjs) proves works: splashGo() always calls flowStart() with no idea yet whether the device is
 * signed in, so a fake getSession() that doesn't resolve until the test calls it explicitly reproduces that
 * ordering deterministically — landing on v2_about ("Cascade finds your movies for you.", #onbStepInner
 * .obhd) first, then afterSignIn() exits the wizard once the (fake, resolved) session says the account
 * already has agents. Replaces three specs' former local bootSignedIn copies, each of which instead waited
 * on `#obWho` — a v1 "who's watching" onboarding screen the v2 rework deleted outright (zero hits left in
 * app_template.html), which is why they'd hang until timeout.
 *
 * `resolveFnName` is the window-global each spec's own fake supabase-js script parks its getSession
 * resolver on (e.g. "__cas886ResolveSession") — a real `window.X = ...` assignment, so plain property
 * lookup reaches it. `readyFlagExpr`, given when a caller also needs to wait on the fixture actually
 * landing, is a page-context boolean expression string (e.g. "typeof invitesReady !== 'undefined' &&
 * invitesReady === true") rather than a bare flag name: like MOVIES (see gotoFresh above), invitesReady/
 * friendsReady are top-level `let`s in app_template.html's classic script, not window properties, so
 * `window[name]` can't reach them — only a real expression evaluated in page scope can. */
export async function bootAlreadySignedIn(page, { supabaseScript, resolveFnName, readyFlagExpr }){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: supabaseScript,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);
  await page.locator("#splashCta").click();
  // splashGo() always starts the wizard (flowStart()) before the (deferred, async) auth module has had any
  // chance to answer whether this device is signed in — mirrors CAS-740 AC4's own first assertion after
  // this same click (smoke.spec.mjs).
  await expect(page.locator("#onbStepInner .obhd")).toContainText("Cascade finds your movies for you.");   // v2_about (CAS-953)
  await page.evaluate(name => window[name](), resolveFnName);
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 5000 });
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  if(readyFlagExpr) await page.waitForFunction(readyFlagExpr, null, { timeout: 5000 });
}

/** CAS-1126: "Where & when you'll watch" left the top menu for the new Settings screen — reach it via
 * Menu -> Settings -> the row, matching how a person actually gets there now. */
export async function openWhereWhenScreen(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Settings" }).click();
  await page.locator("#settingsScreen .urow", { hasText: "Service tracking" }).click();
}
/** Back out of Where & when — which (CAS-1126) now resumes Settings rather than just closing, since
 * that's where this test opened it from — then back out of Settings too, landing on the listing
 * underneath both, the same two taps a person would make. */
export async function closeWhereWhenScreen(page){
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator("#wwScreen")).not.toHaveClass(/open/);
  await page.locator("#settingsScreen .osback").click();
  await expect(page.locator("#settingsScreen")).not.toHaveClass(/open/);
}
/** CAS-1126: "My services" left the top menu for the new Settings screen too. */
export async function openMyServicesScreen(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Settings" }).click();
  await page.locator("#settingsScreen .urow", { hasText: "My services" }).click();
}
/** Back out of My services (its onbStep frame) then out of the Settings screen it resumes to (CAS-1126). */
export async function closeMyServicesScreen(page){
  await page.locator("#onbStep .osback").click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await page.locator("#settingsScreen .osback").click();
  await expect(page.locator("#settingsScreen")).not.toHaveClass(/open/);
}

/** The listing's section headers, as {window, count}. */
export function sectionCounts(page){
  return page.locator("#groups .group").evaluateAll(gs => gs.map(g => ({
    window: g.dataset.g,
    count: Number((g.querySelector(".gcount")?.textContent || "0").trim()),
  })));
}
