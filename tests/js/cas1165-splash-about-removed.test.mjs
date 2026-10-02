// CAS-1165: the splash's third door, "What is Cascade?", and the public #aboutPage it opened are retired.
// The data credits it carried move into renderAbout()'s signed-in screen; the signed-out route to Contact us
// moves onto the sign-in sheet (#authModal) instead. These pin AC1 to AC5 directly against the BUILT
// index.html, not app_template.html, since that is what a device actually loads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const count = (re) => (html.match(re) || []).length;

test("CAS-1165 AC1: #splashAbout and #aboutPage are gone", () => {
  assert.equal(count(/id="splashAbout"/g), 0, 'id="splashAbout" should not appear in index.html');
  assert.equal(count(/id="aboutPage"/g), 0, 'id="aboutPage" should not appear in index.html');
});

test("CAS-1165 AC2: the splash_about analytics event is gone", () => {
  assert.equal(count(/splash_about/g), 0, '"splash_about" should not appear in index.html');
});

test("CAS-1165 AC3: renderAbout() carries the data credits, same wording as the retired page", () => {
  const start = html.indexOf("function renderAbout(");
  assert.ok(start >= 0, "renderAbout() not found in index.html");
  const end = html.indexOf("window.openAbout", start);
  assert.ok(end > start, "could not bound renderAbout()'s source");
  const block = html.slice(start, end);
  assert.match(block, /id="aboutCredits"/);
  for (const needle of [
    "not endorsed or certified by TMDB",
    "https://www.themoviedb.org",
    "https://api.watchmode.com",
    "https://www.justwatch.com",
    "does not play or host video",
  ]) {
    assert.ok(block.includes(needle), `renderAbout() is missing "${needle}"`);
  }
});

test("CAS-1165 AC4: #authContact and #authVerifyContact each appear exactly once, both inside #authModal", () => {
  assert.equal(count(/id="authContact"/g), 1, 'id="authContact" should appear exactly once');
  assert.equal(count(/id="authVerifyContact"/g), 1, 'id="authVerifyContact" should appear exactly once');

  const modalStart = html.indexOf('id="authModal"');
  assert.ok(modalStart >= 0, "#authModal not found in index.html");
  // #authModal is a top-level sibling .modal; the next "<div class=\"modal\" id=" after it opens the next one.
  const nextModal = html.indexOf('<div class="modal" id="', modalStart + 1);
  assert.ok(nextModal > modalStart, "could not bound #authModal's markup");
  const modalBlock = html.slice(modalStart, nextModal);
  assert.match(modalBlock, /id="authContact"/);
  assert.match(modalBlock, /id="authVerifyContact"/);
});

test("CAS-1165 AC5: every CSS rule used only by the retired About page is gone", () => {
  assert.equal(count(/\.splashabout|\.abwin|\.abnote|\.abfoot|\.abclose/g), 0,
    "a CSS rule belonging only to the retired splash door / About page still appears in index.html");
});
