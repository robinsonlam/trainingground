// Collect competitions, airline sales and points offers for a Sep-Oct 2027 trip to Belfast and Hong Kong
// (from Sydney or Hong Kong), using public RSS/JSON/HTML pages only.
// Usage: node trip-deals.mjs [--out results.json] [--report RESULTS.md] [--competitions COMPETITIONS.md] [--csv competitions.csv]
//        [--sources a,b] [--delay 800] [--now ISO]
// Exit codes: 0 = at least one source returned data, 1 = every source failed, 2 = bad arguments.
// Never enters competitions. Respects robots.txt; a 403/CAPTCHA is recorded as "blocked" and not retried.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  parseArgs, robotsAllows, detectBlock, normaliseItem, dedupe, applyFilters, sortItems, formatTable, TARGET_WINDOW,
} from './lib.mjs';
import { SOURCES, BlockedError, DisallowedError } from './sources.mjs';

export const USER_AGENT = 'trip-deals-research/1.0 (personal, non-commercial; +https://github.com/robinsonlam/trainingground)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One fetch context per run: robots.txt cache, per-host pacing, one retry for transient errors only.
export function makeFetcher({ delayMs = 800, timeoutMs = 25000, fetchImpl = fetch } = {}) {
  const robots = new Map();
  const lastHit = new Map();
  let requests = 0;

  async function pace(host) {
    const wait = (lastHit.get(host) ?? 0) + delayMs - Date.now();
    lastHit.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await sleep(wait);
  }

  async function raw(url) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await pace(new URL(url).host);
        requests++;
        const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        return { status: res.status, url: res.url || url, body: await res.text() };
      } catch (e) {
        if (attempt === 2) throw new Error(`network error: ${e.cause?.code ?? e.name}: ${e.message}`);
      }
    }
  }

  async function allowed(url) {
    const u = new URL(url);
    if (!robots.has(u.origin)) {
      robots.set(u.origin, raw(`${u.origin}/robots.txt`).then((r) => (r.status === 200 ? r.body : '')).catch(() => ''));
    }
    return robotsAllows(await robots.get(u.origin), u.pathname + u.search);
  }

  async function get(url, { json = false } = {}) {
    if (!(await allowed(url))) throw new DisallowedError(`robots.txt disallows ${new URL(url).pathname}`);
    const r = await raw(url);
    const block = detectBlock(r.status, r.body, r.url);
    if (block) throw new BlockedError(`blocked: ${block}`);
    if (r.status >= 400) throw new Error(`HTTP ${r.status} for ${url}`);
    return json ? JSON.parse(r.body) : r.body;
  }

  return { get, stats: () => ({ requests }) };
}

export async function run(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw Object.assign(new Error('invalid --now (expected ISO date)'), { exitCode: 2 });
  const delayMs = opts.delay === undefined ? 800 : Number(opts.delay);
  if (!(delayMs >= 0)) throw Object.assign(new Error('invalid --delay'), { exitCode: 2 });
  const names = opts.sources ? String(opts.sources).split(',').map((s) => s.trim()) : Object.keys(SOURCES);
  const unknown = names.filter((n) => !SOURCES[n]);
  if (unknown.length || !names.length) throw Object.assign(new Error(`unknown source(s): ${unknown.join(', ')}; known: ${Object.keys(SOURCES).join(', ')}`), { exitCode: 2 });

  const fetcher = makeFetcher({ delayMs, fetchImpl: opts.fetchImpl });
  const status = {};
  const probes = [];
  const rawItems = [];

  await Promise.all(names.map(async (name) => {
    const notes = [];
    const ctx = { now, get: fetcher.get, note: (s) => notes.push(s), probe: (n, url, r) => probes.push({ name: n, url, ...r }) };
    const t0 = Date.now();
    try {
      const got = await SOURCES[name](ctx);
      for (const g of got) rawItems.push({ raw: g, fetchedAt: new Date().toISOString() });
      status[name] = { ok: true, count: got.length, ms: Date.now() - t0, ...(notes.length && { notes }) };
    } catch (e) {
      status[name] = { ok: false, blocked: e instanceof BlockedError, disallowed: e instanceof DisallowedError, error: e.message.split('\n')[0], ms: Date.now() - t0 };
    }
  }));

  const normalised = rawItems.map(({ raw, fetchedAt }) => normaliseItem(raw, { now, fetchedAt }));
  const { kept, excluded, irrelevant } = applyFilters(dedupe(normalised), now);
  // Expired flight deals to the target destinations are still useful as price benchmarks for fare alerts.
  // Only fares priced for the destination itself (priceNear labels those "<Destination> $N").
  const benchmarks = sortItems(excluded.filter((x) => x.type === 'sale' && x.excludedBecause === 'expired' &&
    /^(belfast|hong ?kong|dublin|london|manchester|edinburgh)\b/i.test(x.value ?? '')))
    .reverse().slice(0, 15);

  return {
    generatedAt: now.toISOString(),
    query: { destinations: ['Belfast (BFS/BHD)', 'Hong Kong (HKG)'], origins: ['SYD', 'HKG'], travelWindow: TARGET_WINDOW },
    status,
    probes,
    requests: fetcher.stats().requests,
    results: sortItems(kept),
    excluded: sortItems(excluded),
    benchmarks,
    irrelevantCount: irrelevant,
  };
}

