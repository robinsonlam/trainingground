import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, parseDate, sydneyOffset, parseTravelWindow, windowFit, relevance, eligibleAuHk, robotsAllows,
  detectBlock, normaliseItem, dedupe, applyFilters, sortItems, formatTable, FIELDS,
} from '../lib.mjs';
import {
  parseOzbCompetitions, parseOzbDealFeed, parseCcaList, parseCcaDetail, parseAussieCompsList, parseAussieCompsDetail,
  parseCathayOffer, parseVirginSpecials, parseEmiratesOffers, parsePointHacksFeed, priceNear, SOURCES,
} from '../sources.mjs';
import { run, renderReport, makeFetcher } from '../trip-deals.mjs';

const NOW = new Date('2026-10-30T00:00:00Z');

test('parseArgs handles values and boolean flags', () => {
  assert.deepEqual(parseArgs(['--out', 'x.json', '--report', '--delay', '0']), { out: 'x.json', report: true, delay: '0' });
});

test('sydneyOffset follows AEST/AEDT changeover', () => {
  assert.equal(sydneyOffset(2026, 7, 1), '+10:00');
  assert.equal(sydneyOffset(2026, 10, 3), '+10:00'); // first Sunday of Oct 2026 is the 4th
  assert.equal(sydneyOffset(2026, 10, 4), '+11:00');
  assert.equal(sydneyOffset(2027, 1, 15), '+11:00');
});

test('parseDate reads the formats the sources use', () => {
  assert.equal(parseDate('30 November 2026', NOW), '2026-11-30T23:59:00+11:00');
  assert.equal(parseDate('01 Dec 2026', NOW), '2026-12-01T23:59:00+11:00');
  assert.equal(parseDate('13/12/2026', NOW), '2026-12-13T23:59:00+11:00');
  assert.equal(parseDate('2026-11-30T23:59:59+10:00', NOW), '2026-11-30T23:59:59+10:00');
  assert.equal(parseDate('2027-03-31', NOW), '2027-03-31T23:59:00+11:00');
  assert.equal(parseDate('31 Oct 6:00pm', NOW), '2026-10-31T18:00:00+11:00');
  assert.equal(parseDate('15 Jan', NOW), '2027-01-15T23:59:00+11:00', 'year rolls forward when the date has passed');
  assert.equal(parseDate('Ends Nov 30', NOW), '2026-11-30T23:59:00+11:00');
  assert.equal(parseDate('soon', NOW), null);
  assert.equal(parseDate(undefined, NOW), null);
});

test('parseTravelWindow finds explicit and month-range windows', () => {
  const a = parseTravelWindow('For travel on selected dates between 17 January 2027 to 14 March 2027 and more', NOW);
  assert.equal(a.from.slice(0, 10), '2027-01-17');
  assert.equal(a.to.slice(0, 10), '2027-03-14');
  const b = parseTravelWindow('Fares are for travel from 21 April to 8 June 2027.', NOW);
  assert.equal(b.from.slice(0, 10), '2027-04-21');
  const c = parseTravelWindow('Travel must be completed by 30 June 2027.', NOW);
  assert.deepEqual([c.from, c.to.slice(0, 10)], [null, '2027-06-30']);
  const d = parseTravelWindow('Singapore Air Rtn: SYD $753 (Nov-Sep) @ BTF', NOW);
  assert.deepEqual([d.from.slice(0, 10), d.to.slice(0, 10)], ['2026-11-01', '2027-09-30']);
  const e = parseTravelWindow('Europe O/W Mar-May 27: Paris SYD $675', NOW);
  assert.deepEqual([e.from.slice(0, 7), e.to.slice(0, 10)], ['2027-03', '2027-05-31']);
  assert.equal(parseTravelWindow('Win a trip for two to London', NOW), null);
});

test('windowFit compares against Sep-Oct 2027', () => {
  assert.equal(windowFit({ from: '2026-10-22T00:00:00+11:00', to: '2027-07-31T23:59:00+10:00' }), 'no');
  assert.equal(windowFit({ from: '2026-03-31T00:00:00+11:00', to: '2027-10-31T23:59:00+11:00' }), 'yes');
  assert.equal(windowFit({ from: '2028-01-01T00:00:00+11:00', to: null }), 'no');
  assert.equal(windowFit(null), 'unknown');
  assert.equal(windowFit({ from: '2026-11-01T00:00:00+11:00', to: null }), 'unknown');
});

