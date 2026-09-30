'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeWeightedAllocations, minRawForUsd } = require('./distribution');

// helper: turn result into { owner: amount } and the integer sum
function toMap(out) {
  const m = {};
  let sum = 0n;
  for (const { owner, amountRaw } of out) {
    m[owner] = (m[owner] || 0n) + BigInt(amountRaw);
    sum += BigInt(amountRaw);
  }
  return { m, sum };
}

test('pro-rata by balance when no cap (Leg B shape)', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '100' }, { owner: 'B', balanceRaw: '300' }],
    '400',
    { capPct: null }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 400n);
  assert.strictEqual(m.A, 100n); // 400 * 100/400
  assert.strictEqual(m.B, 300n); // 400 * 300/400
});

test('caps a whale at 2% of supply (Leg A shape)', () => {
  // supply 1,000,000 -> 2% cap = 20,000. Whale holds 500,000 (capped to 20,000),
  // small holder 20,000 (uncapped). Equal weights -> equal split of 1,000.
  const out = computeWeightedAllocations(
    [{ owner: 'WHALE', balanceRaw: '500000' }, { owner: 'SMALL', balanceRaw: '20000' }],
    '1000',
    { capPct: 2, supplyRaw: '1000000' }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1000n);
  assert.strictEqual(m.WHALE, 500n);
  assert.strictEqual(m.SMALL, 500n);
});

test('clustered wallets are capped as one entity, then split by internal balance', () => {
  // Cluster [X,Y] combined 30,000 capped at 20,000 (2% of 1,000,000). Z holds 20,000.
  // Two entities, equal capped weight -> 500 each. Cluster's 500 splits X:Y = 10000:20000 = 167:333.
  const out = computeWeightedAllocations(
    [
      { owner: 'X', balanceRaw: '10000' },
      { owner: 'Y', balanceRaw: '20000' },
      { owner: 'Z', balanceRaw: '20000' },
    ],
    '1000',
    { capPct: 2, supplyRaw: '1000000', clusters: [['X', 'Y']] }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1000n);
  assert.strictEqual(m.Z, 500n);
  assert.strictEqual(m.X + m.Y, 500n);
  assert.strictEqual(m.X, 167n); // floor(500 * 10000/30000) = 166 + 1 largest-remainder
  assert.strictEqual(m.Y, 333n); // floor(500 * 20000/30000) = 333
});

test('largest-remainder makes the sum exact (no dust, no overflow)', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '1' }, { owner: 'C', balanceRaw: '1' }],
    '7', // 7/3 = 2 each + 1 leftover -> someone gets 3
    { capPct: null }
  );
  const { sum } = toMap(out);
  assert.strictEqual(sum, 7n);
  assert.strictEqual(out.length, 3);
});

test('returns [] for empty / zero / all-zero-balance inputs', () => {
  assert.deepStrictEqual(computeWeightedAllocations([], '100', { capPct: null }), []);
  assert.deepStrictEqual(
    computeWeightedAllocations([{ owner: 'A', balanceRaw: '5' }], '0', { capPct: null }),
    []
  );
  assert.deepStrictEqual(
    computeWeightedAllocations([{ owner: 'A', balanceRaw: '0' }], '100', { capPct: null }),
    []
  );
});

test('dust filter drops sub-threshold recipients and redistributes their share', () => {
  // A's pro-rata share is 1 unit (< 10) → dropped; B receives everything.
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '1000' }],
    '1001',
    { minAmountRaw: '10' }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1001n);
  assert.strictEqual(m.A, undefined);
  assert.strictEqual(m.B, 1001n);
});

test('dust filter re-checks after redistribution until stable', () => {
  // total 100: A=1%, B=4%, C=95% → A (1) and B (4) are below 5 → C gets all 100.
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '4' }, { owner: 'C', balanceRaw: '95' }],
    '100',
    { minAmountRaw: 5n }
  );
  assert.deepStrictEqual(out, [{ owner: 'C', amountRaw: '100' }]);
});

