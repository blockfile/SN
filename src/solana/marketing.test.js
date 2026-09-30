'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { computeMarketingSend, resolveMarketingDestination } = require('./marketing');

// 1 SOL claimed, 50% marketing share. Wallet had 2 SOL before the claim.
const base = { solClaimed: 1, marketingPct: 50, balanceBeforeSol: 2, txFeeSol: 0 };

test('marketing gets its full share when the other legs spent exactly their budget', () => {
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.5 }), 0.5);
});

test('gas and rent overhead come out of marketing', () => {
  // legs spent 0.5 + 0.01 overhead → 0.49 left
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.49 }), 0.49);
});

test("a skipped leg's SOL is never swept into marketing", () => {
  // a 0.2 leg was skipped → 0.7 left, but marketing is capped at its 0.5 share
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.7 }), 0.5);
});

test('marketing clamps at 0 when overhead exceeds its share', () => {
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 1.9 }), 0);
});

test("the transfer's own fee is reserved", () => {
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.49, txFeeSol: 0.00002 }), 0.48998);
});

test('blank or operating-wallet MARKETING_WALLET keeps the share in the dev wallet', () => {
  assert.strictEqual(resolveMarketingDestination(null, 'DEV'), null);
  assert.strictEqual(resolveMarketingDestination('', 'DEV'), null);
  assert.strictEqual(resolveMarketingDestination('DEV', 'DEV'), null);
  assert.strictEqual(resolveMarketingDestination('MKT', 'DEV'), 'MKT');
});
