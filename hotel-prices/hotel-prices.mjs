// Scrape hotel room prices near a landmark using Playwright (Chromium).
// Usage: node hotel-prices.mjs [--checkin 2026-10-28] [--nights 1] [--adults 2]
//        [--near "Bay View Villas Hobart"] [--headful] [--out prices.json]
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);

const checkin = args.checkin || '2026-10-28';
const nights = Number(args.nights || 1);
const adults = Number(args.adults || 2);
const near = args.near || 'Bay View Villas Hobart';
const checkout = new Date(new Date(checkin).getTime() + nights * 86400000).toISOString().slice(0, 10);

const parsePrice = (s) => {
  const m = s?.replace(/,/g, '').match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
};

async function booking(page) {
  const url = new URL('https://www.booking.com/searchresults.html');
  url.search = new URLSearchParams({
    ss: near, checkin, checkout, group_adults: adults, no_rooms: 1, group_children: 0,
    selected_currency: 'AUD', order: 'distance_from_search', lang: 'en-gb',
  });
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('[aria-label="Dismiss sign-in info."]').click({ timeout: 5000 }).catch(() => {});
  await page.waitForSelector('[data-testid="property-card"]', { timeout: 30000 });
  return page.$$eval('[data-testid="property-card"]', (cards) =>
    cards.map((c) => ({
      name: c.querySelector('[data-testid="title"]')?.textContent?.trim(),
      price: c.querySelector('[data-testid="price-and-discounted-price"]')?.textContent?.trim(),
      distance: c.querySelector('[data-testid="distance"]')?.textContent?.trim(),
      room: c.querySelector('[data-testid="recommended-units"] h4, [data-testid="recommended-units"] span')?.textContent?.trim(),
      rating: c.querySelector('[data-testid="review-score"] > div')?.textContent?.trim(),
      link: c.querySelector('a[data-testid="title-link"]')?.href?.split('?')[0],
    }))
  ).then((rows) => rows.map((r) => ({ source: 'booking.com', ...r, priceAud: null })));
}

async function googleHotels(page) {
  const q = `hotels near ${near}`;
  const url = `https://www.google.com/travel/search?q=${encodeURIComponent(q)}&hl=en-AU&gl=au&curr=AUD` +
    `&qs=&ap=&ts=&checkin=${checkin}&checkout=${checkout}&adults=${adults}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByRole('button', { name: /accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(5000);
  return page.$$eval('div[jsname="mutHjb"], div.uaTTDe', (cards) =>
    cards.map((c) => ({
      name: c.querySelector('h2')?.textContent?.trim(),
      price: [...c.querySelectorAll('span')].map((s) => s.textContent).find((t) => /^A?\$\d/.test(t || ''))?.trim(),
    }))
  ).then((rows) => rows.filter((r) => r.name).map((r) => ({ source: 'google-hotels', ...r })));
}

const browser = await chromium.launch({ headless: !args.headful });
const ctx = await browser.newContext({
  locale: 'en-AU', timezoneId: 'Australia/Hobart',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const results = [];
for (const [name, fn] of [['booking.com', booking], ['google-hotels', googleHotels]]) {
  const page = await ctx.newPage();
  try {
    const rows = await fn(page);
    console.error(`${name}: ${rows.length} results`);
    results.push(...rows);
  } catch (e) {
    console.error(`${name} failed: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `hotel-prices-${name}-error.png` }).catch(() => {});
  }
  await page.close();
}
await browser.close();

for (const r of results) r.priceAud = parsePrice(r.price);
results.sort((a, b) => (a.priceAud ?? Infinity) - (b.priceAud ?? Infinity));

console.log(`\nPrices for ${adults} adults, ${nights} night(s), ${checkin} → ${checkout}, near "${near}"\n`);
console.table(results.map(({ source, name, priceAud, distance, room }) => ({ source, name, priceAud, distance, room })));
if (args.out) await writeFile(args.out, JSON.stringify({ checkin, checkout, adults, near, results }, null, 2));