// ------------------------------------------------------------------------------------ report

const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const day = (iso) => iso?.slice(0, 10) ?? 'open-ended';
const win = (w) => (w ? `${day(w.from) === 'open-ended' ? '?' : day(w.from)} → ${day(w.to) === 'open-ended' ? '?' : day(w.to)}` : 'not stated');

export function renderReport(data) {
  const L = [];
  const by = (type) => data.results.filter((r) => r.type === type);
  const row = (r) => `| ${day(r.closesAt)} | ${md(r.title)} | ${md(r.destination)} | ${md(r.value ?? '-')} | ${md(r.eligibility ?? 'not stated')} | ${win(r.travelWindow)} (${r.travelWindowFit}) | [${md(r.source)}](${r.url})${r.termsUrl ? ` · [entry/T&Cs](${r.termsUrl})` : ''} |`;
  const table = (rows) => rows.length
    ? ['| Closes | Item | Destination | Value | Eligibility | Travel window (fits Sep–Oct 2027?) | Source |', '|---|---|---|---|---|---|---|', ...rows.map(row)]
    : ['_Nothing open matched today._'];

  L.push('# Trip deals: Belfast & Hong Kong, Sep–Oct 2027', '');
  L.push(`Generated by \`node trip-deals.mjs\` on **${data.generatedAt.slice(0, 10)}** (${data.requests} HTTP requests). Every row below was fetched from the linked page on that date; nothing is hand-entered. Prices/closing dates change — check the source before acting. Competitions were **not** entered.`, '');
  L.push(`Destinations: Belfast / Northern Ireland and Hong Kong (direct), UK/Ireland (Belfast is a short hop from London/Dublin), flexible travel vouchers, and points offers. Origins: Sydney or Hong Kong. Target travel window ${day(data.query.travelWindow.from)} → ${day(data.query.travelWindow.to)}.`, '');
  const best = data.results.filter((r) => (r.tier === 'direct' && r.type !== 'points' && (r.closesAt || r.travelWindowFit === 'yes')) ||
    (r.tier === 'reachable' && r.type === 'competition') || (r.type === 'competition' && r.valueAud >= 10000));
  L.push('## Best bets', '', best.length
    ? best.map((r) => `- **${md(r.title)}** — ${md(r.destination)}; ${r.value ? `${md(r.value)}; ` : ''}closes ${day(r.closesAt)}; ${md(r.eligibility ?? 'eligibility not stated')}${r.entryMethod ? `; ${md(r.entryMethod)}` : ''}. [source](${r.url})`).join('\n')
    : '_No direct/reachable items open today._', '');
  L.push('## Competitions & giveaways (open, AU/HK eligible)', '', ...table(by('competition')), '');
  L.push('## Airline / travel sales', '', ...table(by('sale')), '');
  L.push('## Points & frequent-flyer options', '', ...table(by('points')), '');
  L.push('## Fare benchmarks (expired deals, for setting fare alerts)', '');
  L.push(data.benchmarks.length
    ? ['| Was open until | Deal | Destination | Price seen | Source |', '|---|---|---|---|---|', ...data.benchmarks.map((b) => `| ${day(b.closesAt)} | ${md(b.title)} | ${md(b.destination)} | ${md(b.value)} | [${md(b.source)}](${b.url}) |`)].join('\n')
    : '_None found._', '');
  L.push('No source used here publishes live SYD→BFS, SYD→HKG or HKG→BFS fares for Sep–Oct 2027 to automated clients (Google Flights search is disallowed by robots.txt; Skyscanner returns a CAPTCHA). Set alerts manually: [Google Flights SYD→BFS](https://www.google.com/travel/flights?q=Flights%20from%20SYD%20to%20BFS%20in%20September%202027), [SYD→HKG](https://www.google.com/travel/flights?q=Flights%20from%20SYD%20to%20HKG%20in%20September%202027), [HKG→BFS](https://www.google.com/travel/flights?q=Flights%20from%20HKG%20to%20BFS%20in%20October%202027).', '');
  L.push('## Checked but excluded', '');
  L.push(data.excluded.length
    ? ['| Item | Reason | Closes | Travel window | Source |', '|---|---|---|---|---|', ...data.excluded.map((x) => `| ${md(x.title)} | ${x.excludedBecause} | ${day(x.closesAt)} | ${win(x.travelWindow)} | [${md(x.source)}](${x.url}) |`)].join('\n')
    : '_None._', '');
  L.push('## Sources', '', '| Source | Result |', '|---|---|');
  for (const [n, s] of Object.entries(data.status)) {
    if (n === 'probe-only' && s.ok) continue; // its pages are listed one by one below
    L.push(`| ${n} | ${s.ok ? `ok — ${s.count} candidate items${s.notes ? ` (${md(s.notes.join('; '))})` : ''}` : `${s.blocked ? '**blocked**' : s.disallowed ? 'robots.txt disallows' : 'failed'}: ${md(s.error)}`} |`);
  }
  for (const p of data.probes) {
    L.push(`| ${md(p.name)} ([link](${p.url})) | ${p.ok ? `reachable — ${p.result}` : `${p.blocked ? '**blocked**' : p.disallowed ? 'not fetched — robots.txt disallows' : 'failed'}: ${md(p.error)}`} |`);
  }
  L.push('', `${data.irrelevantCount} other fetched items were not about Belfast/Hong Kong/UK-Ireland/travel vouchers/points and are omitted.`, '');
  return L.join('\n');
}

