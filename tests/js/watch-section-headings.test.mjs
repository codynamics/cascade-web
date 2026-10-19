// CAS-1257: watchGroupHeading's own section-heading table. On a Home stage (stream/rent/premium) the
// stage's own section is headed with the stage's name, exactly as its button reads (WATCH_TAB_LABEL);
// an earlier-stage section — films tagged for this stage that have not arrived yet — reads
// "<where they are now>, tagged for <this stage>". The Cinema tab (in_cinema) is unchanged: every
// section keeps its plain STATUS_LABEL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const E = loadEngine();

test("CAS-1257 AC2: watchGroupHeading returns the exact heading for every stage/section pair", () => {
  const savedTab = E.watchTab;
  const cases = [
    ["stream", "included_streaming", "Streaming"],
    ["stream", "upcoming", "Upcoming, tagged for Streaming"],
    ["stream", "in_cinema", "In cinema now, tagged for Streaming"],
    ["stream", "opening_week", "In cinema now, tagged for Streaming"],
    ["stream", "rental", "Rental, tagged for Streaming"],
    ["rent", "rental", "Rental"],
    ["rent", "upcoming", "Upcoming, tagged for Rental"],
    ["rent", "in_cinema", "In cinema now, tagged for Rental"],
    ["premium", "pvod", "Premium"],
    ["premium", "in_cinema", "In cinema now, tagged for Premium"],
    ["in_cinema", "upcoming", "Upcoming"],
    ["in_cinema", "in_cinema", "In Cinema"],
    ["in_cinema", "opening_week", "In Cinema · Opening week"],
  ];
  try{
    cases.forEach(([tab, section, heading]) => {
      E.setWatchTab(tab);
      assert.equal(E.watchGroupHeading(section), heading,
        `AC2: stage "${tab}", section "${section}" must read "${heading}"`);
    });
  } finally{
    E.setWatchTab(savedTab);
  }
});

test("CAS-1257 AC3: the built index.html carries the exact landing/heading markup this ticket specifies", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const count = (re) => (html.match(re) || []).length;

  // CAS-1309: the first-child-not-early hiding rule is gone — every stage section heading shows now,
  // including the first, on every stage (not just an early-tagged one).
  assert.equal(count(/#groups > \.group:first-child:not\(\.early\) > \.grouphead:not\(\.sub\)\{display:none\}/g), 0,
    "CAS-1309: the first-child-not-early hiding CSS rule must be gone");
  assert.equal(count(/#groups > \.group:first-child > \.grouphead:not\(\.sub\)\{display:none\}/g), 0,
    "AC3: the old first-child CSS rule (without :not(.early)) must be gone");
  assert.equal(count(/function landWatchList\(\)\{/g), 1, "AC3: landWatchList() must be defined exactly once");
  // CAS-1280 widened this call count from CAS-1257's original 2 (setWatchTab, setWatchStage) to 5 —
  // scrollWatchListingToTop(), onboarding's finish, and the account fan-out's late re-land now land by
  // the same rule too, rather than always jumping to the first section or the very top.
  assert.equal(count(/landWatchList\(\);/g), 5, "AC3: landWatchList() must be called exactly five times");
  assert.equal(count(/jumpToSection\(WATCH_TAB_SCROLL_TARGET\[key\]\);/g), 0,
    "AC3: the retired jumpToSection(WATCH_TAB_SCROLL_TARGET[key]) call must be gone");
});
