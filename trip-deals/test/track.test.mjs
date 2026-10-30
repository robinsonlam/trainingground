import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyLedger, addEntry, setStatus, phase, checkBy, due, renderEntries, main } from '../track.mjs';
import { compId, parseDrawDate } from '../lib.mjs';

const NOW = new Date('2026-10-30T09:00:00+11:00');
const results = { results: [
  { type: 'competition', id: 'ozb-979072', title: 'Win a $5000 Holiday Voucher', url: 'https://www.ozbargain.com.au/node/979072', termsUrl: 'https://promo/bp', value: '$5,000', priority: 'A', closesAt: '2026-11-01T23:59:00+11:00', drawAt: null },
  { type: 'competition', id: 'cca-76098', title: 'Win a Trip to London', url: 'https://www.competitions.com.au/x/76098/', priority: 'C', closesAt: '2026-11-30T23:59:00+11:00', drawAt: '2026-12-07T23:59:00+11:00', alsoListedAt: ['https://www.aussiecomps.com/index.php?id=1'] },
  { type: 'competition', id: 'ozb-1', title: 'Win $3000 Flight Centre', url: 'https://www.ozbargain.com.au/node/1', priority: 'A', closesAt: '2026-10-31T23:59:00+11:00' },
  { type: 'competition', id: 'ozb-2', title: 'Win $4000 Flight Centre', url: 'https://www.ozbargain.com.au/node/2', priority: 'A', closesAt: '2026-12-19T23:59:00+11:00' },
] };

test('compId and parseDrawDate', () => {
  assert.equal(compId('https://www.ozbargain.com.au/node/979072'), 'ozb-979072');
  assert.equal(compId('https://www.competitions.com.au/win-trip-two-london/76098/'), 'cca-76098');
  assert.equal(compId('https://www.aussiecomps.com/index.php?id=28370'), 'ac-28370');
  assert.equal(parseDrawDate('Winners will be drawn at random on Monday 9 November 2026 using', NOW).slice(0, 10), '2026-11-09');
  assert.equal(parseDrawDate('The draw will take place on 15 December 2026 at 2pm.', NOW).slice(0, 10), '2026-12-15');
  assert.equal(parseDrawDate('No draw info', NOW), null);
});

test('addEntry snapshots the competition from results and appends repeat entries', () => {
  const l = emptyLedger();
  const e = addEntry(l, results, 'ozb-979072', { by: 'Rob', answer: 'Because...' }, NOW);
  assert.equal(e.title, 'Win a $5000 Holiday Voucher');
  assert.equal(e.termsUrl, 'https://promo/bp');
  addEntry(l, results, 'https://www.ozbargain.com.au/node/979072', { by: 'Sam', at: '2026-10-31' }, NOW);
  assert.equal(l.entries.length, 1, 'same competition by URL is the same ledger row');
  assert.deepEqual(e.entries.map((x) => x.by), ['Rob', 'Sam']);
  assert.equal(addEntry(l, results, 'https://www.aussiecomps.com/index.php?id=1', {}, NOW).id, 'cca-76098', 'alt listing URL resolves');
});

test('addEntry rejects unknown competitions unless given by hand', () => {
  const l = emptyLedger();
  assert.throws(() => addEntry(l, results, 'ozb-404', {}, NOW), (e) => e.exitCode === 2);
  const e = addEntry(l, results, 'manual', { title: 'Radio comp', url: 'https://radio.example/win', closes: '2026-11-20' }, NOW);
  assert.equal(e.id, 'radio-example-win');
  assert.equal(e.closesAt.slice(0, 10), '2026-11-20');
  assert.throws(() => addEntry(l, results, 'ozb-1', { at: 'yesterday-ish' }, NOW), /invalid --at/);
});

test('checkBy: explicit > draw + 7d > close + 14d', () => {
  assert.equal(checkBy({ checkBy: '2027-01-01T00:00:00Z' }), '2027-01-01T00:00:00Z');
  assert.equal(checkBy({ drawAt: '2026-12-07T23:59:00+11:00', closesAt: '2026-11-30T23:59:00+11:00' }).slice(0, 10), '2026-12-14');
  assert.equal(checkBy({ closesAt: '2026-11-01T23:59:00+11:00' }).slice(0, 10), '2026-11-15');
  assert.equal(checkBy({}), null);
});

