'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { filterEligible, countOwners } = require('./holders');

test('sums per owner, applies minimum and exclusions', () => {
  const accounts = [
    { owner: 'A', amountRaw: '60000' },
    { owner: 'A', amountRaw: '50000' }, // A totals 110000
    { owner: 'B', amountRaw: '90000' }, // below 100000
    { owner: 'POOL', amountRaw: '999999999' }, // excluded
  ];
  const out = filterEligible(accounts, 100000n, new Set(['POOL']));
  assert.deepStrictEqual(out, [{ owner: 'A', balanceRaw: '110000' }]);
});

test('countOwners counts distinct nonzero owners — no min, no exclusions (Solscan-style)', () => {
  const accounts = [
    { owner: 'A', amountRaw: '60000' },
    { owner: 'A', amountRaw: '50000' }, // same owner, counted once
    { owner: 'B', amountRaw: '90000' }, // below min-hold but still a holder
    { owner: 'POOL', amountRaw: '999999999' }, // exclusions don't apply here
    { owner: 'EMPTY', amountRaw: '0' }, // zero balance — not a holder
  ];
  assert.strictEqual(countOwners(accounts), 3);
});
