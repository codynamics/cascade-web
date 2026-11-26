// tests/js/cas1573-csp-origins.test.mjs — CAS-1573: every origin the app talks to at runtime must be in
// connect-src of every Content-Security-Policy the build produces. On 25 Nov 2026 staging sign-up was dead
// ("Failed to fetch") because connect-src listed only the production Supabase host. Origins are read from
// config.js (every environment's SUPABASE_URL) and from the catalogue URLs in app_template.html; the CSP is
// read from the files poc_pipeline.py --build-html just wrote (the engine job builds first).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const origin = (u) => new URL(u).origin;

// Runtime origins: [origin, where it comes from]
export function runtimeOrigins() {
  const out = [];
  for (const m of read('config.js').matchAll(/SUPABASE_URL:\s*"(https:\/\/[^"]+)"/g)) {
    out.push([origin(m[1]), 'config.js SUPABASE_URL']);
  }
  for (const line of read('app_template.html').split('\n')) {
    if (!/CATALOGUE_[A-Z_]*URL\s*=|catalogueFileUrl\s*=/.test(line)) continue;
    for (const m of line.matchAll(/https:\/\/[a-zA-Z0-9.-]+/g)) {
      out.push([origin(m[0]), 'app_template.html catalogue URL']);
    }
  }
  return out;
}

// Returns one message per origin missing from connect-src.
export function missingFromConnectSrc(csp, origins, file) {
  const m = csp.match(/connect-src ([^;]+)/);
  const sources = m ? m[1].split(/\s+/) : [];
  return [...new Set(origins.map(([o, from]) => `${o}|${from}`))]
    .map((k) => k.split('|'))
    .filter(([o]) => !sources.includes(o))
    .map(([o, from]) => `${file}: connect-src is missing ${o} (needed by ${from})`);
}

function cspFiles() {
  const found = [];
  for (const f of ['_headers', 'index.html', 'www/_headers', 'www/index.html']) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const text = read(f);
    const m = text.match(/Content-Security-Policy[^\n]*/i);
    if (m) found.push([f, m[0]]);
  }
  return found;
}

test('CAS-1573: discovers both Supabase hosts and the catalogue origin', () => {
  const hosts = runtimeOrigins().map(([o]) => o);
  assert.ok(hosts.filter((o) => o.endsWith('.supabase.co')).length >= 2, `expected staging + production Supabase hosts, got ${hosts}`);
  assert.ok(hosts.includes('https://cascademovies.com'), `catalogue origin not found: ${hosts}`);
});

test('CAS-1573: _headers carries a CSP', () => {
  assert.ok(cspFiles().some(([f]) => f === '_headers'), '_headers has no Content-Security-Policy');
});

test('CAS-1573: every runtime origin is in connect-src of every generated CSP', () => {
  const origins = runtimeOrigins();
  const problems = cspFiles().flatMap(([f, csp]) => missingFromConnectSrc(csp, origins, f));
  assert.deepEqual(problems, []);
});

test('CAS-1573: the check fails on a CSP without the staging host and passes with both', () => {
  const origins = runtimeOrigins();
  const staging = origins.find(([, from]) => from.startsWith('config.js'))?.[0];
  const all = [...new Set(origins.map(([o]) => o))];
  const stagingHost = all.find((o) => o.includes('oenvezqluwqdwlzfhisc'));
  assert.ok(stagingHost && staging, 'staging host not discovered');
  const without = `default-src 'self'; connect-src 'self' ${all.filter((o) => o !== stagingHost).join(' ')}`;
  const bad = missingFromConnectSrc(without, origins, '_headers');
  assert.equal(bad.length, 1);
  assert.match(bad[0], /_headers: connect-src is missing https:\/\/oenvezqluwqdwlzfhisc\.supabase\.co/);
  assert.deepEqual(missingFromConnectSrc(`connect-src 'self' ${all.join(' ')}`, origins, '_headers'), []);
});
