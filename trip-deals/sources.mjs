// Source fetchers + parsers. Parsers are pure (html/xml/json in, raw items out) so they are unit-tested
// with small fixtures; fetchers go through ctx.get(), which enforces robots.txt, block detection and pacing.
import { htmlToText, decodeEntities, parseDate, parseTravelWindow, relevance, eligibleAuHk } from './lib.mjs';

export class BlockedError extends Error {}
export class DisallowedError extends Error {}

const OZB = 'https://www.ozbargain.com.au';
const CCA = 'https://www.competitions.com.au';
const AC = 'https://www.aussiecomps.com';

const attr = (s, name) => s.match(new RegExp(`${name}="([^"]*)"`))?.[1];

// ---------------------------------------------------------------- OzBargain competitions (HTML list)
export function parseOzbCompetitions(html, now) {
  const out = [];
  for (const block of html.split(/<div class="node node-competition node-teaser"/).slice(1)) {
    const id = block.match(/id="node(\d+)"/)?.[1];
    const title = decodeEntities(block.match(/data-title="([^"]*)"/)?.[1]);
    if (!id || !title) continue;
    const meta = (t) => htmlToText(block.match(new RegExp(`title="${t}"><i[^>]*></i>([^<]*)`))?.[1]);
    const openTo = meta('Open to');
    const expiry = htmlToText(block.match(/<span class="nodeexpiry">([\s\S]*?)<span class="marker"/)?.[1]);
    out.push({
      type: 'competition',
      title,
      origin: 'AU',
      value: meta('Total prize pool').replace(/^Prize pool\s*/, '') || null,
      closesAt: parseDate(expiry, now),
      eligibility: openTo ? `Open to: ${openTo}` : null,
      eligible: openTo ? eligibleAuHk(openTo) : null,
      entryMethod: [meta('Entry methods'), meta('Entry requirements')].filter(Boolean).join('; ') || null,
      termsUrl: block.match(/title="Go to (https?:[^"]+)"/)?.[1] ?? null,
      url: `${OZB}/node/${id}`,
      source: 'ozbargain-competitions',
    });
  }
  return out;
}

// ---------------------------------------------------------------- OzBargain deal RSS feeds
const PRICE = '\\$\\s?(\\d[\\d,]*\\d|\\d)';
// Pick the fare that belongs to the target destination (and Sydney where listed), e.g.
// "SYD-Istanbul $876, SYD-Budapest $911/Paris $1001/London $1071" -> "London $1071".
export function priceNear(title) {
  // "via Hong Kong" / "Hong Kong stopover" is a transit point, not the fare's destination.
  const dest = title.match(/(?<!via )\b(belfast|hong ?kong|dublin|london|manchester|edinburgh)\b(?! stopover)/i);
  if (dest) {
    const after = title.slice(dest.index);
    const syd = after.match(new RegExp(`^.{0,60}?\\bSYD\\b[^$]{0,4}${PRICE}`, 'i'));
    const first = after.match(new RegExp(`^[^,;$]{0,40}?${PRICE}`));
    const p = syd?.[1] ?? first?.[1];
    if (p) return `${dest[0]}${syd ? ' ex SYD' : ''} $${p}`;
  }
  const syd = title.match(new RegExp(`\\bSYD\\b[^$]{0,12}${PRICE}`, 'i'));
  if (syd) return `SYD $${syd[1]}`;
  const any = title.match(new RegExp(PRICE));
  return any ? `$${any[1]}` : null;
}

