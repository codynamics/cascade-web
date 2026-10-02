// CAS-1168: the membership screen shows the price and reads as a membership sign-up again (reverses
// CAS-1069's copy change on this screen only, Lee, 3 Oct 2026). MEMBERSHIP_ENABLED stays false. These pin
// AC1 to AC4 directly against the BUILT index.html, not app_template.html, since that is what a device
// actually loads.
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

test("CAS-1168 AC1: the restored price paragraph appears on both #membScreen paths", () => {
  assert.equal(
    count("Free for your first month · then <b>$4.99/month</b> · cancel any time. No card needed"),
    2,
  );
});

test("CAS-1168 AC2: the .membcta button reads 'Start my free month' on both paths", () => {
  assert.equal(count(">Start my free month</button>"), 2);
});

test("CAS-1168 AC3: the retired 'Save my agents' copy is gone", () => {
  assert.equal(count(/Save my agents|Saving your agents|keep working for you and sync across your devices/g), 0);
});

test("CAS-1168 AC4: no 'Prototype' line, and MEMBERSHIP_ENABLED stays false", () => {
  assert.equal(count(/membproto/gi), 0);
  assert.equal(count("const MEMBERSHIP_ENABLED = false;"), 1);
});
