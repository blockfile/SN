'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('getStats sums marketing + burned; getBurns lists ok burns newest first', async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_burns';
  const db = require('./index');
  const repo = require('./repository');
  await db.connect();
  try {
    const c1 = await repo.createCycle({ dryRun: true });
    await repo.finishCycle(c1, { status: 'complete', sol_claimed: 1, marketing_sol: 0.49, sn_burned: 1000, legs: [{ leg: 'burn', status: 'ok' }] });
    const c2 = await repo.createCycle({ dryRun: true });
    await repo.finishCycle(c2, { status: 'partial', sol_claimed: 2, marketing_sol: 0.99, sn_burned: 2500 });

    await repo.addStep({ cycleId: c1, name: 'burn', status: 'ok', signature: 'b1', detail: { mint: 'SN', burnedRaw: '1000000000', tokensBurned: 1000 } });
    await repo.addStep({ cycleId: c2, name: 'burn', status: 'failed', signature: null, detail: { mint: 'SN' } });
    await repo.addStep({ cycleId: c2, name: 'burn', status: 'ok', signature: 'b2', detail: { mint: 'SN', burnedRaw: '2500000000', tokensBurned: 2500 } });

    const stats = await repo.getStats();
    assert.strictEqual(stats.cycles, 2);
    assert.strictEqual(stats.completed, 1);
    assert.strictEqual(stats.partial, 1);
    assert.strictEqual(stats.total_sol_claimed, 3);
    assert.strictEqual(+stats.total_marketing_sol.toFixed(6), 1.48);
    assert.strictEqual(stats.total_sn_burned, 3500);

    const burns = await repo.getBurns(10, 0);
    assert.strictEqual(burns.total, 2, 'failed burn excluded');
    assert.deepStrictEqual(burns.items.map((b) => b.signature), ['b2', 'b1']);
    assert.strictEqual(burns.items[0].tokensBurned, 2500);

    const withLegs = await repo.getCycleWithSteps(c1);
    assert.deepStrictEqual(withLegs.legs, [{ leg: 'burn', status: 'ok' }]);
  } finally {
    await db.close();
    await mongod.stop();
  }
});