test('relevance tiers destinations and ignores other trips', () => {
  assert.equal(relevance('Win a trip to Belfast')?.tier, 'direct');
  assert.equal(relevance('Win flights to Northern Ireland').destination, 'Belfast / Northern Ireland');
  assert.equal(relevance('Return flights SYD-Hong Kong $891')?.destination, 'Hong Kong');
  assert.equal(relevance('Win a Trip for Two to London')?.tier, 'reachable');
  assert.equal(relevance('Dublin Return SYD $1074')?.tier, 'reachable');
  assert.equal(relevance('Win a $4000 Flight Centre (Flights & Accommodation) Voucher')?.tier, 'flexible');
  assert.equal(relevance('Win a 5-Night Stay at a Fiji Resort + $1000 Flights Credit'), null);
  assert.equal(relevance('Win an All-Inclusive Trip For 2 to Bali'), null);
  assert.equal(relevance('Win a UKULELE'), null, '"UK" must be a whole word');
  assert.equal(relevance('Win 1 of 2 x $1000 Discovery Holiday Parks Vouchers'), null, 'regression: holiday parks are not travel vouchers');
});

test('priceNear picks the fare for the target destination', () => {
  assert.equal(priceNear('China Southern Return: SYD-Istanbul $876, BNE-Madrid $979, SYD-Budapest $911/Paris $1001/London $1071 @ IWTF'), 'London $1071');
  assert.equal(priceNear('Etihad Return: Dublin SYD $987 MEL $1029, Rome SYD $1006'), 'Dublin ex SYD $987');
  assert.equal(priceNear('Singapore Airlines Rtn Flights To Hong Kong: PER $588, SYD $699, BNE $707'), 'Hong Kong ex SYD $699');
  assert.equal(priceNear('Singapore Air to Singapore Rtn: PER $522, SYD $753'), 'SYD $753');
  assert.equal(priceNear('no price here'), null);
  assert.equal(priceNear('Cathay Pacific: New York via Hong Kong Return: SYD fr $1439'), 'SYD $1439', 'regression: via HK is not the destination');
});

test('eligibleAuHk reads open-to text', () => {
  assert.equal(eligibleAuHk('Open to: Australia-wide'), true);
  assert.equal(eligibleAuHk('Open to residents in NSW, VIC, QLD'), true);
  assert.equal(eligibleAuHk('Open globally to entrants aged 18+'), true);
  assert.equal(eligibleAuHk('Open to New Zealand residents only'), false);
  assert.equal(eligibleAuHk('You must act fast'), null, 'lower-case "act" is not the ACT');
  assert.equal(eligibleAuHk(null), null);
  assert.equal(eligibleAuHk('Open to AU & NZ residents aged 18+.'), true, 'regression: AU abbreviation');
});

test('robotsAllows honours the * group, wildcards and longest match', () => {
  const r = 'User-agent: AhrefsBot\nDisallow: /\n\nUser-agent: *\nDisallow: /search/\nDisallow: /*/feed/\nAllow: /news/feed/\nDisallow: /travel/flights/search\n';
  assert.equal(robotsAllows(r, '/competition'), true);
  assert.equal(robotsAllows(r, '/search/?q=x'), false);
  assert.equal(robotsAllows(r, '/foo/feed/'), false);
  assert.equal(robotsAllows(r, '/news/feed/'), true);
  assert.equal(robotsAllows(r, '/travel/flights/search?q=SYD'), false);
  assert.equal(robotsAllows('', '/anything'), true);
});

test('detectBlock spots 403s, captcha redirects and robot pages', () => {
  assert.equal(detectBlock(403, ''), 'HTTP 403');
  assert.equal(detectBlock(200, '', 'https://x.com/sttc/px/captcha-v2/index.html'), 'redirected to CAPTCHA');
  assert.equal(detectBlock(200, '<p>Please verify you are human</p>'), 'bot-check page');
  assert.equal(detectBlock(200, '<p>normal page</p>'), null);
});

const item = (o) => normaliseItem({ type: 'competition', title: 'Win a trip to London', url: 'https://a/1', source: 'a', ...o }, { now: NOW });

