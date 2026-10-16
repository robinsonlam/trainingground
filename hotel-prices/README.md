# Hotel prices

Playwright (Chromium) runner that scrapes Booking.com and Google Hotels for room prices near a place.
Defaults: 2 adults, 1 room, 1 night from 2026-10-28, near "Bay View Villas Hobart".

```
npm install
npm start -- --out prices.json
```

Flags: `--checkin`, `--nights`, `--adults`, `--near "<place>"`, `--headful`, `--out <file>`.
Prices are AUD; selectors depend on the sites' current markup.
