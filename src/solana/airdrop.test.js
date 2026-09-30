'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('airdropToken records one send per allocation (DRY_RUN)', async () => {
  process.env.DRY_RUN = 'true';
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_air';
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

test('sendWithFallback: whole batch succeeds in one send', async () => {
  const { sendWithFallback } = require('./airdrop');
  const calls = [];
  const res = await sendWithFallback([{ owner: 'A' }, { owner: 'B' }], async (b) => { calls.push(b.length); return 'sig'; });
  assert.deepStrictEqual(calls, [2]);
  assert.deepStrictEqual(res.map((r) => r.status), ['ok', 'ok']);
});

test("sendWithFallback: a failed batch retries one by one so one bad account can't sink it", async () => {
  const { sendWithFallback } = require('./airdrop');
  const send = async (b) => {
    if (b.some((a) => a.owner === 'BAD')) throw new Error('account frozen');
    return `sig-${b.map((a) => a.owner).join('')}`;
  };
  const res = await sendWithFallback([{ owner: 'A' }, { owner: 'BAD' }, { owner: 'C' }], send);
  assert.deepStrictEqual(res.map((r) => [r.a.owner, r.status, r.signature]), [
    ['A', 'ok', 'sig-A'],
    ['BAD', 'failed', null],
    ['C', 'ok', 'sig-C'],
  ]);
});