test('normaliseItem produces the documented schema', () => {
  const n = item({ value: '$20,700', closesAt: '2026-11-30T23:59:00+11:00', eligibility: 'Open to: Australia-wide' });
  for (const f of FIELDS) assert.ok(f in n, `missing ${f}`);
  assert.equal(n.valueAud, 20700);
  assert.equal(n.eligible, true);
  assert.equal(n.tier, 'reachable');
});

test('dedupe merges same comp across aggregators and same item twice', () => {
  const a = item({ title: 'Win a Trip for Two to London & 1 of 100 Ebenezer Merchandise Packs', closesAt: '2026-11-30T23:59:00+11:00', source: 'cca', url: 'https://cca/1' });
  const b = item({ title: 'Win a Trip For 2 to London + 1 of 100 Ebenezer Merch Packs', closesAt: '2026-11-30T23:59:59+10:00', source: 'ac', url: 'https://ac/2', termsUrl: 'https://laser/x' });
  const c = item({ title: 'Win a Trip to Belfast', closesAt: '2026-11-30T23:59:00+11:00', source: 'ac', url: 'https://ac/3' });
  const d = item({ title: 'Win a $20,000 Arrival Gift Voucher or 1 of 2 $4,000 in Qantas Flights', value: '$31,500', closesAt: '2026-11-18T15:00:00+11:00', source: 'ozb', url: 'https://ozb/1' });
  const e = item({ title: 'Win a $20K Arrival Travel Voucher + $4000 of Qantas Flight Vouchers', value: '$31,500', closesAt: '2026-11-18T23:59:00+11:00', source: 'ac', url: 'https://ac/9' });
  const out = dedupe([a, b, { ...a }, c, d, e]);
  assert.equal(out.length, 3, 'regression: reworded title with same day + value merges');
  assert.equal(out[0].termsUrl, 'https://laser/x', 'blank fields filled from the duplicate');
  assert.deepEqual(out[0].alsoListedAt, ['https://ac/2']);
});

test('applyFilters drops expired, ineligible, wrong-window and irrelevant items', () => {
  const { kept, excluded, irrelevant } = applyFilters([
    item({ title: 'open', relevance: { tier: 'direct', destination: 'Hong Kong' }, closesAt: '2026-11-01T00:00:00+11:00' }),
    item({ title: 'gone', relevance: { tier: 'direct', destination: 'Hong Kong' }, closesAt: '2026-10-01T00:00:00+10:00' }),
    item({ title: 'nz', relevance: { tier: 'direct', destination: 'Hong Kong' }, eligibility: 'Open to New Zealand residents only' }),
    item({ title: 'early', relevance: { tier: 'direct', destination: 'Hong Kong' }, travelWindow: { from: null, to: '2027-07-31T23:59:00+10:00' } }),
    item({ title: 'Win a toaster' }),
  ], NOW);
  assert.deepEqual(kept.map((k) => k.title), ['open']);
  assert.deepEqual(excluded.map((x) => [x.title, x.excludedBecause]), [
    ['gone', 'expired'], ['nz', 'not open to (general) AU/HK residents'], ['early', 'travel window does not cover Sep-Oct 2027']]);
  assert.equal(irrelevant, 1);
});

test('sortItems: soonest closing first, open-ended last, then tier', () => {
  const s = sortItems([
    item({ title: 'z', closesAt: null }),
    item({ title: 'b', closesAt: '2026-12-01T00:00:00+11:00' }),
    item({ title: 'a', closesAt: '2026-11-01T00:00:00+11:00' }),
    item({ title: 'y', closesAt: null, relevance: { tier: 'direct', destination: 'Hong Kong' } }),
  ]);
  assert.deepEqual(s.map((x) => x.title), ['a', 'b', 'y', 'z']);
  assert.match(formatTable(s), /^closes/);
});

// ---------------------------------------------------------------------------- parsers (hand-made fixtures)

