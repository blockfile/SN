'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('pollOnce fires only once the vault reaches MIN_CLAIM_SOL', async () => {
  process.env.DRY_RUN = 'true';
  process.env.SIMULATE_GRADUATED = 'true';
  process.env.TOKEN_MINT = 'Ai69001111111111111111111111111111111111111';
  process.env.CUPSY_MINT = '6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump';
  process.env.DRY_RUN_FEE_PER_POLL = '0'; // no simulated accrual — we control the vault
  process.env.MIN_CLAIM_SOL = '0.25';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'babycupsy_test_sched';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../solana/simvault');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    simvault.reset(0);

    // Empty vault → tick skips silently, no cycle row written.
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.strictEqual(p1.reason, 'nothing claimable');

    // Fees accrued but below the threshold → still no cycle, balance kept.
    simvault.reset(0.2);
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, false);
    assert.strictEqual(p2.reason, 'below threshold');
    assert.strictEqual(p2.claimable, 0.2, 'reports how much is waiting');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle below threshold');

    // Exactly at the threshold → fires.
    simvault.reset(0.25);
    const p3 = await scheduler.pollOnce('poll');
    assert.strictEqual(p3.ran, true);
    assert.strictEqual(p3.cycle.status, 'complete');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1, 'one cycle at the threshold');

    // POST /api/run is the operator override — it ignores the threshold entirely.
    // (Same mongod/db as above on purpose: db/index captures config at module
    // load, so a second MongoMemoryServer would be dialled with the stale URI.)
    simvault.reset(0.01);
    const manual = await scheduler.triggerNow();
    assert.strictEqual(manual.status, 'complete', 'manual run claims a sub-threshold balance');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 2, 'manual cycle recorded');
  } finally {
    await db.close();
    await mongod.stop();
    delete process.env.MIN_CLAIM_SOL;
    delete require.cache[require.resolve('../config')];
  }
});
