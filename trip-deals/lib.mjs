// Pure helpers: dates, relevance, travel windows, robots.txt, block detection, normalise/dedupe/filter/sort.
// No network here so everything is unit-testable.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return out;
}

export function decodeEntities(s) {
  return (s ?? '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;|&ndash;/g, '-').replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#038;/g, '&').replace(/&mdash;/g, '-').replace(/&middot;/g, '·')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

export function htmlToText(html) {
  return decodeEntities((html ?? '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

// Sydney's UTC offset for a calendar date: AEDT (+11) from the first Sunday of October
// to the first Sunday of April, otherwise AEST (+10).
export function sydneyOffset(y, m, d) {
  const firstSunday = (month) => { const wd = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return 1 + ((7 - wd) % 7); };
  if (m > 4 && m < 10) return '+10:00';
  if (m === 4) return d < firstSunday(4) ? '+11:00' : '+10:00';
  if (m === 10) return d < firstSunday(10) ? '+10:00' : '+11:00';
  return '+11:00';
}

const pad = (n) => String(n).padStart(2, '0');

// Build an ISO timestamp in Sydney local time. Missing time = end of day.
export function sydneyIso(y, m, d, hh = 23, mm = 59) {
  if (!(y > 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00${sydneyOffset(y, m, d)}`;
}

const monthIndex = (s) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

function parseTime(s) {
  const m = s?.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return [23, 59];
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return [h, Number(m[2] || 0)];
}

// Parses "30 November 2026", "01 Dec 2026", "30/11/2026", "2026-11-30", "15 Nov" (year inferred
// as the next occurrence on/after `now`), optionally with a time like "6:00pm". Returns ISO or null.
export function parseDate(s, now = new Date()) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/);
  if (m) return m[4] ? (Number.isNaN(Date.parse(s)) ? null : s) : sydneyIso(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return sydneyIso(+m[3], +m[2], +m[1]);
  m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?,?(?:\\s+(\\d{4}))?`, 'i'));
  if (!m) {
    const alt = s.match(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?`, 'i'));
    if (alt) m = [alt[0], alt[2], alt[1], alt[3]];
  }
  if (!m) return null;
  const mon = monthIndex(m[2]);
  const day = Number(m[1]);
  const [hh, mm] = parseTime(s.slice(s.indexOf(m[0]) + m[0].length));
  let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
  if (!m[3]) {
    // No year: choose the next occurrence (allowing for "today").
    const iso = sydneyIso(year, mon, day, hh, mm);
    if (iso && Date.parse(iso) < now.getTime() - 86400000) year += 1;
  }
  return sydneyIso(year, mon, day, hh, mm);
}

// --- Travel windows -------------------------------------------------------------------------

const DATE_TXT = `\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?(?:\\s+\\d{4})?`;

// Find an explicit travel/departure window in free text. Returns { from, to, text } (ISO dates, either may
// be null) or null when nothing is stated.
export function parseTravelWindow(text, now = new Date()) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ');
  const ctx = '(?:travel|travelling|depart(?:ure|ing)?|fly(?:ing)?|flights?|taken|valid|redeem(?:ed)?|completed?)';
  const patterns = [
    new RegExp(`${ctx}[^.]{0,80}?(?:between|from)\\s+(${DATE_TXT})\\s+(?:to|and|until|-|–)\\s+(${DATE_TXT})`, 'i'),
    new RegExp(`${ctx}[^.]{0,40}?(?:period|dates?)\\s*:?\\s*(${DATE_TXT})\\s*(?:-|–|to)\\s*(${DATE_TXT})`, 'i'),
    new RegExp(`${ctx}[^.]{0,80}?(?:until|by|before|no later than)\\s+(${DATE_TXT})`, 'i'),
  ];
  for (const [i, re] of patterns.entries()) {
    const m = t.match(re);
    if (!m) continue;
    if (i < 2) {
      // "17 January 2027 to 14 March 2027" or "21 April to 8 June 2027": borrow the year from the end date.
      const endIso = parseDate(m[2], now);
      const yr = endIso?.slice(0, 4);
      const fromTxt = /\d{4}/.test(m[1]) || !yr ? m[1] : `${m[1]} ${yr}`;
      return { from: parseDate(fromTxt, now), to: endIso, text: m[0].trim() };
    }
    return { from: null, to: parseDate(m[1], now), text: m[0].trim() };
  }
  // Month ranges in deal titles: "(Nov-Sep)", "Jan-Early Feb", "Mar-May 27", "Oct 2026 - Jun 2027".
  const mr = t.match(new RegExp(`\\b(${MONTH_RE})(?:\\s+(\\d{2,4}))?\\s*(?:-|–|to)\\s*(?:early |mid |late )?(${MONTH_RE})(?:\\s+(\\d{2,4}))?\\b`, 'i'));
  if (mr) {
    const fy = (y) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : null);
    const m1 = monthIndex(mr[1]); const m2 = monthIndex(mr[3]);
    let y1 = fy(mr[2]); let y2 = fy(mr[4]);
    if (!y1) {
      y1 = now.getUTCFullYear();
      if (m1 < now.getUTCMonth() + 1 && !(y2 && y2 === y1)) y1 += 1;
      if (y2 && m1 > m2 && y1 >= y2) y1 = y2 - 1;
    }
    if (!y2) y2 = m2 >= m1 ? y1 : y1 + 1;
    const last = new Date(Date.UTC(y2, m2, 0)).getUTCDate();
    return { from: sydneyIso(y1, m1, 1, 0, 0), to: sydneyIso(y2, m2, last), text: mr[0] };
  }
  return null;
}

// "Sun 25 April - Sat 1 May 2027", "Tue 19 - Fri 22 October 2027", "Dec 11, 2026 - Dec 13, 2026",
// "December 10, 2026" -> { from, to, text } (ISO). Missing start month/year are borrowed from the end date.
export function parseDateRange(text, now = new Date()) {
  const t = String(text ?? '').replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/gi, '').replace(/\s+/g, ' ').trim();
  const [a, b] = t.split(/\s+(?:-|–|to)\s+/);
  const to = parseDate(b ?? a, now);
  if (!to) return null;
  let from = to;
  if (b) {
    const hasMonth = new RegExp(MONTH_RE, 'i').test(a);
    const y = to.slice(0, 4);
    const fromTxt = hasMonth ? (/\d{4}/.test(a) ? a : `${a} ${y}`) : `${a} ${to.slice(5, 7) && MONTHS[Number(to.slice(5, 7)) - 1]} ${y}`;
    from = parseDate(fromTxt, now) ?? to;
    // "28 Dec - 2 Jan 2027": start is in the previous year.
    if (Date.parse(from) > Date.parse(to)) from = parseDate(fromTxt.replace(y, String(Number(y) - 1)), now) ?? to;
    from = from.replace(/T23:59/, 'T00:00');
  } else from = to.replace(/T23:59/, 'T00:00');
  return { from, to, text: String(text).trim() };
}

// Where an event is, as a trip option: Belfast/HK direct; UK/Ireland and HK's neighbours (Macao, Shenzhen) reachable.
export function eventRelevance(location) {
  const l = String(location ?? '');
  if (/belfast|northern ireland/i.test(l)) return { tier: 'direct', destination: 'Belfast / Northern Ireland' };
  if (/hong ?kong/i.test(l)) return { tier: 'direct', destination: 'Hong Kong' };
  if (/maca[ou]|taipa|shenzhen|guangzhou|zhuhai/i.test(l)) return { tier: 'reachable', destination: 'Near Hong Kong (fly via HKG)' };
  if (/\b(ireland|dublin|cork|galway|limerick|united kingdom|england|scotland|wales|london|manchester|edinburgh|glasgow|birmingham|bristol|leeds|cambridge|oxford)\b|\bUK\b/i.test(l)) {
    return { tier: 'reachable', destination: 'UK / Ireland (Belfast reachable)' };
  }
  return null;
}

export const TARGET_WINDOW = { from: '2027-09-01T00:00:00+10:00', to: '2027-10-31T23:59:00+11:00' };

// 'yes' when the stated window overlaps the target window, 'no' when it clearly doesn't, 'unknown' otherwise.
export function windowFit(w, target = TARGET_WINDOW) {
  if (!w || (!w.from && !w.to)) return 'unknown';
  const tf = Date.parse(target.from); const tt = Date.parse(target.to);
  if (w.to && Date.parse(w.to) < tf) return 'no';
  if (w.from && Date.parse(w.from) > tt) return 'no';
  return w.to ? 'yes' : 'unknown';
}

// --- Relevance ------------------------------------------------------------------------------

export const TIERS = { direct: 0, reachable: 1, flexible: 2, points: 3 };

const VOUCHER = /\b(flight centre|helloworld|webjet|qantas|virgin|travel|flights?|airline|holiday|luxury escapes|prezzee travel)\b[^.+]{0,30}\b(voucher|gift ?card|credit|e-?gift)/i;

// Classify text by destination relevance. Returns { tier, destination } or null.
export function relevance(text) {
  const t = text ?? '';
  if (/\bbelfast\b|northern ireland|\bBFS\b/i.test(t)) return { tier: 'direct', destination: 'Belfast / Northern Ireland' };
  if (/hong ?kong|\bHKG\b/i.test(t)) return { tier: 'direct', destination: 'Hong Kong' };
  if (/\b(ireland|dublin|london|heathrow|gatwick|manchester|edinburgh|glasgow|scotland|england|britain|united kingdom)\b|\bUK\b/i.test(t)) {
    return { tier: 'reachable', destination: 'UK / Ireland (Belfast reachable)' };
  }
  if (/holiday parks?|caravan|camping/i.test(t)) return null;
  if (/\b(trip|stay|resort|cruise|island|getaway)\b/i.test(t) && !/\b(anywhere|choice of destination|destination of (your|their) choice|worldwide)\b/i.test(t)) return null;
  if (VOUCHER.test(t) || /\b(anywhere in the world|destination of (your|their) choice|choice of destination|worldwide flights?)\b/i.test(t)) {
    return { tier: 'flexible', destination: 'Any (travel voucher / your choice)' };
  }
  return null;
}

// Eligibility: true = open to AU or HK residents, false = clearly excludes both, null = not stated.
export function eligibleAuHk(text) {
  if (!text) return null;
  const t = String(text);
  if (/\b(australia|australian|international|worldwide|globally|hong kong)\b/i.test(t) || /\b(AU|AUS|NSW|VIC|QLD|ACT|TAS|WA|SA|NT|HK)\b/.test(t)) return true;
  if (/\b(new zealand|NZ|united states|USA|US residents|UK residents|canad|singapore|malaysia)\b[^.]{0,30}\b(only|residents)\b/i.test(t)) return false;
  return null;
}

// --- robots.txt + block detection ------------------------------------------------------------

// robots.txt groups: [{ agents, rules: [{allow, pat}], crawlDelay }].
function robotsGroups(robotsTxt) {
  const groups = [];
  let cur = null; let lastWasAgent = false;
  for (const raw of String(robotsTxt ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [], crawlDelay: null }));
      cur.agents.push(m[2].trim().toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && m[2]) cur.rules.push({ allow: key === 'allow', pat: m[2].trim() });
      if (cur && key === 'crawl-delay' && Number(m[2]) >= 0) cur.crawlDelay = Number(m[2]);
    }
  }
  return groups;
}

// Crawl-delay (seconds) for the `User-agent: *` group, or null.
export function robotsCrawlDelay(robotsTxt) {
  const g = robotsGroups(robotsTxt).find((x) => x.agents.includes('*') && x.crawlDelay != null);
  return g ? g.crawlDelay : null;
}

// Minimal robots.txt check for the `User-agent: *` group (prefix + `*` wildcard + `$` anchor).
export function robotsAllows(robotsTxt, path) {
  if (!robotsTxt) return true;
  const groups = robotsGroups(robotsTxt);
  const rules = groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.pat.replace(/[.+?^${}()|[\]\\]/g, (c) => (c === '$' ? c : '\\' + c)).replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.pat.length > best.pat.length || (r.pat.length === best.pat.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

// Returns a reason string when a response looks like a bot block, else null.
export function detectBlock(status, body = '', finalUrl = '') {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  if (/captcha/i.test(finalUrl)) return 'redirected to CAPTCHA';
  const head = body.slice(0, 20000);
  if (/px-captcha|g-recaptcha|hcaptcha|are you a robot|detected as a robot|unusual traffic|verify you are human|access denied|request unsuccessful\. incapsula/i.test(head)) {
    return 'bot-check page';
  }
  return null;
}

// --- normalise / dedupe / filter / sort ------------------------------------------------------

export const FIELDS = ['type', 'title', 'destination', 'origin', 'value', 'closesAt', 'travelWindow', 'eligibility', 'url', 'source', 'fetchedAt'];

export function parseMoney(s) {
  const m = String(s ?? '').replace(/,/g, '').match(/\$\s?(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// --- competition entry classification ------------------------------------------------------

// From entry-method / T&C text: how winners are picked, whether a purchase is needed, and rough effort.
export function classifyEntry(text) {
  const t = String(text ?? '');
  const entryKind = /words or less|judg(ed|ing)|creative|best (answer|entr)|game of skill|skill/i.test(t) ? 'skill'
    : /instant win/i.test(t) ? 'instant'
    : /lucky draw|drawn? (at )?random|random (draw|selection)|draw(n)? (will|on)/i.test(t) ? 'draw' : null;
  const purchaseRequired = /no purchase (is )?(necessary|required)/i.test(t) ? false
    : /must (purchase|buy|spend)|purchase (a|an|any|at least|of)\b|qualifying purchase|purchase required|proof of purchase|\bspend \$|\bbuy (a|any|an)\b|Purchase\b/.test(t) || /purchase (a|an|any|at least)/i.test(t) ? true : null;
  const effort = entryKind === 'skill' ? 'high'
    : /like\/follow|comment|share|refer|recruit|tag a friend|instagram|facebook|account\/membership|member/i.test(t) ? 'medium' : 'low';
  return { entryKind, purchaseRequired, effort };
}

const TRAVEL_WORDS = 'travel|flight|holiday|luxury escapes|arrival|qantas|airline|trip|getaway';

// How many of the travel prize are given away: "1 of 5 $10K Travel Vouchers" -> 5,
// "Win $2,500 Flight Centre GC ... or 1 of 29 Minor Prizes" -> 1 (the 29 are minor prizes).
export function prizeCount(title) {
  const re = new RegExp(`\\b1 of (\\d+)\\b[^$]{0,15}\\$\\s?[\\d,.]+\\s*k?\\b[^$+]{0,45}(${TRAVEL_WORDS})`, 'i');
  const m = String(title ?? '').match(re);
  return m ? Number(m[1]) : 1;
}

// Largest dollar amount in the title that is attached to something travel-related.
export function travelValueAud(title) {
  let best = 0;
  const re = /\$\s?(\d[\d,]*)(\.\d+)?\s*(k\b)?([^$+]{0,45})/gi;
  for (const m of String(title ?? '').matchAll(re)) {
    if (!new RegExp(TRAVEL_WORDS, 'i').test(m[4])) continue;
    const v = Number(m[1].replace(/,/g, '')) * (m[3] ? 1000 : 1);
    if (v > best) best = v;
  }
  return best || null;
}

// Stable id for a competition from its listing URL: ozb-979072, cca-76098, ac-28370 (else a slug of the URL).
export function compId(url) {
  const u = String(url ?? '');
  let m = u.match(/ozbargain\.com\.au\/node\/(\d+)/); if (m) return `ozb-${m[1]}`;
  m = u.match(/competitions\.com\.au\/[^/]+\/(\d+)\/?$/); if (m) return `cca-${m[1]}`;
  m = u.match(/aussiecomps\.com\/index\.php\?id=(\d+)/); if (m) return `ac-${m[1]}`;
  return u.replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase();
}

// "Winners will be drawn at random on Monday 9 November 2026" -> ISO date (end of that day), else null.
export function parseDrawDate(text, now = new Date()) {
  const re = new RegExp(`(?:drawn?|draw (?:will )?(?:take place|be (?:held|conducted))|winners? (?:will be )?(?:selected|judged|announced|chosen))[^.]{0,60}?\\bon\\s+(?:[A-Z][a-z]+day,?\\s+)?(${DATE_TXT})`, 'i');
  const m = String(text ?? '').match(re);
  return m ? parseDate(m[1], now) : null;
}

// A = enter now, B = quick entry if you have time, C = only if you'd buy the product anyway, D = low value.
export function prioritise(it) {
  if (it.type !== 'competition') return null;
  if (it.purchaseRequired) return 'C';
  const tv = it.travelValueAud ?? 0;
  if (it.tier === 'direct' || it.tier === 'reachable' || tv >= 2000) return 'A';
  if (tv >= 500) return 'B';
  return 'D';
}

export function normaliseItem(raw, { now = new Date(), fetchedAt = now.toISOString() } = {}) {
  const rel = raw.relevance ?? relevance(`${raw.title} ${raw.relevanceText ?? ''}`);
  const tw = raw.travelWindow ?? null;
  const item = {
    type: raw.type,
    title: decodeEntities(raw.title).replace(/\s+/g, ' ').trim(),
    destination: rel?.destination ?? null,
    tier: rel?.tier ?? null,
    origin: raw.origin ?? null,
    value: raw.value ?? null,
    valueAud: raw.valueAud ?? parseMoney(raw.value),
    closesAt: raw.closesAt ?? null,
    travelWindow: tw,
    travelWindowFit: windowFit(tw),
    eligibility: raw.eligibility ?? null,
    eligible: raw.eligible ?? eligibleAuHk(raw.eligibility),
    entryMethod: raw.entryMethod ?? null,
    termsUrl: raw.termsUrl ?? null,
    url: raw.url,
    source: raw.source,
    fetchedAt,
    notes: raw.notes ?? null,
  };
  if (item.type === 'competition') {
    const c = classifyEntry(`${raw.entryKindText ?? ''} ${item.entryMethod ?? ''}`);
    Object.assign(item, {
      id: compId(item.url),
      drawAt: raw.drawAt ?? parseDrawDate(raw.entryKindText, now),
      entryKind: c.entryKind,
      purchaseRequired: raw.purchaseRequired ?? c.purchaseRequired,
      effort: c.effort,
      winners: prizeCount(item.title),
      travelValueAud: travelValueAud(item.title),
      ozbEntrants: raw.ozbEntrants ?? null,
    });
    item.priority = prioritise(item);
  }
  return item;
}

const titleTokens = (t) => new Set(t.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 2 && !['win', 'the', 'and', 'for', 'from', 'with', 'your', 'one'].includes(w)));
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
const canonUrl = (u) => { try { const x = new URL(u); return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase(); } catch { return null; } };

// Same item listed twice (same source, or same competition on several aggregators): keep the first,
// fill its blanks from the duplicate and remember where else it was listed.
export function dedupe(items) {
  const out = [];
  for (const it of items) {
    const tok = titleTokens(it.title);
    const when = (x) => (x.closesAt ?? (x.type === 'event' ? x.travelWindow?.from : null))?.slice(0, 10);
    const day = when(it);
    const tu = canonUrl(it.termsUrl);
    const dup = out.find((o) =>
      (o.type === it.type && o.title === it.title) ||
      (tu && canonUrl(o.termsUrl) === tu && o.type === it.type) ||
      (o.type === it.type && day && when(o) === day && jaccard(titleTokens(o.title), tok) >= 0.5) ||
      // Aggregators reword titles; same closing day + same prize value + some shared words is the same comp.
      (o.type === it.type && day && when(o) === day && it.valueAud && o.valueAud === it.valueAud && jaccard(titleTokens(o.title), tok) >= 0.2));
    if (!dup) { out.push({ ...it }); continue; }
    for (const k of Object.keys(it)) if (dup[k] == null && it[k] != null) dup[k] = it[k];
    if (dup.source !== it.source || dup.url !== it.url) {
      dup.alsoListedAt = [...new Set([...(dup.alsoListedAt ?? []), it.url])];
    }
  }
  return out;
}

// Split into kept vs excluded (with a reason). Irrelevant items are dropped entirely.
export function applyFilters(items, now = new Date()) {
  const kept = []; const excluded = []; let irrelevant = 0;
  for (const it of items) {
    if (!it.tier) { irrelevant++; continue; }
    let reason = null;
    if (it.closesAt && Date.parse(it.closesAt) < now.getTime()) reason = 'expired';
    else if (it.eligible === false) reason = 'not open to (general) AU/HK residents';
    else if (it.travelWindowFit === 'no') reason = it.type === 'event' ? 'event is outside Sep-Oct 2027' : 'travel window does not cover Sep-Oct 2027';
    if (reason) excluded.push({ ...it, excludedBecause: reason }); else kept.push(it);
  }
  return { kept, excluded, irrelevant };
}

// Soonest closing first; open-ended items last; then by relevance tier, then title.
export function sortItems(items) {
  const t = (x) => (x.closesAt ? Date.parse(x.closesAt) : Infinity);
  return [...items].sort((a, b) => t(a) - t(b) || (TIERS[a.tier] ?? 9) - (TIERS[b.tier] ?? 9) || a.title.localeCompare(b.title));
}

export function formatTable(items) {
  const cut = (s, n) => { s = String(s ?? '-'); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); };
  const head = `${cut('closes', 10)} ${cut('type', 11)} ${cut('dest', 18)} ${cut('title', 58)} ${cut('value', 12)} ${cut('source', 18)}`;
  const rows = items.map((r) => `${cut(r.closesAt?.slice(0, 10) ?? 'open-ended', 10)} ${cut(r.type, 11)} ${cut(r.destination, 18)} ${cut(r.title, 58)} ${cut(r.value, 12)} ${cut(r.source, 18)}`);
  return [head, '-'.repeat(head.length), ...rows].join('\n');
}