test('parseOzbCompetitions reads title, open-to, prize pool, expiry and entry URL', () => {
  const html = `<div class="node node-competition node-teaser" id="node1">
    <a href="/goto/1" title="Go to https://promo.example/win-london">x</a>
    <h2 class="title" id="title1" data-title="Win Return Flights for 2 to London from Brand"><a href="/node/1">x</a></h2>
    <ul class="competition-list-meta"><li><span title="Total prize pool"><i class="fa"></i>Prize pool $9,000.00</span></li>
    <li><span title="Open to"><i class="fa"></i>Australia-wide</span></li>
    <li><span title="Entry methods"><i class="fa"></i>Website</span></li></ul>
    <span class="nodeexpiry"><i class="fa fa-calendar"></i> 31 Oct 6:00pm <span class="marker">Tomorrow</span></span></div>`;
  const [c] = parseOzbCompetitions(html, NOW);
  assert.equal(c.title, 'Win Return Flights for 2 to London from Brand');
  assert.equal(c.value, '$9,000.00');
  assert.equal(c.eligible, true);
  assert.equal(c.closesAt, '2026-10-31T18:00:00+11:00');
  assert.equal(c.termsUrl, 'https://promo.example/win-london');
  assert.equal(c.url, 'https://www.ozbargain.com.au/node/1');
});

test('parseOzbDealFeed keeps flights/points items with expiry and SYD price', () => {
  const xml = `<rss><channel>
    <item><title>Return Flights SYD &#x2194; Hong Kong $891, SYD &#x2194; Singapore $879 @ Qantas</title><link>https://www.ozbargain.com.au/node/9</link>
    <pubDate>Tue, 28 Jul 2026 10:00:00 +1000</pubDate><ozb:meta expiry="2026-08-05T00:00:00+10:00" url="https://qantas.example/sale" /></item>
    <item><title>Antler Suitcase $117 Delivered</title><link>https://www.ozbargain.com.au/node/8</link><pubDate>Tue, 28 Jul 2026 10:00:00 +1000</pubDate></item>
    <item><title>Double Points with Virgin Australia (Fly 12/10-30/11)</title><link>https://www.ozbargain.com.au/node/7</link><pubDate>Tue, 28 Jul 2026 10:00:00 +1000</pubDate></item>
  </channel></rss>`;
  const out = parseOzbDealFeed(xml, NOW, 'hong-kong');
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'sale');
  assert.equal(out[0].value, 'Hong Kong $891');
  assert.equal(out[0].origin, 'SYD');
  assert.equal(out[0].closesAt, '2026-08-05T00:00:00+10:00');
  assert.equal(out[1].type, 'points');
  assert.equal(out[1].relevance.tier, 'points');
});

test('parseCcaList + parseCcaDetail use the card and JSON-LD Event', () => {
  const list = `<article class="competition-card" data-comp-id="76098" data-expired="false">
    <span class="bg-green-700 text-white">\n$20,700\n</span>
    <a href="/win-trip-two-london/76098/" target="_self"><h3 class="font-bold" title="x">\nWin a Trip for Two to London\n</h3></a>
    <div>Ends Nov 30</div></article>`;
  const [l] = parseCcaList(list);
  assert.deepEqual([l.id, l.value, l.url], ['76098', '$20,700', 'https://www.competitions.com.au/win-trip-two-london/76098/']);
  const detail = `<script type="application/ld+json">{"@type":"Event","name":"Win a Trip for Two to London","description":"**What are the prizes?** A trip for two to London. Travel must be completed by 30 June 2027.","endDate":"2026-11-30T23:59:59+10:00","location":{"url":"https://promo.example/london"}}</script>
    <p>Open to residents in NSW, VIC, QLD, SA, WA, TAS, NT, ACT. Verified daily</p>`;
  const d = parseCcaDetail(detail, l, NOW);
  assert.equal(d.closesAt, '2026-11-30T23:59:59+10:00');
  assert.equal(d.termsUrl, 'https://promo.example/london');
  assert.equal(d.eligible, true);
  assert.equal(d.travelWindow.to.slice(0, 10), '2027-06-30');
});

test('parseAussieCompsList + detail', () => {
  const list = `<!-- BETWEEN EACH LISTING --><tr><td><a href="/index.php?id=28370&cat_id=0&p=&search=#onads"><img alt="Win a $4000 Flight Centre (Flights &amp; Accommodation) Voucher" /></a></td>
    <td>desc</td><td>$&nbsp;5,000</td><td>19/12/2026</td></tr>`;
  const [l] = parseAussieCompsList(list, NOW);
  assert.deepEqual([l.id, l.value, l.closesAt.slice(0, 10)], ['28370', '$5,000', '2026-12-19']);
  const d = parseAussieCompsDetail(`<b>${l.title}</b> |Closes^: 19 December 2026 | Open to Australian residents aged 18+. |ENTER_HERE:| https://www.aussiecomps.com/ps/1 |`, l, NOW);
  assert.equal(d.eligible, true);
  assert.equal(d.termsUrl, 'https://www.aussiecomps.com/ps/1');
});

