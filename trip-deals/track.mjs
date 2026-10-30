// Competition entry ledger: record what was entered, then follow up on results and prize claims.
// The ledger is entries.json (committed, so everyone working from the repo sees the same record).
//
//   node track.mjs add <id|url> [--by NAME] [--at YYYY-MM-DD] [--email ALIAS] [--answer TEXT] [--ref RECEIPT]
//                               [--note TEXT] [--draw DATE] [--check-by DATE]
//                               (not in results.json? also --title, --url, --closes DATE)
//   node track.mjs status <id> <entered|won|not-won|claimed|withdrawn> [--claim-by DATE] [--note TEXT]
//   node track.mjs note <id> TEXT
//   node track.mjs list          # every entry with its current phase
//   node track.mjs due [--days 3] # what needs doing: results to check, prizes to claim, A/B comps not yet entered
//   node track.mjs report        # writes ENTRIES.md
// Common: --ledger entries.json --results results.json --now ISO
// Exit codes: 0 ok, 2 bad arguments / unknown competition.
// Don't store passwords, phone numbers or home addresses here: the ledger is committed to git.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseDate, compId } from './lib.mjs';

export const STATUSES = ['entered', 'won', 'not-won', 'claimed', 'withdrawn'];
const DAY = 86400000;
const day = (iso) => iso?.slice(0, 10) ?? '-';
const fail = (msg) => Object.assign(new Error(msg), { exitCode: 2 });

export function emptyLedger() { return { version: 1, entries: [] }; }

// When to go and look for the result: explicit date, else a week after the draw, else two weeks after closing.
export function checkBy(e) {
  if (e.checkBy) return e.checkBy;
  const base = e.drawAt ? Date.parse(e.drawAt) + 7 * DAY : e.closesAt ? Date.parse(e.closesAt) + 14 * DAY : NaN;
  return Number.isNaN(base) ? null : new Date(base).toISOString();
}

// What, if anything, needs doing for an entry right now. `urgent` = act today.
export function phase(e, now = new Date()) {
  const t = now.getTime();
  if (e.status === 'won') {
    if (!e.claimBy) return { label: 'WON — confirm and claim prize (set --claim-by)', urgent: true };
    const left = Math.ceil((Date.parse(e.claimBy) - t) / DAY);
    return { label: left < 0 ? `WON — claim deadline passed ${day(e.claimBy)}` : `WON — claim by ${day(e.claimBy)}`, urgent: left <= 7 };
  }
  if (e.status !== 'entered') return { label: `done (${e.status})`, urgent: false };
  if (e.closesAt && t < Date.parse(e.closesAt)) return { label: `entered, open until ${day(e.closesAt)}`, urgent: false };
  const cb = checkBy(e);
  if (cb && t < Date.parse(cb)) return { label: `awaiting result (check from ${day(cb)})`, urgent: false };
  return { label: 'CHECK RESULT — winners should be known', urgent: true };
}

function competitionFrom(results, key) {
  const comps = (results?.results ?? []).filter((r) => r.type === 'competition');
  return comps.find((r) => r.id === key || compId(r.url) === key || r.url === key || (r.alsoListedAt ?? []).includes(key)) ?? null;
}

