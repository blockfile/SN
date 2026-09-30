'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('runCycle (DRY_RUN): claim, buy $CUPSY + airdrop, no burn', async () => {
  process.env.DRY_RUN = 'true';
  process.env.SIMULATE_GRADUATED = 'true';
  process.env.TOKEN_MINT = 'Ai69001111111111111111111111111111111111111'; // BABYCUPSY
  process.env.CUPSY_MINT = '6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump'; // $CUPSY
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'babycupsy_test_cycle';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../solana/simvault');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    simvault.reset(1.5); // creator-fee vault has fees to claim
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.ok(typeof cycle.eligible_holders === 'number', 'records the eligible-holder count');
    assert.strictEqual(cycle.total_holders, 3, 'records the raw distinct-owner count (sim: 2 eligible + wallet)');
    const names = cycle.steps.map((s) => s.name);
    assert.ok(names.includes('claim'));
    assert.strictEqual(names.filter((n) => n === 'buy').length, 1, 'one buy ($CUPSY airdrop)');
    assert.strictEqual(names.filter((n) => n === 'airdrop').length, 1, 'one airdrop ($CUPSY)');
    assert.strictEqual(names.filter((n) => n === 'burn').length, 0, 'no burns');

    const { items } = await repo.getAirdrops(500, 0);
    const mints = new Set(items.map((a) => a.reward_mint));
    assert.ok(mints.has(process.env.CUPSY_MINT), 'airdropped $CUPSY');
    assert.ok(!mints.has(process.env.TOKEN_MINT), 'BABYCUPSY was NOT airdropped');
    assert.ok(typeof cycle.eligible_holders === 'number');
    assert.strictEqual(cycle.status, 'complete');
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
  }
});
