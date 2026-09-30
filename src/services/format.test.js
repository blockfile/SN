'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  toPublicSummary,
  buildUnclaimedPayload,
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
} = require('./format');

test('buildUnclaimedPayload reports the live balance only (no threshold fields)', () => {
  const out = buildUnclaimedPayload(0.5, 150);
  assert.deepStrictEqual(Object.keys(out).sort(), ['solPriceUsd', 'unclaimedSol', 'unclaimedUsd']);
  assert.strictEqual(out.unclaimedSol, 0.5);
  assert.strictEqual(out.unclaimedUsd, 75);
  assert.strictEqual(out.solPriceUsd, 150);
  // null balance is preserved (RPC unavailable)
  assert.strictEqual(buildUnclaimedPayload(null, 150).unclaimedSol, null);
});

test('toActivityRow maps claim/buy/airdrop steps', () => {
  const buy = toActivityRow({ name: 'buy', detail: { solSpent: 0.4, leg: 'A' }, signature: 'sig', created_at: 'x' }, 100);
  assert.strictEqual(buy.type, 'Buy');
  assert.strictEqual(buy.amountSol, 0.4);

  const airdropFail = toActivityRow({ name: 'airdrop', status: 'failed', detail: {} }, 0);
  assert.strictEqual(airdropFail.status, 'Failed');
});

test('toPublicActivityRow maps buy steps', () => {
  const row = toPublicActivityRow({ name: 'buy', detail: { solSpent: 0.2, leg: 'A' }, signature: 's', created_at: '2026-06-29T00:00:00Z' }, 100);
  assert.strictEqual(row.type, 'buy');
  assert.strictEqual(row.amountSol, 0.2);
  assert.strictEqual(typeof row.usdtValue, 'number'); // never null
});

test('toPublicStats drops threshold/dev/liquidity fields', () => {
  const out = toPublicStats({
    stats: { total_sol_claimed: 12 },
    unclaimedSol: 0.5,
    operatingWallet: 'WALLET',
    market: { marketCap: 100 },
  });
  assert.strictEqual(out.totalCreatorFeesClaimed, 12);
  assert.strictEqual(out.operatingWallet, 'WALLET');
  for (const k of ['autoClaimThresholdSol', 'totalForDevTech', 'totalUsedForLiquidity', 'totalLiquidityAdded', 'devWalletAddress']) {
    assert.ok(!(k in out), `${k} should be gone`);
  }
});

test('toPublicSummary reports NVDAx + SI distributed, $SN burned and marketing', () => {
  const out = toPublicSummary({
    stats: { total_sol_claimed: 10, total_sn_burned: 5000, total_marketing_sol: 4.9 },
    byMint: { NVDAX: { sends: 5, totalUi: 2, holders: 5 }, SI: { sends: 4, totalUi: 900, holders: 4 } },
    eligibleHolders: 42,
    totalHolders: 1200,
    price: 150,
    nvdaxMint: 'NVDAX',
    siMint: 'SI',
    marketCapUsd: 55_620_000,
  });
  assert.strictEqual(out.creatorFeesClaimedSol, 10);
  assert.strictEqual(out.creatorFeesClaimedUsd, 1500);
  assert.strictEqual(out.nvdaxDistributed, 2);
  assert.strictEqual(out.siDistributed, 900);
  assert.strictEqual(out.snBurned, 5000);
  assert.strictEqual(out.marketingSol, 4.9);
  assert.strictEqual(out.holders, 42);
  assert.strictEqual(out.totalHolders, 1200);
  assert.strictEqual(out.distributions, 9);
  assert.strictEqual(out.marketCapUsd, 55_620_000);
  assert.ok(!('cupsyDistributed' in out), 'cupsyDistributed should be gone');
});

test('toPublicSummary defaults: zeros for no activity, null marketCap/totalHolders', () => {
  const out = toPublicSummary({ stats: {}, byMint: {}, price: 0, nvdaxMint: 'NVDAX', siMint: 'SI' });
  assert.strictEqual(out.marketCapUsd, null);
  assert.strictEqual(out.totalHolders, null);
  assert.strictEqual(out.nvdaxDistributed, 0);
  assert.strictEqual(out.snBurned, 0);
  assert.strictEqual(out.marketingSol, 0);
});

test('activity rows label burn and marketing steps', () => {
  const burn = toPublicActivityRow({ name: 'burn', status: 'ok', detail: { leg: 'burn' }, signature: 's', created_at: '2026-09-30T00:00:00Z' }, 150);
  assert.strictEqual(burn.type, 'burn');
  const mkt = toPublicActivityRow({ name: 'marketing', status: 'kept', detail: { solMarketing: 0.5 }, signature: null, created_at: '2026-09-30T00:00:00Z' }, 150);
  assert.strictEqual(mkt.type, 'marketing');
  assert.strictEqual(mkt.amountSol, 0.5);
  assert.strictEqual(mkt.usdtValue, 75);
  assert.strictEqual(mkt.status, 'kept');
  assert.strictEqual(toActivityRow({ name: 'burn', detail: {} }, 0).type, 'Buyback Burn');
  assert.strictEqual(toActivityRow({ name: 'marketing', status: 'kept', detail: { solMarketing: 0.5 } }, 0).type, 'Marketing');
});