test('phase walks open -> awaiting -> CHECK, and won/claim deadlines', () => {
  const e = { status: 'entered', closesAt: '2026-11-01T23:59:00+11:00' };
  assert.match(phase(e, NOW).label, /^entered, open/);
  assert.match(phase(e, new Date('2026-11-05T00:00:00Z')).label, /^awaiting result/);
  const late = phase(e, new Date('2026-11-20T00:00:00Z'));
  assert.equal(late.urgent, true);
  assert.match(late.label, /CHECK RESULT/);
  assert.equal(phase({ status: 'won' }, NOW).urgent, true);
  assert.match(phase({ status: 'won', claimBy: '2026-12-30T00:00:00Z' }, NOW).label, /claim by 2026-12-30/);
  assert.equal(phase({ status: 'won', claimBy: '2026-12-30T00:00:00Z' }, NOW).urgent, false);
  assert.match(phase({ status: 'won', claimBy: '2026-10-01T00:00:00Z' }, NOW).label, /passed/);
  assert.equal(phase({ status: 'not-won' }, NOW).urgent, false);
});

test('setStatus validates and records claim deadline', () => {
  const l = emptyLedger();
  addEntry(l, results, 'ozb-1', {}, NOW);
  assert.throws(() => setStatus(l, 'ozb-1', 'maybe', {}, NOW), (e) => e.exitCode === 2);
  assert.throws(() => setStatus(l, 'nope', 'won', {}, NOW), (e) => e.exitCode === 2);
  const e = setStatus(l, 'ozb-1', 'won', { 'claim-by': '2026-12-01', note: 'email from promoter' }, NOW);
  assert.equal(e.claimBy.slice(0, 10), '2026-12-01');
  assert.equal(e.notes[0].text, 'email from promoter');
});

test('due lists urgent follow-ups and unentered A/B comps closing soon', () => {
  const l = emptyLedger();
  addEntry(l, results, 'ozb-979072', {}, NOW);
  const later = new Date('2026-11-20T00:00:00+11:00');
  const d1 = due(l, results, NOW, 3);
  assert.deepEqual(d1.toEnter.map((r) => r.id), ['ozb-1'], 'entered and far-off comps are excluded; C is never suggested');
  assert.equal(d1.followUps.length, 0);
  assert.deepEqual(due(l, results, later, 3).followUps.map((x) => x.e.id), ['ozb-979072']);
});

test('renderEntries shows urgent rows first and entry details', () => {
  const l = emptyLedger();
  addEntry(l, results, 'ozb-2', { by: 'Rob' }, NOW);
  addEntry(l, results, 'ozb-979072', { by: 'Rob', answer: 'Holidays | rest', ref: 'R-1' }, NOW);
  const md = renderEntries(l, new Date('2026-11-20T00:00:00+11:00'));
  assert.ok(md.indexOf('Holiday Voucher') < md.indexOf('$4000 Flight Centre'), 'urgent first');
  assert.match(md, /\*\*CHECK RESULT/);
  assert.match(md, /answer: “Holidays \\\| rest”/);
});

test('CLI: add, status, due, report round-trip through files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trk-'));
  const ledger = join(dir, 'entries.json'); const res = join(dir, 'results.json'); const out = join(dir, 'ENTRIES.md');
  await writeFile(res, JSON.stringify(results));
  const logs = []; const log = (s) => logs.push(s);
  const base = ['--ledger', ledger, '--results', res, '--now', NOW.toISOString()];
  await main(['add', 'ozb-979072', '--by', 'Rob', '--answer', 'Two words', ...base], log);
  await main(['status', 'ozb-979072', 'won', '--claim-by', '2026-11-10', ...base], log);
  await main(['due', '--days', '3', ...base], log);
  await main(['report', '--out', out, ...base], log);
  const saved = JSON.parse(await readFile(ledger, 'utf8'));
  assert.equal(saved.entries[0].entries[0].answer, 'Two words');
  assert.equal(saved.entries[0].status, 'won');
  assert.ok(logs.some((s) => /WON — claim by 2026-11-10/.test(s)));
  assert.ok(logs.some((s) => /ozb-1 .*closes 2026-10-31/.test(s)));
  assert.match(await readFile(out, 'utf8'), /Wins: 1/);
  await assert.rejects(main(['bogus', ...base], log), (e) => e.exitCode === 2);
});