test('parseCathayOffer reads promo code, offer end and departure period', () => {
  const html = `<title>Student offer | Cathay AU</title><body>View details Up to 10% discount* Flights Student Fare: With You For Every Move Enjoy exclusive fares
    with our promotion code AUSTUDENT. Offer ends: 01 Dec 2026 Booking conditions Departure period 31 Mar 2026 - 31 Oct 2027 Valid student identification is required.</body>`;
  const o = parseCathayOffer(html, 'https://cx/offers/student.html', NOW, 'SYD');
  assert.equal(o.title, 'Cathay Pacific: Student Fare: With You For Every Move');
  assert.equal(o.entryMethod, 'Promo code AUSTUDENT');
  assert.equal(o.closesAt.slice(0, 10), '2026-12-01');
  assert.equal(o.travelWindow.to.slice(0, 10), '2027-10-31');
  assert.equal(o.relevance.destination, 'Hong Kong');
  assert.match(o.eligibility, /Students only/);
  const ex = parseCathayOffer('<body>View details Flights Save up to $180* off flights Enjoy savings. Sale excludes Hong Kong. Destinations Asia The UK and Europe Offer ends: 04 Nov 2026</body>', 'u', NOW, 'SYD');
  assert.equal(ex.relevance.tier, 'reachable', 'sale excluding HK still reaches the UK');
  assert.equal(parseCathayOffer('<body>View details Flights Airport Express tickets offer 20% off Airport Express tickets</body>', 'u', NOW, 'HKG'), null, 'regression: local perks are not fare sales');
  const dh = parseCathayOffer('<body>View details Flights Special Domestic Helper Fares Enjoy fares. Offer ends: 31 Mar 2027</body>', 'u', NOW, 'HKG');
  assert.equal(dh.eligible, false);
});

test('HTML sources fail loudly when page 1 parses to nothing', async () => {
  const ctx = { now: NOW, note: () => {}, get: async () => '<html>changed layout</html>' };
  await assert.rejects(SOURCES['ozbargain-competitions'](ctx), /layout change/);
  await assert.rejects(SOURCES['competitions.com.au'](ctx), /layout change/);
  await assert.rejects(SOURCES['aussiecomps.com'](ctx), /soft block/);
});

test('competitions.com.au source stops paging at a 404 instead of failing', async () => {
  const card = (id, t) => `<article data-comp-id="${id}" data-expired="false"><a href="/x/${id}/"><h3>${t}</h3></a></article>`;
  const pages = { '': card(1, 'Win a Trip to Hong Kong'), '?page=2': card(2, 'Win a Toaster') };
  const ctx = { now: NOW, note: () => {}, get: async (u) => {
    if (u.includes('/x/1/')) return '<script type="application/ld+json">{"@type":"Event","name":"Win a Trip to Hong Kong","endDate":"2026-12-01T23:59:00+11:00"}</script>';
    const k = u.split('/travel-competitions/')[1];
    if (k in pages) return pages[k];
    throw new Error(`HTTP 404 for ${u}`);
  } };
  const items = await SOURCES['competitions.com.au'](ctx);
  assert.deepEqual(items.map((i) => i.title), ['Win a Trip to Hong Kong']);
});

test('parseVirginSpecials extracts sale clauses that mention target destinations', () => {
  const html = `<p>WA Dream sale *Fares are for Perth flights.</p><p>Europe early bird sale *On sale from 12:01am AEST 6 October 2026 to 11:59pm AEST 30 October 2026, unless sold out prior.
    For travel on selected dates between 17 January 2027 to 14 March 2027. Flights from Sydney via Doha. Sale destinations include Paris, Dublin, London (Heathrow) and Manchester. Full T&amp;Cs.</p>`;
  const [s] = parseVirginSpecials(html, 'https://va/specials', NOW);
  assert.match(s.title, /Europe early bird sale/);
  assert.equal(s.closesAt.slice(0, 10), '2026-10-30');
  assert.equal(s.travelWindow.to.slice(0, 10), '2027-03-14');
  assert.equal(s.origin, 'SYD');
});

