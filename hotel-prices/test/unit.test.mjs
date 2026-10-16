import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parsePrice, normalise } from '../hotel-prices.mjs';

test('parseArgs handles values and boolean flags', () => {
  assert.deepEqual(parseArgs(['--checkin', '2026-10-28', '--headful', '--adults', '2']),
    { checkin: '2026-10-28', headful: true, adults: '2' });
});

test('parsePrice reads AUD strings', () => {
  assert.equal(parsePrice('A$1,234'), 1234);
  assert.equal(parsePrice('$82'), 82);
  assert.equal(parsePrice(undefined), null);
});

test('normalise dedupes per source+name keeping cheapest, sorts, nulls last', () => {
  const out = normalise([
    { source: 'g', name: 'Bay View Villas', price: '$419' },
    { source: 'g', name: 'Bay View Villas', price: '$327' },
    { source: 'g', name: 'Stone Flower' },
    { source: 'b', name: 'Narrara', price: '$82' },
    { source: 'b' },
  ]);
  assert.deepEqual(out.map((r) => [r.name, r.priceAud]),
    [['Narrara', 82], ['Bay View Villas', 327], ['Stone Flower', null]]);
});