// ------------------------------------------------------------------------- competition list

const PRIORITY = {
  A: 'Enter now — free, and the prize gets you to Belfast/HK or is a big travel voucher',
  B: 'Quick entry if you have time — free, smaller travel voucher',
  C: 'Only if you would buy the product anyway — purchase required',
  D: 'Low value for this trip — travel voucher under $500 or bundled with an unrelated prize',
};
const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : '?');

export function competitionRows(data) {
  const order = { A: 0, B: 1, C: 2, D: 3 };
  return data.results.filter((r) => r.type === 'competition')
    .sort((a, b) => order[a.priority] - order[b.priority] || (Date.parse(a.closesAt) || Infinity) - (Date.parse(b.closesAt) || Infinity));
}

// `ledger` (entries.json) marks competitions already entered: ☑ date (who).
export function renderCompetitions(data, ledger = null) {
  const rows = competitionRows(data);
  const entered = new Map((ledger?.entries ?? []).map((e) => [e.id, e]));
  const tick = (r) => {
    const e = entered.get(r.id);
    if (!e) return '☐';
    const last = e.entries.at(-1);
    return `☑ ${day(last?.at)}${last?.by ? ` (${md(last.by)})` : ''}`;
  };
  const L = ['# Competitions: Belfast / Hong Kong / travel vouchers', ''];
  L.push(`Fetched ${data.generatedAt.slice(0, 10)} by \`node trip-deals.mjs\`. ${rows.length} open competitions that AU residents can enter. Nothing has been entered; every row links to the page it came from — read the T&Cs before entering.`, '');
  L.push(`**Tracking:** after entering, run \`node track.mjs add <id> --by <name>\` (ids are in the second column), then \`npm start\` refreshes the ticks. \`node track.mjs due\` shows results to check and competitions closing soon. ${entered.size ? `${rows.filter((r) => entered.has(r.id)).length} of ${rows.length} entered.` : 'Nothing entered yet.'}`, '');
  L.push('**Columns:** *Travel $* = the travel/flight part of the prize parsed from the title; *Travel prizes* = how many of that prize are given away; *Kind* = random draw, skill (judged answer, usually better odds) or instant win; *Effort* = low (form/email), medium (social, referral, membership), high (written answer); *OzB entrants* = OzBargain members who have marked it entered (a rough popularity signal, not the real entry count).', '');
  for (const p of ['A', 'B', 'C', 'D']) {
    const group = rows.filter((r) => r.priority === p);
    L.push(`## ${p}. ${PRIORITY[p]} (${group.length})`, '');
    if (!group.length) { L.push('_None today._', ''); continue; }
    L.push('| Entered | Id · closes | Competition | Prize value | Travel $ | Travel prizes | Kind | Effort | Purchase? | Open to | OzB entrants | Links |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of group) {
      L.push(`| ${tick(r)} | \`${r.id}\` ${day(r.closesAt)} | ${md(r.title)} | ${md(r.value ?? '?')} | ${r.travelValueAud ? `$${r.travelValueAud.toLocaleString('en-AU')}` : '-'} | ${r.winners} | ${r.entryKind ?? '?'} | ${r.effort} | ${yn(r.purchaseRequired)} | ${md(r.eligibility ?? '?')} | ${r.ozbEntrants ?? '-'} | [listing](${r.url})${r.termsUrl ? ` · [enter/T&Cs](${r.termsUrl})` : ''}${(r.alsoListedAt ?? []).map((u, i) => ` · [alt ${i + 1}](${u})`).join('')} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

export function renderCsv(data) {
  const cols = ['priority', 'closesAt', 'title', 'value', 'travelValueAud', 'winners', 'entryKind', 'effort', 'purchaseRequired', 'eligibility', 'destination', 'ozbEntrants', 'url', 'termsUrl', 'source'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...competitionRows(data).map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const data = await run(opts);
    if (opts.out) await writeFile(opts.out === true ? 'results.json' : opts.out, JSON.stringify(data, null, 2));
    if (opts.report) await writeFile(opts.report === true ? 'RESULTS.md' : opts.report, renderReport(data));
    const ledgerPath = typeof opts.entries === 'string' ? opts.entries : 'entries.json';
    const ledger = await readFile(ledgerPath, 'utf8').then(JSON.parse).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (opts.competitions) await writeFile(opts.competitions === true ? 'COMPETITIONS.md' : opts.competitions, renderCompetitions(data, ledger));
    if (opts.csv) await writeFile(opts.csv === true ? 'competitions.csv' : opts.csv, renderCsv(data));
    console.log(formatTable(data.results));
    console.log(`\n${data.results.length} open items, ${data.excluded.length} excluded (expired/ineligible/wrong travel window), ${data.irrelevantCount} irrelevant.`);
    for (const [n, s] of Object.entries(data.status)) console.error(`source ${n}: ${s.ok ? `ok (${s.count})` : `${s.blocked ? 'BLOCKED' : 'FAILED'} ${s.error}`}`);
    for (const p of data.probes) console.error(`probe ${p.name}: ${p.ok ? 'reachable' : p.blocked ? 'BLOCKED' : p.disallowed ? 'robots-disallowed' : 'FAILED'}${p.error ? ` ${p.error}` : ''}`);
    process.exitCode = Object.values(data.status).some((s) => s.ok && s.count > 0) ? 0 : 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = e.exitCode ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
