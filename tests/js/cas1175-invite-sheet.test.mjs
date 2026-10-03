// CAS-1175 AC4-6: three build-artifact checks against the built index.html itself — the removed footer
// line, the Note label/placeholder swap, and inviteUrlFor's cascademovies.com fallback literal. Grep-level
// (like the ticket's own acceptance criteria), not a DOM render, since these are checks on what the build
// actually shipped rather than on any one decision.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

function countOf(needle){
  let n = 0, i = 0;
  while((i = html.indexOf(needle, i)) !== -1){ n++; i += needle.length; }
  return n;
}

test("CAS-1175 AC4: the removed footer line is gone from index.html", () => {
  assert.equal(countOf("Email sends straight from Cascade"), 0);
});

test("CAS-1175 AC5: the old 'Add a note (optional)' placeholder is gone, 'Note (optional)' label is present", () => {
  assert.equal(countOf('placeholder="Add a note (optional)"'), 0);
  assert.ok(countOf("Note (optional)") >= 1);
});

test("CAS-1175 AC6: inviteUrlFor's cascademovies.com fallback literal is in index.html", () => {
  assert.ok(html.includes("https://cascademovies.com/"));
});
