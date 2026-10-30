// Runs the real CLI against live sites (network required). Run with: npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIELDS } from '../lib.mjs';

const runCli = (args) => new Promise((resolve) => {
  execFile('node', ['trip-deals.mjs', ...args], { timeout: 580000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
});

test('e2e: live run collects, filters, dedupes and sorts open items', { timeout: 600000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'td-'));
  const out = join(dir, 'results.json');
  const report = join(dir, 'RESULTS.md');
  const { code, stdout, stderr } = await runCli(['--out', out, '--report', report]);
  assert.equal(code, 0, `CLI failed: ${stderr}`);
  assert.match(stdout, /^closes\s+type/m, 'prints a table');
  const data = JSON.parse(await readFile(out, 'utf8'));
  const now = Date.parse(data.generatedAt);

  const ok = Object.entries(data.status).filter(([, s]) => s.ok && s.count > 0);
  assert.ok(ok.length >= 3, `expected >=3 working sources, got ${JSON.stringify(data.status)}`);
  for (const [n, s] of Object.entries(data.status)) if (!s.ok) console.warn(`source ${n}: ${s.error}`);
  for (const p of data.probes) {
    assert.ok(p.ok || p.error, `probe ${p.name} has no outcome`);
    if (!p.ok) assert.ok(p.blocked || p.disallowed || /HTTP|network/.test(p.error), `probe ${p.name} unexplained failure`);
  }
  assert.ok(data.probes.some((p) => p.disallowed && /google/.test(p.url)), 'Google Flights search must not be fetched (robots.txt)');

  assert.ok(data.results.length >= 3, `expected >=3 open items, got ${data.results.length}`);
  for (const r of data.results) {
    for (const f of FIELDS) assert.ok(f in r, `${r.title}: missing ${f}`);
    assert.ok(['competition', 'sale', 'points'].includes(r.type), `bad type ${r.type}`);
    assert.ok(r.title && r.destination && r.tier, `incomplete row ${JSON.stringify(r)}`);
    assert.match(r.url, /^https:\/\//);
    assert.ok(!r.closesAt || Date.parse(r.closesAt) >= now, `expired item kept: ${r.title} ${r.closesAt}`);
    assert.notEqual(r.eligible, false, `ineligible item kept: ${r.title}`);
    assert.notEqual(r.travelWindowFit, 'no', `wrong travel window kept: ${r.title}`);
    assert.ok(!Number.isNaN(Date.parse(r.fetchedAt)));
  }
  const t = data.results.map((r) => (r.closesAt ? Date.parse(r.closesAt) : Infinity));
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1] <= t[i], 'not sorted by closing date');
  const keys = data.results.map((r) => `${r.type}|${r.title.toLowerCase()}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate rows');
  assert.ok(data.results.some((r) => r.type === 'competition'), 'no competitions found');
  assert.ok(data.results.some((r) => r.type !== 'competition'), 'no sales/points found');
  for (const x of data.excluded) assert.ok(x.excludedBecause, 'excluded item without reason');

  const md = await readFile(report, 'utf8');
  for (const r of data.results) assert.ok(md.includes(r.url), `report missing link for ${r.title}`);
  assert.match(md, /## Sources/);
});

test('e2e: bad arguments exit with code 2', async () => {
  assert.equal((await runCli(['--sources', 'not-a-source'])).code, 2);
  assert.equal((await runCli(['--now', 'next-tuesday'])).code, 2);
});
