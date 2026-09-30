'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('config exposes the loop defaults', () => {
  delete require.cache[require.resolve('./config')];
  const config = require('./config');
  assert.strictEqual(config.rewardCapPct, 0);
  assert.strictEqual(config.minHold, 1);
  assert.strictEqual(config.pollSchedule, '* * * * *');
  assert.strictEqual(config.dryRunFeePerPoll, 0.05);
  assert.strictEqual(config.airdropBatchSize, 5);
  assert.ok(Array.isArray(config.clusters));
  assert.ok(Array.isArray(config.airdropExclude));
});

test('config exposes the Super Neko split, trigger and reward mints', () => {
  delete require.cache[require.resolve('./config')];
  const config = require('./config');
  assert.strictEqual(config.marketingPct, 50);
  assert.strictEqual(config.burnPct, 10);
  assert.strictEqual(config.nvdaxPct, 20);
  assert.strictEqual(config.siPct, 20);
  assert.strictEqual(config.marketingWallet, null);
  assert.strictEqual(config.minClaimUsd, 100);
  assert.strictEqual(config.dryRunSolPriceUsd, 150);
  assert.strictEqual(config.nvdaxMint, 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh');
  assert.strictEqual(config.siMint, 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP');
  assert.strictEqual(config.maxTransferFeeBps, 100);
  assert.strictEqual(config.minAirdropUsd, 0.5);
  assert.strictEqual(config.jupiterSlippageBps, 100, 'Jupiter buys: 1%, not the AMM SLIPPAGE_PCT');
});

test('config rejects a split over 100%', () => {
  delete require.cache[require.resolve('./config')];
  process.env.SI_PCT = '30';
  try {
    assert.throws(() => require('./config'), /sums to 110%/);
  } finally {
    delete process.env.SI_PCT;
    delete require.cache[require.resolve('./config')];
  }
});

test('config.clusters parses a JSON array-of-arrays from env', () => {
  delete require.cache[require.resolve('./config')];
  process.env.CLUSTERS = '[["AAA","BBB"],["CCC"]]';
  const config = require('./config');
  assert.deepStrictEqual(config.clusters, [['AAA', 'BBB'], ['CCC']]);
  delete process.env.CLUSTERS;
  delete require.cache[require.resolve('./config')];
});

test('legacy BABYCUPSY / LP / dev-fee config is gone; branding defaults are Super Neko', () => {
  delete require.cache[require.resolve('./config')];
  const config = require('./config');
  for (const k of ['cupsyMint', 'cupsyBuyPct', 'minClaimSol', 'solSplitBuy', 'solReserve', 'lockYears', 'lockCostSol', 'devFeePct', 'devWallet']) {
    assert.ok(!(k in config), `${k} should be gone`);
  }
  assert.strictEqual(config.mongoDb, 'superneko');
  assert.ok(config.corsOrigins.includes('https://superneko.meme'));
  assert.ok(config.corsOrigins.includes('https://www.superneko.meme'));
});