test('dust filter keeps re-checking across multiple passes', () => {
  // total 45, floor 7. Pass 1: A=3, C=4, D=2 are dust (B's share rounds to 0).
  // Pass 2 over {B, E, F}: B=1 is now dust. Pass 3 over {E, F}: 22.5 each → 23/22
  // (largest-remainder tie broken by key).
  const out = computeWeightedAllocations(
    [
      { owner: 'A', balanceRaw: '9' },
      { owner: 'B', balanceRaw: '1' },
      { owner: 'C', balanceRaw: '13' },
      { owner: 'D', balanceRaw: '8' },
      { owner: 'E', balanceRaw: '58' },
      { owner: 'F', balanceRaw: '58' },
    ],
    '45',
    { minAmountRaw: '7' }
  );
  assert.deepStrictEqual(out, [{ owner: 'E', amountRaw: '23' }, { owner: 'F', amountRaw: '22' }]);
});

test('dust filter returns [] when every share is dust', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '1' }],
    '10',
    { minAmountRaw: '100' }
  );
  assert.deepStrictEqual(out, []);
});

test('minRawForUsd converts a USD floor into raw units at this buy price', () => {
  // 0.3 SOL bought 30,000,000 raw at $150/SOL → $45 per 30,000,000 raw → $0.50 = 333,334 raw (ceil).
  assert.strictEqual(minRawForUsd({ minUsd: 0.5, solSpent: 0.3, solPriceUsd: 150, tokensBoughtRaw: 30_000_000n }), 333334n);
  assert.strictEqual(minRawForUsd({ minUsd: 0.5, solSpent: 0.3, solPriceUsd: null, tokensBoughtRaw: 30_000_000n }), null);
  assert.strictEqual(minRawForUsd({ minUsd: 0, solSpent: 0.3, solPriceUsd: 150, tokensBoughtRaw: 30_000_000n }), null);
  assert.strictEqual(minRawForUsd({ minUsd: 0.5, solSpent: 0.3, solPriceUsd: 150, tokensBoughtRaw: 0n }), null);
});

test('when every share is dust, the largest holders that can clear the floor are still paid', () => {
  // The live first cycle: a small pot across ~120 similar holders put every share under the
  // floor and paid no one. 120 equal holders, pot 100, floor 10 → the top 10 get 10 each.
  const holders = Array.from({ length: 120 }, (_, i) => ({ owner: `H${String(i).padStart(3, '0')}`, balanceRaw: '1' }));
  const out = computeWeightedAllocations(holders, '100', { minAmountRaw: '10' });
  assert.strictEqual(out.length, 10);
  assert.ok(out.every((a) => a.amountRaw === '10'));
  assert.strictEqual(toMap(out).sum, 100n);
});

test('all-dust fallback keeps the biggest holders by balance, pro-rata among them', () => {
  // H1=40, H2=30, H3=20 + 97 holders of 1 (sum 187); pot 100, floor 30. Every first-pass
  // share is < 30 (H1 ≈ 21). Top-k: k=2 clears (100·30 ≥ 30·70), k=3 doesn't (100·20 < 30·90).
  // H1:H2 = 40:30 of 100 → 57.14 / 42.86 → largest remainder → 57 / 43.
  const holders = [
    { owner: 'H1', balanceRaw: '40' },
    { owner: 'H2', balanceRaw: '30' },
    { owner: 'H3', balanceRaw: '20' },
    ...Array.from({ length: 97 }, (_, i) => ({ owner: `s${i}`, balanceRaw: '1' })),
  ];
  const out = computeWeightedAllocations(holders, '100', { minAmountRaw: '30' });
  assert.deepStrictEqual(out, [{ owner: 'H1', amountRaw: '57' }, { owner: 'H2', amountRaw: '43' }]);
});
