// Runs the real CLI against live sites. Needs network + Chromium. Run with: npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runCli = (args) => new Promise((resolve) => {
  execFile('node', ['hotel-prices.mjs', ...args], { timeout: 280000 }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('e2e: live run returns valid, sorted AUD prices for the target date', { timeout: 300000 }, async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'hp-')), 'prices.json');
  const { code, stderr } = await runCli(['--checkin', '2026-10-28', '--nights', '1', '--adults', '2', '--out', out]);
  assert.equal(code, 0, `CLI failed: ${stderr}`);
  const data = JSON.parse(await readFile(out, 'utf8'));

  assert.equal(data.query.checkout, '2026-10-29');
  assert.ok(Object.values(data.status).some((s) => s.ok), 'at least one source must succeed');
  for (const [name, s] of Object.entries(data.status)) {
    if (!s.ok) console.warn(`source ${name} ${s.blocked ? 'blocked' : 'failed'}: ${s.error}`);
  }
  const priced = data.results.filter((r) => r.priceAud != null);
  assert.ok(priced.length >= 5, `expected >=5 priced results, got ${priced.length}`);
  for (const r of priced) assert.ok(r.priceAud > 20 && r.priceAud < 5000, `implausible price ${r.priceAud} for ${r.name}`);
  for (let i = 1; i < priced.length; i++) assert.ok(priced[i - 1].priceAud <= priced[i].priceAud, 'not sorted');
  const keys = data.results.map((r) => `${r.source}|${r.name.toLowerCase()}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate rows');
  assert.ok(data.target.length >= 1, 'target hotel (Bay View Villas) not found');
});

test('e2e: bad arguments exit with code 2', async () => {
  const { code } = await runCli(['--checkin', 'next-tuesday']);
  assert.equal(code, 2);
});
