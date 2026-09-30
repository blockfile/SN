'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// One mongo server per file (config.mongoUri is captured at module load, so a
// second connect() in the same process would point at the first, stopped server).
test('addAirdrop + getAirdrops: round-trip newest-first, and reward_mint filter', async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_airdrops';
  const db = require('./index');
  const repo = require('./repository');
  await db.connect();
  try {
    await repo.addAirdrop({ cycleId: 1, rewardMint: 'OTHER', recipient: 'A', amountRaw: '10', amountUi: 1, signature: 's1', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardMint: 'SI', recipient: 'B', amountRaw: '20', amountUi: 2, signature: 's2', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardMint: 'SI', recipient: 'C', amountRaw: '30', amountUi: 3, signature: 's3', status: 'ok' });

    // Round-trip: all rows, newest first.
    const all = await repo.getAirdrops(10, 0);
    assert.strictEqual(all.total, 3);
    assert.strictEqual(all.items[0].recipient, 'C'); // newest first
    assert.strictEqual(all.items[2].recipient, 'A');

    // reward_mint filter — powers GET /airdrops?token=NVDAX|SI.
    const si = await repo.getAirdrops(10, 0, 'SI');
    assert.strictEqual(si.total, 2);
    assert.ok(si.items.every((i) => i.reward_mint === 'SI'));

    const none = await repo.getAirdrops(10, 0, '__none__'); // unknown mint -> empty
    assert.strictEqual(none.total, 0);
  } finally {
    await db.close();
    await mongod.stop();
  }
});