test('parseEmiratesOffers keeps fare/miles offers and skips personal ones', () => {
  const j = { results: [
    { title: 'Emirates Student Fares and extras', endDate: '20270331235900', url: '/au/english/special-offers/student-special-fares/' },
    { title: 'Skywards Exclusives Birthday Offer', url: '/x' },
    { title: 'Fly across Europe using Miles', url: '/au/english/skywards/partners/easyjet/' },
  ] };
  const out = parseEmiratesOffers(j, 'au', NOW);
  assert.deepEqual(out.map((o) => o.type), ['sale', 'points']);
  assert.equal(out[0].closesAt.slice(0, 10), '2027-03-31');
  assert.equal(out[1].url, 'https://www.emirates.com/au/english/skywards/partners/easyjet/');
});

test('parsePointHacksFeed keeps recent points articles only', () => {
  const xml = `<item><title>250,000 Asia Miles for $5,700: a deal?</title><link>https://ph/a</link><pubDate>Thu, 22 Oct 2026 01:00:00 +0000</pubDate></item>
    <item><title>Singapore Airlines new pyjamas</title><link>https://ph/b</link><pubDate>Thu, 22 Oct 2026 01:00:00 +0000</pubDate></item>
    <item><title>Old Velocity sale</title><link>https://ph/c</link><pubDate>Thu, 01 Jan 2026 01:00:00 +0000</pubDate></item>`;
  const out = parsePointHacksFeed(xml, NOW);
  assert.deepEqual(out.map((o) => o.url), ['https://ph/a']);
});

// ---------------------------------------------------------------------------- run() with a fake fetch

const fakeFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
  const [status, body] = hit ? hit[1] : [404, ''];
  return { status, url, text: async () => body };
};

test('run: blocked pages and robots-disallowed feeds are recorded, not retried; other data kept', async () => {
  let calls = 0;
  const f = fakeFetch({
    'https://www.pointhacks.com.au/robots.txt': [200, 'User-agent: *\nDisallow: /category/\n'],
    'https://www.pointhacks.com.au/news/feed/': [200, '<item><title>Cathay Asia Miles bonus points offer</title><link>https://ph/x</link><pubDate>Thu, 29 Oct 2026 01:00:00 +0000</pubDate></item>'],
    'https://www.virginaustralia.com/robots.txt': [404, ''],
    'https://www.virginaustralia.com/au/en/specials/': [403, 'Access denied'],
  });
  const data = await run({ sources: 'pointhacks,virginaustralia', delay: 0, now: NOW.toISOString(), fetchImpl: async (u, o) => { calls++; return f(u, o); } });
  assert.equal(data.status.virginaustralia.ok, false);
  assert.equal(data.status.virginaustralia.blocked, true);
  assert.equal(data.status.pointhacks.ok, true, 'one disallowed feed must not discard the other');
  assert.equal(data.status.pointhacks.count, 1);
  assert.match(data.status.pointhacks.notes.join(), /robots\.txt disallows/);
  assert.equal(calls, 4, 'robots x2, one feed, one blocked page: no retry of the block');
  const report = renderReport(data);
  assert.match(report, /\*\*blocked\*\*/);
  assert.match(report, /## Best bets/);
  assert.ok(report.includes('https://ph/x'), 'every kept item links to its source');
});

test('run: rejects bad arguments with exitCode 2', async () => {
  await assert.rejects(run({ sources: 'nope' }), (e) => e.exitCode === 2);
  await assert.rejects(run({ now: 'tomorrow' }), (e) => e.exitCode === 2);
  await assert.rejects(run({ delay: '-5' }), (e) => e.exitCode === 2);
});

test('makeFetcher retries a network error once then gives up', async () => {
  let n = 0;
  const f = makeFetcher({ delayMs: 0, fetchImpl: async () => { n++; throw new TypeError('fetch failed'); } });
  await assert.rejects(f.get('https://x.example/a'), /network error/);
  assert.equal(n, 4, 'robots.txt (2 tries, then treated as empty) + page (2 tries)');
});
