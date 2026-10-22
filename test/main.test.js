import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, parseCsv, readVerifyFile, run } from '../src/main.js';

const fixture = new URL('./fixtures/suppliers.csv', import.meta.url).pathname;

function setup(inputs) {
  const dir = mkdtempSync(join(tmpdir(), 'gea-action-'));
  const env = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
  writeFileSync(env.GITHUB_OUTPUT, '');
  writeFileSync(env.GITHUB_STEP_SUMMARY, '');
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const lines = [];
  const log = createLogger(env, (s) => lines.push(s));
  return { env, log, lines, summary: () => readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), outputFile: () => readFileSync(env.GITHUB_OUTPUT, 'utf8') };
}

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body = {} } = await handler(new URL(url), init, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

test('parseCsv handles quotes, semicolons, BOM, CRLF, blanks and comments', () => {
  const rows = parseCsv('\uFEFFtype;country;number\r\n# comment\r\n\r\nvat;DK;"2275,6214"\nlei;;"a ""b"""');
  assert.deepEqual(rows, [['type', 'country', 'number'], ['vat', 'DK', '2275,6214'], ['lei', '', 'a "b"']]);
});

test('readVerifyFile maps columns and defaults type to vat', () => {
  const rows = readVerifyFile(fixture);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { line: 2, type: 'vat', country: 'DK', number: '22756214', name: 'A.P. Møller - Mærsk' });
  assert.equal(rows[2].type, 'eori');
});

test('verify sends key and query, sets outputs and summary', async () => {
  const s = setup({ 'API-KEY': 'gea_live_secret', OPERATION: 'verify', TYPE: 'VAT', COUNTRY: 'DK', NUMBER: '22756214' });
  const fetchImpl = mockFetch(() => ({ body: { ok: true, valid: true, input: 'DK22756214', name: 'A.P. MØLLER - MÆRSK A/S', address: 'Esplanaden 50 | 1263', source: 'EU VIES' } }));
  const code = await run({ env: s.env, fetchImpl, log: s.log, sleep: noSleep });
  assert.equal(code, 0);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.pathname, '/api/verify');
  assert.equal(url.searchParams.get('type'), 'vat');
  assert.equal(url.searchParams.get('number'), '22756214');
  assert.equal(init.headers['x-api-key'], 'gea_live_secret');
  assert.equal(s.log.outputs.valid, 'true');
  assert.equal(s.log.outputs.name, 'A.P. MØLLER - MÆRSK A/S');
  assert.match(s.outputFile(), /^valid<<ghadelimiter_[0-9a-f-]+\ntrue\n/);
  assert.match(s.summary(), /Esplanaden 50 \\\| 1263/);
  assert.ok(s.lines.includes('::add-mask::gea_live_secret\n'));
});

test('verify fails on invalid number by default, passes when fail-on-invalid=false', async () => {
  const fetchImpl = mockFetch(() => ({ body: { ok: true, valid: false, input: 'DK1' } }));
  let s = setup({ 'API-KEY': 'k', NUMBER: 'DK1' });
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log }), 1);
  assert.equal(s.log.outputs.valid, 'false');
  s = setup({ 'API-KEY': 'k', NUMBER: 'DK1', 'FAIL-ON-INVALID': 'false' });
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log }), 0);
});

test('unknown validity warns, or fails with fail-on-unknown', async () => {
  const fetchImpl = mockFetch(() => ({ body: { ok: true, valid: null, message: 'VIES down' } }));
  let s = setup({ 'API-KEY': 'k', NUMBER: 'DK1' });
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log }), 0);
  assert.ok(s.lines.some((l) => l.startsWith('::warning::VIES down')));
  s = setup({ 'API-KEY': 'k', NUMBER: 'DK1', 'FAIL-ON-UNKNOWN': 'true' });
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log }), 1);
});

test('401 gives a clear error', async () => {
  const s = setup({ 'API-KEY': 'bad', NUMBER: 'DK1' });
  const fetchImpl = mockFetch(() => ({ status: 401, body: { ok: false, message: 'Missing or invalid API key.' } }));
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log }), 1);
  assert.ok(s.lines.some((l) => l.startsWith('::error::GlobalEntity API rejected the API key')));
});

test('retries 5xx then succeeds', async () => {
  const s = setup({ 'API-KEY': 'k', NUMBER: 'DK1' });
  const fetchImpl = mockFetch((_u, _i, n) => (n === 1 ? { status: 503 } : { body: { valid: true } }));
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log, sleep: noSleep }), 0);
  assert.equal(fetchImpl.calls.length, 2);
});

test('missing api-key and bad operation are rejected', async () => {
  let s = setup({ NUMBER: 'DK1' });
  assert.equal(await run({ env: s.env, fetchImpl: mockFetch(() => ({})), log: s.log }), 1);
  assert.ok(s.lines.some((l) => l.includes('api-key')));
  s = setup({ 'API-KEY': 'k', OPERATION: 'nope' });
  assert.equal(await run({ env: s.env, fetchImpl: mockFetch(() => ({})), log: s.log }), 1);
});

test('verify-file checks every row and reports invalid lines', async () => {
  const s = setup({ 'API-KEY': 'k', OPERATION: 'verify-file', FILE: fixture });
  const fetchImpl = mockFetch((url) => {
    const n = url.searchParams.get('number');
    if (n === '22756214') return { body: { valid: true, name: 'MAERSK' } };
    if (n === 'NL000000000B01') return { body: { valid: false } };
    return { body: { valid: null, message: 'EOS timeout' } };
  });
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log, sleep: noSleep }), 1);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(s.log.outputs.count, '3');
  assert.equal(s.log.outputs['invalid-count'], '1');
  assert.equal(s.log.outputs['unknown-count'], '1');
  assert.equal(s.log.outputs.valid, 'false');
  assert.ok(s.lines.some((l) => l.includes('line 3: VAT NL000000000B01 is invalid')));
  assert.match(s.summary(), /\*\*3\*\* checked/);
});

test('search returns count and first match', async () => {
  const s = setup({ 'API-KEY': 'k', OPERATION: 'search', COUNTRY: 'Norway', QUERY: 'Intermediary' });
  const fetchImpl = mockFetch(() => ({ body: { mode: 'live', country: 'Norway', results: [{ name: 'Intermediary AS', orgNr: '925615471', status: 'Active', address: 'Stavanger' }] } }));
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log }), 0);
  assert.equal(fetchImpl.calls[0].url.searchParams.get('q'), 'Intermediary');
  assert.equal(s.log.outputs.count, '1');
  assert.equal(s.log.outputs.name, 'Intermediary AS');
});

test('resolve posts JSON body and exposes entity id and trust score', async () => {
  const s = setup({ 'API-KEY': 'k', OPERATION: 'resolve', COUNTRY: 'DK', NUMBER: '22756214' });
  const fetchImpl = mockFetch(() => ({ body: { entityId: 'COM-1567B4077A', trust: { score: 95, band: 'high' }, names: [{ value: 'A.P. Moller - Maersk A/S' }] } }));
  assert.equal(await run({ env: s.env, fetchImpl, log: s.log }), 0);
  const { init } = fetchImpl.calls[0];
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { country: 'DK', orgNr: '22756214' });
  assert.equal(s.log.outputs['entity-id'], 'COM-1567B4077A');
  assert.equal(s.log.outputs['trust-score'], '95');
  assert.equal(s.log.outputs.name, 'A.P. Moller - Maersk A/S');
});