export function addEntry(ledger, results, key, opts = {}, now = new Date()) {
  const at = opts.at ? parseDate(String(opts.at), now) : now.toISOString();
  if (!at) throw fail('invalid --at date');
  const id = key.startsWith('http') ? compId(key) : key;
  let e = ledger.entries.find((x) => x.id === id || x.url === key);
  if (!e) {
    const c = competitionFrom(results, key);
    if (!c && !(opts.title && opts.url)) throw fail(`competition "${key}" not in results.json; pass --title and --url (and --closes) to add it by hand`);
    e = {
      id: c?.id ?? compId(opts.url ?? key),
      title: c?.title ?? opts.title,
      url: c?.url ?? opts.url,
      termsUrl: c?.termsUrl ?? null,
      prize: c?.value ?? null,
      travelValueAud: c?.travelValueAud ?? null,
      priority: c?.priority ?? null,
      entryKind: c?.entryKind ?? null,
      closesAt: (opts.closes ? parseDate(String(opts.closes), now) : null) ?? c?.closesAt ?? null,
      drawAt: c?.drawAt ?? null,
      checkBy: null,
      claimBy: null,
      status: 'entered',
      statusAt: at,
      entries: [],
      notes: [],
    };
    ledger.entries.push(e);
  }
  if (opts.draw) e.drawAt = parseDate(String(opts.draw), now) ?? (() => { throw fail('invalid --draw date'); })();
  if (opts['check-by']) e.checkBy = parseDate(String(opts['check-by']), now) ?? (() => { throw fail('invalid --check-by date'); })();
  const rec = { at };
  for (const k of ['by', 'email', 'answer', 'ref']) if (typeof opts[k] === 'string') rec[k] = opts[k];
  e.entries.push(rec);
  if (typeof opts.note === 'string') e.notes.push({ at, text: opts.note });
  return e;
}

export function setStatus(ledger, id, status, opts = {}, now = new Date()) {
  if (!STATUSES.includes(status)) throw fail(`status must be one of ${STATUSES.join(', ')}`);
  const e = ledger.entries.find((x) => x.id === id);
  if (!e) throw fail(`no entry "${id}" in the ledger`);
  e.status = status;
  e.statusAt = now.toISOString();
  if (opts['claim-by']) e.claimBy = parseDate(String(opts['claim-by']), now) ?? (() => { throw fail('invalid --claim-by date'); })();
  if (typeof opts.note === 'string') e.notes.push({ at: now.toISOString(), text: opts.note });
  return e;
}

// Actions due: urgent ledger items, plus free A/B competitions closing within `days` that nobody has entered.
export function due(ledger, results, now = new Date(), days = 3) {
  const followUps = ledger.entries.map((e) => ({ e, p: phase(e, now) })).filter((x) => x.p.urgent);
  const entered = new Set(ledger.entries.map((e) => e.id));
  const horizon = now.getTime() + days * DAY;
  const toEnter = (results?.results ?? []).filter((r) => r.type === 'competition' && ['A', 'B'].includes(r.priority) &&
    !entered.has(r.id ?? compId(r.url)) && r.closesAt && Date.parse(r.closesAt) >= now.getTime() && Date.parse(r.closesAt) <= horizon)
    .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
  return { followUps, toEnter };
}

