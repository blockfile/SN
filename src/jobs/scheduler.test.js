'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('pollOnce fires only once unclaimed fees are worth MIN_CLAIM_USD', async () => {
  process.env.DRY_RUN = 'true';
  process.env.SIMULATE_GRADUATED = 'true';
  process.env.TOKEN_MINT = 'SNmint1111111111111111111111111111111111111';
  process.env.DRY_RUN_FEE_PER_POLL = '0'; // no simulated accrual — we control the vault
  process.env.MIN_CLAIM_USD = '100';
  process.env.DRY_RUN_SOL_PRICE_USD = '150'; // $100 threshold = 0.6667 SOL
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_sched';
  const config = require('../config');
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../solana/simvault');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    simvault.reset(0);
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.strictEqual(p1.reason, 'nothing claimable');
    assert.strictEqual(scheduler.getState().lastClaimableUsd, 0);

    // $75 of fees → below the $100 threshold, no cycle row.
    simvault.reset(0.5);
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, false);
    assert.strictEqual(p2.reason, 'below threshold');
    assert.strictEqual(p2.claimable, 0.5);
    assert.strictEqual(p2.claimableUsd, 75);
    assert.strictEqual(scheduler.getState().lastClaimableUsd, 75);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0);

    // No price → never fire blind, even with plenty of fees.
    config.dryRunSolPriceUsd = 0;
    simvault.reset(5);
    const p3 = await scheduler.pollOnce('poll');
    assert.strictEqual(p3.ran, false);
    assert.strictEqual(p3.reason, 'no price');
    assert.strictEqual(scheduler.getState().lastClaimableUsd, null);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0);
    config.dryRunSolPriceUsd = 150;

    // $105 → fires.
    simvault.reset(0.7);
    const p4 = await scheduler.pollOnce('poll');
    assert.strictEqual(p4.ran, true);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1);
    assert.strictEqual(scheduler.getState().minClaimUsd, 100);

    // POST /api/run override ignores the threshold.
    simvault.reset(0.01);
    const manual = await scheduler.triggerNow();
    assert.ok(manual.id, 'manual cycle recorded');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 2);
  } finally {
    await db.close();
    await mongod.stop();
    delete process.env.MIN_CLAIM_USD;
    delete process.env.DRY_RUN_SOL_PRICE_USD;
    delete require.cache[require.resolve('../config')];
  }
});
