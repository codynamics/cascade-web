// tests/js/cas1057-csp-headers.test.mjs — CAS-1057: script-src/style-src in the generated _headers
// must allow 'unsafe-inline' and carry no sha256- source. A stale hash blocks the whole app on any
// host that actually serves _headers (the Cloudflare preview hosts) because browsers ignore
// 'unsafe-inline' outright whenever a hash is present alongside it. Parses the file poc_pipeline.py
// --build-html just wrote (the engine job runs the build before this suite), not a re-derivation of
// the generator's logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
const cspLine = headers.split('\n').find((l) => l.includes('Content-Security-Policy:'));

function directive(name) {
  const m = cspLine.match(new RegExp(`${name} ([^;]+)`));
  assert.ok(m, `${name} missing from the generated CSP`);
  return m[1];
}

test('CAS-1057: script-src allows unsafe-inline and carries no sha256- source', () => {
  const src = directive('script-src');
  assert.ok(src.includes("'unsafe-inline'"), `script-src must contain 'unsafe-inline': ${src}`);
  assert.ok(!src.includes('sha256-'), `script-src must carry no sha256- source: ${src}`);
  assert.ok(!src.includes("'unsafe-eval'"), `script-src must not add 'unsafe-eval': ${src}`);
});

test('CAS-1057: style-src allows unsafe-inline and carries no sha256- source', () => {
  const src = directive('style-src');
  assert.ok(src.includes("'unsafe-inline'"), `style-src must contain 'unsafe-inline': ${src}`);
  assert.ok(!src.includes('sha256-'), `style-src must carry no sha256- source: ${src}`);
});