export function parseOzbDealFeed(xml, now, feedName) {
  const out = [];
  for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const title = decodeEntities(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim();
    const link = it.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const pub = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const meta = it.match(/<ozb:meta [^>]*\/>/)?.[0] ?? '';
    const expiry = attr(meta, 'expiry');
    const isPoints = /\b(points|miles|status credits?|velocity|frequent flyer|avios)\b/i.test(title) && !/\b(tour|nights?|hotel|package|cashback)\b/i.test(title);
    const isFlight = /\b(flights?|fares?|return|o\/w|one[- ]way|rtn|business class|economy|airlines?|airways)\b/i.test(title);
    if (!isPoints && !isFlight) continue;
    out.push({
      type: isFlight && !/^\d+[,\d]* bonus|double points|points? on/i.test(title) ? 'sale' : 'points',
      title,
      origin: /\bSYD|sydney\b/i.test(title) ? 'SYD' : /from hong kong|departing from hong kong|ex hong kong/i.test(title) ? 'HKG' : 'AU',
      value: priceNear(title),
      closesAt: expiry ? parseDate(expiry, now) : null,
      travelWindow: parseTravelWindow(title, now),
      eligibility: 'Public fare (bookable from AU)',
      eligible: true,
      termsUrl: attr(meta, 'url') ?? null,
      url: link,
      postedAt: pub ? new Date(pub).toISOString() : null,
      source: `ozbargain-${feedName}`,
      relevance: isPoints && !relevance(title) ? { tier: 'points', destination: 'Any (points)' } : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------- competitions.com.au
export function parseCcaList(html) {
  const out = [];
  for (const a of html.split(/<article /).slice(1)) {
    const id = attr(a, 'data-comp-id');
    const href = a.match(/<a href="(\/[^"]+\/\d+\/)"/)?.[1];
    const title = decodeEntities(a.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!id || !href || !title) continue;
    const value = a.match(/<span class="bg-green[^"]*"[^>]*>\s*([^<]+?)\s*<\/span>/)?.[1] ?? null;
    const ends = a.match(/(Ends [A-Z][a-z]{2} \d{1,2})/)?.[1] ?? null;
    out.push({ id, url: CCA + href, title, value, ends, expired: attr(a, 'data-expired') === 'true' });
  }
  return out;
}

export function parseCcaDetail(html, listing, now) {
  let ev = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { const j = JSON.parse(m[1]); if (j['@type'] === 'Event') ev = j; } catch { /* other blocks */ }
  }
  const text = htmlToText(html);
  const openTo = text.match(/Open to ([^.]{3,120})\./)?.[1] ?? null;
  const desc = ev?.description?.replace(/\*\*/g, '') ?? '';
  return {
    type: 'competition',
    title: ev?.name ?? listing.title,
    origin: 'AU',
    value: listing.value,
    closesAt: ev?.endDate ?? parseDate(text.match(/Closes ([^.]{5,40}\d{4})/)?.[1], now),
    travelWindow: parseTravelWindow(desc, now),
    eligibility: openTo ? `Open to ${openTo}` : null,
    eligible: openTo ? eligibleAuHk(openTo) : null,
    entryMethod: desc.match(/How do I enter[^?]*\?\s*([^\n]{0,220})/i)?.[1]?.trim() ?? null,
    termsUrl: ev?.location?.url ?? ev?.offers?.url ?? null,
    url: listing.url,
    source: 'competitions.com.au',
    relevanceText: desc.match(/What are the prizes[^?]*\?\s*([^\n]{0,400})/i)?.[1] ?? '',
  };
}

// ---------------------------------------------------------------- aussiecomps.com
export function parseAussieCompsList(html, now) {
  const out = [];
  for (const blk of html.split('BETWEEN EACH LISTING').slice(1)) {
    const id = blk.match(/index\.php\?id=(\d+)/)?.[1];
    const title = decodeEntities(blk.match(/alt="([^"]*)"/)?.[1] ?? '').trim();
    if (!id || !title) continue;
    const value = blk.match(/\$&nbsp;([\d,+]+)/)?.[1];
    const close = blk.match(/\b(\d\d\/\d\d\/20\d\d)\b/)?.[1];
    out.push({ id, title, value: value ? `$${value}` : null, closesAt: parseDate(close, now), url: `${AC}/index.php?id=${id}` });
  }
  return out;
}

export function parseAussieCompsDetail(html, listing, now) {
  const text = htmlToText(html);
  const body = text.slice(Math.max(0, text.indexOf(listing.title.slice(0, 30))));
  const elig = body.match(/[^.|]*\b(open (?:globally |only )?to|residents|aged \d\d\+|18\+)[^.|]*\./i)?.[0]?.trim() ?? null;
  return {
    type: 'competition',
    title: listing.title,
    origin: 'AU',
    value: listing.value,
    closesAt: parseDate(body.match(/Closes\^?:\s*([^|]{5,40}?\d{4})/)?.[1], now) ?? listing.closesAt,
    travelWindow: parseTravelWindow(body.slice(0, 3000), now),
    eligibility: elig ?? 'Listed on an Australian comps site (check T&Cs)',
    eligible: elig ? eligibleAuHk(elig) : null,
    entryMethod: null,
    termsUrl: body.match(/ENTER_HERE:[\s|]*(https?:\/\/[^\s|]+)/)?.[1] ?? null,
    url: listing.url,
    source: 'aussiecomps.com',
  };
}

// ---------------------------------------------------------------- Cathay Pacific offer pages
export function parseCathayOffer(html, url, now, origin) {
  const text = htmlToText(html);
  const start = text.indexOf('View details') >= 0 ? text.indexOf('View details') + 12 : text.search(/Flights /);
  const head = text.slice(start, start + 1500);
  const headline = head.match(/Flights\s+(.{5,90}?)\s+(?:Enjoy|Experience|Treat|Discover|Save|Fly|Book|Get)\b/)?.[1]
    ?? htmlToText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]).replace(/\|.*$/, '').trim();
  const dep = text.match(/Departure period\s+(\d{1,2} \w{3} \d{4})\s*-\s*(\d{1,2} \w{3} \d{4})/);
  const ends = text.match(/Offer ends:?\s*(\d{1,2} \w{3,9} \d{4})/)?.[1] ?? text.match(/available until (\d{1,2} \w{3,9} \d{4})/)?.[1];
  const code = text.match(/promotion code ([A-Z0-9]{5,})/i)?.[1];
  const value = head.match(/(?:up to )?\$\d+\*? off[^.]{0,40}|up to \d+% discount/i)?.[0] ?? null;
  const excl = text.match(/Sale excludes ([^.]+)\./)?.[1];
  if (/airport express|heathrow express|citybus|citygate|luggagent|the peak|\bmtr\b|outlets|dining|wellness|shopping/i.test(`${headline} ${head.slice(0, 150)}`)) return null;
  const restr = /domestic helper/i.test(headline) ? 'Foreign domestic helpers in Hong Kong only'
    : /student/i.test(text.slice(0, 3000)) ? 'Students only (valid student ID required)' : null;
  return {
    type: 'sale',
    title: `Cathay Pacific: ${headline}`,
    origin,
    value: value ? value.replace(/\*/g, '').trim() : null,
    closesAt: ends ? parseDate(ends, now) : null,
    travelWindow: dep ? { from: parseDate(dep[1], now), to: parseDate(dep[2], now), text: `Departure period ${dep[1]} - ${dep[2]}` } : parseTravelWindow(text, now),
    eligibility: restr ?? `Public fare (${origin === 'HKG' ? 'Hong Kong' : 'Australia'} point of sale)`,
    eligible: !/domestic helper/i.test(headline),
    entryMethod: code ? `Promo code ${code}` : null,
    url,
    source: 'cathaypacific',
    // Cathay routes everything via Hong Kong, so a network-wide sale reaches HKG unless it says otherwise.
    relevance: excl && /hong kong/i.test(excl)
      ? (/UK|Europe/i.test(text) ? { tier: 'reachable', destination: 'UK / Ireland (Belfast reachable)' } : null)
      : relevance(`${headline} hong kong`),
    notes: excl ? `Sale excludes ${excl}` : null,
  };
}