const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderEntries(ledger, now = new Date()) {
  const L = ['# Competition entries', '', `Ledger: \`entries.json\` · updated ${day(now.toISOString())} · ${ledger.entries.length} competitions. Update with \`node track.mjs\` (see README).`, ''];
  const won = ledger.entries.filter((e) => ['won', 'claimed'].includes(e.status));
  if (won.length) L.push(`**Wins: ${won.length}** — ${won.map((e) => `${md(e.title)} (${e.status})`).join('; ')}`, '');
  L.push('| Phase | Competition | Prize | Closes | Check result from | Entered (by) | Links |', '|---|---|---|---|---|---|---|');
  const sorted = [...ledger.entries].sort((a, b) => Number(phase(b, now).urgent) - Number(phase(a, now).urgent) ||
    (Date.parse(checkBy(a)) || Infinity) - (Date.parse(checkBy(b)) || Infinity));
  for (const e of sorted) {
    const p = phase(e, now);
    const ents = e.entries.map((x) => `${day(x.at)}${x.by ? ` (${md(x.by)})` : ''}`).join(', ');
    L.push(`| ${p.urgent ? `**${md(p.label)}**` : md(p.label)} | ${md(e.title)} | ${md(e.prize ?? '-')} | ${day(e.closesAt)} | ${day(checkBy(e))} | ${ents} | [listing](${e.url})${e.termsUrl ? ` · [T&Cs](${e.termsUrl})` : ''} |`);
  }
  const notes = ledger.entries.filter((e) => e.notes.length || e.entries.some((x) => x.answer || x.ref || x.email));
  if (notes.length) {
    L.push('', '## Details', '');
    for (const e of notes) {
      L.push(`- **${md(e.title)}** (\`${e.id}\`)`);
      for (const x of e.entries) {
        const bits = [x.email && `email ${md(x.email)}`, x.ref && `ref ${md(x.ref)}`, x.answer && `answer: “${md(x.answer)}”`].filter(Boolean);
        if (bits.length) L.push(`  - ${day(x.at)}: ${bits.join('; ')}`);
      }
      for (const n of e.notes) L.push(`  - note ${day(n.at)}: ${md(n.text)}`);
    }
  }
  return L.join('\n') + '\n';
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  // Every --flag takes a value, so anything not a flag or a flag's value is positional.
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++; } else pos.push(argv[i]);
  }
  const opts = parseArgs(argv);
  const [cmd, ...args] = pos;
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw fail('invalid --now');
  const ledgerPath = typeof opts.ledger === 'string' ? opts.ledger : 'entries.json';
  const ledger = await readJson(ledgerPath, emptyLedger());
  const results = await readJson(typeof opts.results === 'string' ? opts.results : 'results.json', null);
  const save = () => writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

  if (cmd === 'add') {
    if (!args[0]) throw fail('usage: track.mjs add <id|url> [--by NAME] ...');
    const e = addEntry(ledger, results, args[0], opts, now);
    await save();
    log(`recorded entry #${e.entries.length} for ${e.id}: ${e.title} — ${phase(e, now).label}`);
  } else if (cmd === 'status') {
    if (!args[0] || !args[1]) throw fail('usage: track.mjs status <id> <status>');
    const e = setStatus(ledger, args[0], args[1], opts, now);
    await save();
    log(`${e.id}: ${phase(e, now).label}`);
  } else if (cmd === 'note') {
    const e = ledger.entries.find((x) => x.id === args[0]);
    if (!e || !args[1]) throw fail('usage: track.mjs note <id> TEXT (id must be in the ledger)');
    e.notes.push({ at: now.toISOString(), text: args.slice(1).join(' ') });
    await save();
    log(`noted on ${e.id}`);
  } else if (cmd === 'list') {
    if (!ledger.entries.length) log('no entries yet — record one with: node track.mjs add <id>');
    for (const e of ledger.entries) log(`${e.id.padEnd(12)} ${phase(e, now).label.padEnd(48)} ${e.title}`);
  } else if (cmd === 'due') {
    const days = opts.days === undefined ? 3 : Number(opts.days);
    if (!(days >= 0)) throw fail('invalid --days');
    const { followUps, toEnter } = due(ledger, results, now, days);
    log(`Follow up (${followUps.length}):`);
    for (const { e, p } of followUps) log(`  ${e.id.padEnd(12)} ${p.label} — ${e.title}\n  ${' '.repeat(12)} ${e.termsUrl ?? e.url}`);
    log(`Not entered yet, priority A/B, closing within ${days} days (${toEnter.length}):`);
    for (const r of toEnter) log(`  ${(r.id ?? compId(r.url)).padEnd(12)} [${r.priority}] closes ${day(r.closesAt)} — ${r.title}\n  ${' '.repeat(12)} ${r.termsUrl ?? r.url}`);
  } else if (cmd === 'report') {
    const out = typeof opts.out === 'string' ? opts.out : 'ENTRIES.md';
    await writeFile(out, renderEntries(ledger, now));
    log(`wrote ${out}`);
  } else {
    throw fail('usage: track.mjs <add|status|note|list|due|report> ... (see header of track.mjs)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = e.exitCode ?? 1; });
}
