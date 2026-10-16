# Hotel prices

Playwright (Chromium) runner that scrapes Booking.com and Google Hotels for room prices near a place.
Defaults: 2 adults, 1 room, 1 night from 2026-10-28, near "Bay View Villas Hobart".

```
npm install
npm start -- --out prices.json
```

Flags: `--checkin`, `--nights`, `--adults`, `--near "<place>"`, `--headful`, `--out <file>`.
Prices are AUD; selectors depend on the sites' current markup.

## Tests

```
npm test          # unit tests (no network)
npm run test:e2e  # live run against the sites; needs network + Chromium
```

Exit codes: 0 = prices found, 1 = no prices, 2 = bad arguments. Each source's status (ok / blocked / failed)
is in the JSON `status` field. Booking.com sometimes bot-blocks (403); the runner reports that and continues.
QA process: see `.claude/skills/qa-loop/SKILL.md`.
