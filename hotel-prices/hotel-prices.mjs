// Scrape hotel room prices near a landmark using Playwright (Chromium).
// Usage: node hotel-prices.mjs [--checkin 2026-10-28] [--nights 1] [--adults 2]
//        [--near "Bay View Villas Hobart"] [--target "Bay View Villas"] [--headful] [--out prices.json]
// Exit codes: 0 = at least one source returned prices, 1 = no prices, 2 = bad arguments.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return out;
}

export function parsePrice(s) {
  const m = s?.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Keep the cheapest row per source + name; rows without a price go last.
export function normalise(rows) {
  const best = new Map();
  for (const r of rows) {
    const row = { ...r, priceAud: parsePrice(r.price) };
    if (!row.name) continue;
    const key = `${row.source}|${row.name.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || (row.priceAud ?? Infinity) < (prev.priceAud ?? Infinity)) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => (a.priceAud ?? Infinity) - (b.priceAud ?? Infinity));
}

class BlockedError extends Error {}

async function assertNotBlocked(page, response) {
  const status = response?.status();
  const body = (await page.textContent('body').catch(() => '')) || '';
  if (status === 403 || status === 429 || /detected as a robot|unusual traffic|captcha/i.test(body)) {
    throw new BlockedError(`blocked by site (HTTP ${status})`);
  }
}

const sources = {
  'booking.com': async (page, q) => {
    const url = new URL('https://www.booking.com/searchresults.html');
    url.search = new URLSearchParams({
      ss: q.near, checkin: q.checkin, checkout: q.checkout, group_adults: q.adults, no_rooms: 1,
      group_children: 0, selected_currency: 'AUD', order: 'distance_from_search', lang: 'en-gb',
    });
    const res = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertNotBlocked(page, res);
    await page.locator('[aria-label="Dismiss sign-in info."]').click({ timeout: 5000 }).catch(() => {});
    await page.waitForSelector('[data-testid="property-card"]', { timeout: 30000 });
    return page.$$eval('[data-testid="property-card"]', (cards) =>
      cards.map((c) => ({
        name: c.querySelector('[data-testid="title"]')?.textContent?.trim(),
        price: c.querySelector('[data-testid="price-and-discounted-price"]')?.textContent?.trim(),
        room: c.querySelector('[data-testid="recommended-units"] h4')?.textContent?.trim(),
        link: c.querySelector('a[data-testid="title-link"]')?.href?.split('?')[0],
      }))
    );
  },
  'google-hotels': async (page, q) => {
    const url = `https://www.google.com/travel/search?q=${encodeURIComponent(`hotels near ${q.near}`)}` +
      `&hl=en-AU&gl=au&curr=AUD&checkin=${q.checkin}&checkout=${q.checkout}&adults=${q.adults}`;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: /accept all/i }).click({ timeout: 5000 }).catch(() => {});
    await assertNotBlocked(page, res);
    await page.waitForSelector('div.uaTTDe, div[jsname="mutHjb"]', { timeout: 30000 });
    return page.$$eval('div[jsname="mutHjb"], div.uaTTDe', (cards) =>
      cards.map((c) => ({
        name: c.querySelector('h2')?.textContent?.trim(),
        price: [...c.querySelectorAll('span')].map((s) => s.textContent).find((t) => /^A?\$\d/.test(t || ''))?.trim(),
      }))
    );
  },
};

export async function run(opts) {
  const q = {
    checkin: opts.checkin || '2026-10-28',
    nights: Number(opts.nights || 1),
    adults: Number(opts.adults || 2),
    near: opts.near || 'Bay View Villas Hobart',
    target: opts.target || 'Bay View Villas',
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.checkin) || !(q.nights >= 1) || !(q.adults >= 1)) {
    throw Object.assign(new Error('invalid --checkin/--nights/--adults'), { exitCode: 2 });
  }
  q.checkout = new Date(Date.parse(q.checkin) + q.nights * 86400000).toISOString().slice(0, 10);

  const browser = await chromium.launch({ headless: !opts.headful });
  const ctx = await browser.newContext({
    locale: 'en-AU', timezoneId: 'Australia/Hobart',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });
  const status = {};
  const rows = [];
  for (const [name, fn] of Object.entries(sources)) {
    // One retry for timeouts; a block is final (retrying a block is hammering the site).
    for (let attempt = 1; attempt <= 2; attempt++) {
      const page = await ctx.newPage();
      try {
        const got = (await fn(page, q)).map((r) => ({ source: name, ...r }));
        rows.push(...got);
        status[name] = { ok: true, count: got.length, attempts: attempt };
        break;
      } catch (e) {
        const blocked = e instanceof BlockedError;
        status[name] = { ok: false, blocked, error: e.message.split('\n')[0], attempts: attempt };
        await page.screenshot({ path: `hotel-prices-${name}-error.png` }).catch(() => {});
        if (blocked) break;
      } finally {
        await page.close();
      }
    }
  }
  await browser.close();

  const results = normalise(rows);
  const target = results.filter((r) => r.name.toLowerCase().includes(q.target.toLowerCase()));
  return { query: q, fetchedAt: new Date().toISOString(), status, target, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const out = await run(opts);
    const { query: q, status, target, results } = out;
    for (const [s, st] of Object.entries(status)) {
      console.error(st.ok ? `${s}: ${st.count} results` : `${s}: ${st.blocked ? 'BLOCKED' : 'FAILED'} - ${st.error}`);
    }
    console.log(`\n${q.adults} adults, ${q.nights} night(s), ${q.checkin} -> ${q.checkout}, near "${q.near}"`);
    console.log(`Target "${q.target}": ${target.length ? target.map((t) => `$${t.priceAud} (${t.source})`).join(', ') : 'not found'}\n`);
    console.table(results.map(({ source, name, priceAud, room }) => ({ source, name, priceAud, room })));
    if (opts.out) await writeFile(opts.out, JSON.stringify(out, null, 2));
    process.exitCode = results.some((r) => r.priceAud) ? 0 : 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = e.exitCode ?? 1;
  }
}
