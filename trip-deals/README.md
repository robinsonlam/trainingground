# trip-deals

Finds ways to get to **Belfast** and **Hong Kong** around **Sep–Oct 2027**, departing **Sydney or Hong Kong**:
competitions/giveaways open to AU (or HK) residents, airline sales, and points/frequent-flyer offers.

```
npm start                 # node trip-deals.mjs --out results.json --report RESULTS.md
node trip-deals.mjs --sources ozbargain-competitions,cathaypacific --delay 1000
npm test                  # unit tests (offline)
npm run test:e2e          # live run against the real sites (~4 min)
```

No dependencies (Node ≥ 20, built-in `fetch`). Options: `--out FILE` (JSON), `--report FILE` (markdown),
`--sources a,b`, `--delay MS` (per-host pacing, default 800), `--now ISO` (pretend date).
Exit codes: 0 = data collected, 1 = every source failed, 2 = bad arguments.

## What it does

1. Fetches each source (RSS, public JSON, or static HTML), checking `robots.txt` first.
2. Parses candidates into `{type, title, destination, origin, value, closesAt, travelWindow, eligibility, url, source, fetchedAt}`
   (plus `tier`, `termsUrl`, `entryMethod`, `travelWindowFit`, `notes`).
3. Classifies relevance: **direct** (Belfast/Northern Ireland, Hong Kong), **reachable** (UK/Ireland — Belfast is a short hop),
   **flexible** (travel/flight vouchers usable anywhere), **points** (frequent-flyer offers). Everything else is dropped.
4. Dedupes (same item twice, or the same competition on several aggregators), then excludes items that are
   expired, not open to AU/HK residents, or whose stated travel window can't cover Sep–Oct 2027 (kept in `excluded` with a reason).
5. Prints a table sorted soonest-closing first and optionally writes JSON + `RESULTS.md`.

| Source | Method | Gives |
|---|---|---|
| OzBargain competitions | HTML list (`/competition`) | comps with open-to, prize pool, closing date, entry link |
| OzBargain deals | RSS (`/location/hong-kong`, `/united-kingdom`, `/ireland`, `/cat/travel`) | fare deals + points promos with expiry |
| competitions.com.au | travel category HTML + JSON-LD on detail pages | comps with end date, eligibility, T&Cs link |
| aussiecomps.com | keyword search HTML + detail pages | comps with closing date, eligibility, entry link |
| Cathay Pacific | offer pages (AU + HK) | promo codes, offer end, departure period |
| Virgin Australia | specials page T&Cs | sale periods and travel windows |
| Emirates | public special-offers JSON (AU + HK) | fare / Skywards Miles offers |
| Point Hacks | RSS | points & redemption news |
| Probes only | Qantas, SIA, Discover HK, Discover NI, Tourism Ireland, Webjet, Executive Traveller, Skyscanner, Google Flights, Belfast airport | records whether each is reachable/blocked; nothing parsed |

## Rules it follows

- Identifies itself honestly (`trip-deals-research/1.0`); no browser spoofing, stealth, proxies or CAPTCHA solving.
- `robots.txt` disallow → not fetched. HTTP 403/429 or a CAPTCHA/bot page → recorded as **blocked**, never retried.
  Only network errors/timeouts get one retry.
- Never enters competitions; only lists them with their links.
- Nothing is hand-entered: every item comes from a fetched page and links back to it.
- An HTML source whose first page parses to nothing fails loudly (layout change / soft block) instead of reporting "no deals".

Live fares for SYD→BFS, SYD→HKG and HKG→BFS aren't available to automated clients from any source used here
(Google Flights search is disallowed by `robots.txt`; fare search sites block or require JS), so the report lists
recent expired deals as price benchmarks and links to set up fare alerts manually.
