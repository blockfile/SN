'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('airdropToken records one send per allocation (DRY_RUN)', async () => {
  process.env.DRY_RUN = 'true';
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'our_test_air';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const { airdropToken } = require('./airdrop');
  await db.connect();
  try {
    const allocations = [
      { owner: 'A', amountRaw: '100' },
      { owner: 'B', amountRaw: '200' },
      { owner: 'C', amountRaw: '300' },
    ];
    const res = await airdropToken({ rewardMint: 'Mint11111111111111111111111111111111111111', allocations, cycleId: 7 });
    assert.strictEqual(res.sent, 3);
    assert.strictEqual(res.failed, 0);
    const { total } = await repo.getAirdrops(50, 0);
    assert.strictEqual(total, 3);
  } finally {
    await db.close();
    await mongod.stop();
  }
});
