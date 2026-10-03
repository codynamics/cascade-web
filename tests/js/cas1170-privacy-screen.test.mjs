// CAS-1170: the privacy policy opens inside Cascade as #privacyScreen, in Cascade's own look, instead of
// the external company-site page. These pin AC1 to AC3 directly against the BUILT index.html, not
// app_template.html, since that is what a device actually loads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const count = (needleOrRe) =>
  typeof needleOrRe === "string"
    ? html.split(needleOrRe).length - 1
    : (html.match(needleOrRe) || []).length;

test("CAS-1170 AC1: no more external privacy link, and Support is untouched", () => {
  assert.equal(count("codynamics.com.au/privacy"), 0);
  assert.equal(count("https://www.codynamics.com.au/support"), 1);
});

test("CAS-1170 AC2: #privacyScreen exists exactly once", () => {
  assert.equal(count('id="privacyScreen"'), 1);
});

test("CAS-1170 AC3: the policy text, word for word, is in the built page", () => {
  for (const needle of [
    "Last updated 25 September 2026",
    "ABN 28 135 826 809",
    "We do not sell your information",
    "Cascade is not directed at children under 13",
    "Menu → Account → Delete account",
    "we will update this page and its date",
  ]) {
    assert.ok(count(needle) >= 1, `index.html is missing "${needle}"`);
  }
});

test("CAS-1170: the two entry points on #membScreen's email step call openPrivacy('membership'), not an external link", () => {
  assert.equal(count("openPrivacy('membership')"), 2);
});

test("CAS-1170: the About screen's Legal card opens Privacy in-app via openPrivacy('about')", () => {
  assert.equal(count("openPrivacy('about')"), 1);
});
