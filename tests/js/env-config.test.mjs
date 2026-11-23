// CAS-1521: config.js picks the Supabase project by hostname, then window.CASCADE_ENV, else staging.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
const PROD = "ypccfyatejejslzlfrbf", STAGING = "oenvezqluwqdwlzfhisc";

function load(hostname, env){
  const window = {};
  if(env !== undefined) window.CASCADE_ENV = env;
  vm.runInNewContext(SRC, { window, location: { hostname } });
  return window.CASCADE_CONFIG;
}

test("cascademovies.com resolves to production", () => {
  for(const h of ["cascademovies.com", "www.cascademovies.com"]){
    const c = load(h);
    assert.equal(c.ENV, "production");
    assert.ok(c.SUPABASE_URL.includes(PROD));
  }
});
test("pages.dev previews and localhost resolve to staging", () => {
  for(const h of ["cascade-web-3x1.pages.dev", "main.cascade-web-3x1.pages.dev", "localhost"]){
    const c = load(h);
    assert.equal(c.ENV, "staging");
    assert.ok(c.SUPABASE_URL.includes(STAGING));
  }
});
test("window.CASCADE_ENV=production resolves to production off-host", () => {
  const c = load("localhost", "production");
  assert.equal(c.ENV, "production");
  assert.ok(c.SUPABASE_URL.includes(PROD));
});
test("hostname wins over CASCADE_ENV; unknown CASCADE_ENV falls back to staging", () => {
  assert.equal(load("cascademovies.com", "staging").ENV, "production");
  assert.equal(load("localhost", "bogus").ENV, "staging");
});
test("each environment's anon key belongs to its own project and is not a service_role key", () => {
  for(const [h, ref] of [["cascademovies.com", PROD], ["localhost", STAGING]]){
    const c = load(h);
    const payload = JSON.parse(Buffer.from(c.SUPABASE_ANON_KEY.split(".")[1], "base64url").toString());
    assert.equal(payload.ref, ref);
    assert.equal(payload.role, "anon");
  }
});