// ---------------------------------------------------------------- Virgin Australia specials (sale T&Cs)
export function parseVirginSpecials(html, url, now) {
  const text = htmlToText(html);
  const out = [];
  const re = /([A-Z][A-Za-z' ]{3,40}?) \*?On sale from ([^.]+?) to ([^.,]+?\d{4})(?:, unless sold out prior)?\.([\s\S]{0,1500}?)(?= [A-Z][A-Za-z' ]{3,40} \*?(?:On sale|Terms)|$)/g;
  for (const m of text.matchAll(re)) {
    const clause = m[4];
    const rel = relevance(clause);
    if (!rel) continue;
    const dests = clause.match(/destinations include ([^.]+)\./)?.[1];
    out.push({
      type: 'sale',
      title: `Virgin Australia: ${m[1].trim()}${dests ? ` (${dests})` : ''}`,
      origin: /Sydney/.test(clause) ? 'SYD' : 'AU',
      value: null,
      closesAt: parseDate(m[3], now),
      travelWindow: parseTravelWindow(clause, now),
      eligibility: 'Public fare (Australia point of sale)',
      eligible: true,
      url,
      source: 'virginaustralia',
      relevance: rel,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Emirates special offers (public JSON)
export function parseEmiratesOffers(json, country, now) {
  const out = [];
  for (const r of json?.results ?? []) {
    if (!r.title || !/(miles|fare|flight|sale|seat)/i.test(r.title)) continue;
    if (/birthday|store|dubai|helsinki|upgrade|tier|seats?\b/i.test(`${r.title} ${r.url}`)) continue;
    const end = r.endDate?.match(/^(\d{4})(\d{2})(\d{2})/);
    out.push({
      type: /miles/i.test(r.title) ? 'points' : 'sale',
      title: `Emirates: ${r.title}${r.summary ? ` - ${r.summary}` : ''}`,
      origin: country === 'hk' ? 'HKG' : 'AU',
      value: null,
      closesAt: end ? parseDate(`${end[1]}-${end[2]}-${end[3]}`, now) : null,
      eligibility: /student/i.test(r.title) ? 'Students only' : `Emirates ${country.toUpperCase()} offer`,
      eligible: true,
      url: r.url?.startsWith('http') ? r.url : `https://www.emirates.com${r.url || `/${country}/english/special-offers/`}`,
      source: `emirates-${country}`,
      relevance: relevance(r.title) ?? (/miles/i.test(r.title) ? { tier: 'points', destination: 'Any (points)' } : { tier: 'flexible', destination: 'Any (Emirates network)' }),
    });
  }
  return out;
}

// ---------------------------------------------------------------- Point Hacks (RSS, points/redemptions)
const PH_RELEVANT = /asia miles|cathay|qantas points|velocity points|bonus (points|miles)|sign[- ]?up bonus|reward (seat|flight)s?|classic (flight )?rewards?|avios|\bsale\b|hong kong|ireland|belfast|points? (deal|offer|promo)|transfer bonus/i;
export function parsePointHacksFeed(xml, now, maxAgeDays = 60) {
  const out = [];
  for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const title = decodeEntities(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim();
    const link = it.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const pub = Date.parse(it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '');
    if (!PH_RELEVANT.test(title) || !(now - pub < maxAgeDays * 86400000)) continue;
    out.push({
      type: 'points',
      title: `Point Hacks: ${title}`,
      origin: 'AU',
      value: null,
      closesAt: null,
      eligibility: 'Article/guide (AU programs)',
      eligible: true,
      url: link,
      postedAt: new Date(pub).toISOString(),
      source: 'pointhacks',
      relevance: relevance(title) ?? { tier: 'points', destination: 'Any (points)' },
    });
  }
  return out;
}

// ---------------------------------------------------------------- source registry
// Multi-feed sources keep what they got when one feed fails; the failure goes in the source notes.
// Throws only when every feed failed (rethrowing the first error so blocks stay classified).
async function eachFeed(ctx, list, fn) {
  const items = []; const errors = [];
  for (const x of list) {
    try { items.push(...await fn(x)); } catch (e) { errors.push(e); ctx.note(`${x}: ${e.message}`); }
  }
  if (errors.length === list.length) throw errors[0];
  return items;
}

// Each entry: async (ctx) => raw items. ctx.get(url, {json}) throws BlockedError/DisallowedError.
export const SOURCES = {
  'ozbargain-competitions': async (ctx) => {
    const items = [];
    for (let p = 0; p < 10; p++) {
      const html = await ctx.get(`${OZB}/competition${p ? `?page=${p}` : ''}`);
      const got = parseOzbCompetitions(html, ctx.now);
      if (!p && !got.length) throw new Error('no competitions parsed from page 1 (layout change?)');
      items.push(...got);
      if (!got.length || !html.includes(`competition?page=${p + 1}`)) break;
    }
    return items;
  },
  'ozbargain-deals': async (ctx) => {
    const feeds = { 'hong-kong': '/location/hong-kong/feed', uk: '/location/united-kingdom/feed', ireland: '/location/ireland/feed', travel: '/cat/travel/feed' };
    return eachFeed(ctx, Object.keys(feeds), async (name) => parseOzbDealFeed(await ctx.get(OZB + feeds[name]), ctx.now, name));
  },
  'competitions.com.au': async (ctx) => {
    const listings = [];
    for (let p = 1; p <= 8; p++) {
      let html;
      try {
        html = await ctx.get(`${CCA}/travel-competitions/${p > 1 ? `?page=${p}` : ''}`);
      } catch (e) {
        if (p > 1 && /HTTP 404/.test(e.message)) break; // ran past the last page
        throw e;
      }
      const got = parseCcaList(html);
      if (p === 1 && !got.length) throw new Error('no travel listings parsed from page 1 (layout change?)');
      const fresh = got.filter((g) => !listings.some((l) => l.id === g.id));
      listings.push(...fresh);
      if (!fresh.length) break;
    }
    // Only open the detail page when the title could be relevant (destination, voucher or a vague "holiday").
    const items = [];
    for (const l of listings.filter((x) => !x.expired && (relevance(x.title) || /\b(holiday|trip|getaway|adventure|escape|travel)\b/i.test(x.title) && !/\bto [A-Z]|\bin [A-Z]/.test(x.title.replace(/\b(to|in) (Hong Kong|London|Dublin|Belfast|Ireland|Northern Ireland|the UK|UK|England|Scotland|Europe)\b/g, ''))))) {
      items.push(parseCcaDetail(await ctx.get(l.url), l, ctx.now));
    }
    ctx.note(`${listings.length} travel listings, ${items.length} detail pages opened`);
    return items;
  },
  'aussiecomps.com': async (ctx) => {
    const seen = new Map();
    const counts = {};
    for (const q of ['flights', 'trip', 'holiday', 'travel', 'voucher', 'kong', 'ireland', 'belfast', 'london', 'europe']) {
      const got = parseAussieCompsList(await ctx.get(`${AC}/index.php?cat_id=0&p=&search=${q}`), ctx.now);
      counts[q] = got.length;
      for (const l of got) seen.set(l.id, l);
    }
    // Broad terms always have listings; zero means a soft block or a layout change, not "no comps".
    if (!counts.flights && !counts.travel) throw new Error(`no listings parsed for broad searches (layout change or soft block): ${JSON.stringify(counts)}`);
    ctx.note(`listings per search ${JSON.stringify(counts)}`);
    const items = [];
    for (const l of seen.values()) {
      if (!relevance(l.title)) continue;
      items.push(parseAussieCompsDetail(await ctx.get(l.url), l, ctx.now));
    }
    ctx.note(`${seen.size} keyword matches, ${items.length} relevant`);
    return items;
  },
  'cathaypacific': async (ctx) => {
    const items = [];
    for (const [loc, origin] of [['en_AU', 'SYD'], ['en_HK', 'HKG']]) {
      const home = await ctx.get(`https://flights.cathaypacific.com/${loc}.html`);
      const links = [...new Set(home.match(new RegExp(`https://flights\\.cathaypacific\\.com/${loc}/offers/[a-z0-9-]+\\.html`, 'g')) ?? [])];
      for (const u of links) {
        const o = parseCathayOffer(await ctx.get(u), u, ctx.now, origin);
        if (o) items.push(o);
      }
    }
    return items;
  },
  'virginaustralia': async (ctx) => {
    const u = 'https://www.virginaustralia.com/au/en/specials/';
    return parseVirginSpecials(await ctx.get(u), u, ctx.now);
  },
  'emirates': async (ctx) => {
    return eachFeed(ctx, ['au', 'hk'], async (c) => parseEmiratesOffers(
      await ctx.get(`https://www.emirates.com/service/special-offers/?country=${c}&language=english&tier=&isMobile=false&offerType=`, { json: true }), c, ctx.now));
  },
  'pointhacks': async (ctx) => {
    return eachFeed(ctx, ['/news/feed/', '/category/credit-cards/feed/'], async (f) => parsePointHacksFeed(await ctx.get(`https://www.pointhacks.com.au${f}`), ctx.now));
  },
  // Pages checked for access only: they either block automated clients or render offers client-side.
  // We record the outcome so the report shows they were tried; nothing is parsed from them.
  'probe-only': async (ctx) => {
    const pages = {
      'Qantas flight deals': 'https://www.qantas.com/en-au/book/flight-deals',
      'Singapore Airlines AU promotions': 'https://www.singaporeair.com/en_UK/au/plan-travel/promotions/',
      'Discover Hong Kong deals (HKTB)': 'https://www.discoverhongkong.com/eng/deals.html',
      'Discover Northern Ireland offers': 'https://discovernorthernireland.com/plan-your-trip/offers/',
      'Tourism Ireland AU offers': 'https://www.ireland.com/en-au/plan-your-trip/offers/offers-centre/',
      'Webjet flight deals': 'https://www.webjet.com.au/flights/deals/',
      'Executive Traveller RSS': 'https://www.executivetraveller.com/rss',
      'Skyscanner SYD-HKG': 'https://www.skyscanner.com.au/routes/syda/hkg/sydney-to-hong-kong.html',
      'Google Flights search': 'https://www.google.com/travel/flights/search?q=SYD%20to%20BFS',
      'Belfast International Airport': 'https://www.belfastairport.com/',
    };
    for (const [name, u] of Object.entries(pages)) {
      try {
        const html = await ctx.get(u);
        const rel = /belfast|hong kong|dublin|london/i.test(htmlToText(html)) ? 'no parsable fares/competitions in static HTML' : 'no matching offers in static HTML';
        ctx.probe(name, u, { ok: true, result: rel });
      } catch (e) {
        ctx.probe(name, u, { ok: false, blocked: e instanceof BlockedError, disallowed: e instanceof DisallowedError, error: e.message });
      }
    }
    return [];
  },
};
