// CAS-1141: tests/rls/matrix.mjs's parsing/verdict logic, unit-tested without the network.
// Importing matrix.mjs here must never hit the live project — guarded by the isMain check at
// the bottom of that file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_READ, parsePublicReadTables, checkPublicReadConsistency, selectVerdict } from './matrix.mjs';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const schemaSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');

test('parsePublicReadTables finds exactly app_config in the real schema', () => {
  assert.deepStrictEqual(parsePublicReadTables(schemaSrc), new Set(['app_config']));
});

test('PUBLIC_READ matches the real schema (no silent anon-read table)', () => {
  assert.deepStrictEqual(checkPublicReadConsistency(parsePublicReadTables(schemaSrc), PUBLIC_READ), []);
});

test('selectVerdict: a public table whose SELECT succeeds verdicts PASS', () => {
  const result = selectVerdict('app_config', 1, new Set(['app_config']));
  assert.equal(result.verdict, 'PASS');
});

test('selectVerdict: a public table whose SELECT is rejected verdicts FAIL', () => {
  const result = selectVerdict('app_config', 0, new Set(['app_config']));
  assert.equal(result.verdict, 'FAIL');
});

test('selectVerdict: a non-public table whose SELECT returns rows verdicts FAIL', () => {
  const result = selectVerdict('cascades', 3, new Set(['app_config']));
  assert.equal(result.verdict, 'FAIL');
});

test('selectVerdict: a non-public table whose SELECT returns no rows verdicts PASS', () => {
  const result = selectVerdict('cascades', 0, new Set(['app_config']));
  assert.equal(result.verdict, 'PASS');
});

test('checkPublicReadConsistency: an undeclared anon-select table is reported', () => {
  const errors = checkPublicReadConsistency(new Set(['app_config', 'rogue_table']), new Set(['app_config']));
  assert.deepStrictEqual(errors, ['app_config_read-style policy on rogue_table is not in PUBLIC_READ']);
});

test('checkPublicReadConsistency: a PUBLIC_READ table missing its policy is reported', () => {
  const errors = checkPublicReadConsistency(new Set(['app_config']), new Set(['app_config', 'ghost_table']));
  assert.deepStrictEqual(errors, ['PUBLIC_READ names ghost_table which has no anon select policy']);
});
