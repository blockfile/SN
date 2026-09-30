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

// An ambiguous batch failure: the send threw, but the tx (SIG1) may have landed.
function ambiguousBatch() {
  const calls = [];
  const send = async (b) => {
    calls.push(b.map((a) => a.owner));
    if (calls.length === 1) throw Object.assign(new Error('timeout'), { signature: 'SIG1' });
    return `sig-${b.map((a) => a.owner).join('')}`;
  };
  return { calls, send, batch: [{ owner: 'A' }, { owner: 'B' }, { owner: 'C' }] };
}

test('sendWithFallback: a batch that threw but landed is recorded ok, never re-sent', async () => {
  const { sendWithFallback } = require('./airdrop');
  const { calls, send, batch } = ambiguousBatch();
  const res = await sendWithFallback(batch, send, { checkLanded: async () => 'landed' });
  assert.deepStrictEqual(res.map((r) => [r.a.owner, r.status, r.signature]), [
    ['A', 'ok', 'SIG1'],
    ['B', 'ok', 'SIG1'],
    ['C', 'ok', 'SIG1'],
  ]);
  assert.strictEqual(calls.length, 1, 'no retries — that would pay twice');
});

test('sendWithFallback: a batch that definitely did not land retries one by one', async () => {
  const { sendWithFallback } = require('./airdrop');
  const { calls, send, batch } = ambiguousBatch();
  const seen = [];
  const res = await sendWithFallback(batch, send, {
    checkLanded: async (err) => {
      seen.push(err.signature);
      return 'failed';
    },
  });
  assert.deepStrictEqual(seen, ['SIG1']);
  assert.deepStrictEqual(calls, [['A', 'B', 'C'], ['A'], ['B'], ['C']]);
  assert.deepStrictEqual(res.map((r) => [r.a.owner, r.status, r.signature]), [
    ['A', 'ok', 'sig-A'],
    ['B', 'ok', 'sig-B'],
    ['C', 'ok', 'sig-C'],
  ]);
});

test('sendWithFallback: when landing cannot be determined the batch is failed, not retried', async () => {
  const { sendWithFallback } = require('./airdrop');
  const { calls, send, batch } = ambiguousBatch();
  const res = await sendWithFallback(batch, send, {
    checkLanded: async () => {
      throw new Error('RPC down');
    },
  });
  assert.deepStrictEqual(res.map((r) => [r.a.owner, r.status]), [
    ['A', 'failed'],
    ['B', 'failed'],
    ['C', 'failed'],
  ]);
  assert.strictEqual(calls.length, 1, 'prefer a missed payout over a double payout');
});

// Fake RPC for checkLanded: a queue of signature statuses and block heights.
function fakeStatusConnection({ statuses, heights }) {
  const calls = [];
  return {
    calls,
    getSignatureStatuses: async (sigs, opts) => {
      calls.push([sigs, opts]);
      return { context: { slot: 1 }, value: [statuses.length > 1 ? statuses.shift() : statuses[0]] };
    },
    getBlockHeight: async (commitment) => {
      assert.strictEqual(commitment, 'confirmed');
      return heights.length > 1 ? heights.shift() : heights[0];
    },
  };
}

const ambiguous = { signature: 'SIG1', lastValidBlockHeight: 1234 };
const fast = { pollMs: 1, timeoutMs: 200 };

test('checkLanded: a confirmed or finalized status with no error has landed', async () => {
  const { checkLanded } = require('./airdrop');
  for (const confirmationStatus of ['confirmed', 'finalized']) {
    const conn = fakeStatusConnection({ statuses: [{ err: null, confirmationStatus }], heights: [1000] });
    assert.strictEqual(await checkLanded(conn, ambiguous, fast), 'landed');
    assert.deepStrictEqual(conn.calls[0], [['SIG1'], { searchTransactionHistory: true }]);
  }
});

test('checkLanded: a status with an on-chain error is failed', async () => {
  const { checkLanded } = require('./airdrop');
  const conn = fakeStatusConnection({ statuses: [{ err: { InstructionError: [2, 'Custom'] }, confirmationStatus: 'confirmed' }], heights: [1000] });
  assert.strictEqual(await checkLanded(conn, ambiguous, fast), 'failed');
});

test('checkLanded: no status once the blockhash has expired is failed', async () => {
  const { checkLanded } = require('./airdrop');
  const conn = fakeStatusConnection({ statuses: [null], heights: [1000, 1200, 1235] });
  assert.strictEqual(await checkLanded(conn, ambiguous, fast), 'failed');
  assert.strictEqual(conn.calls.length, 3, 'kept re-checking until past lastValidBlockHeight');
});

test('checkLanded: keeps polling while the blockhash is live and sees a late landing', async () => {
  const { checkLanded } = require('./airdrop');
  const conn = fakeStatusConnection({
    statuses: [null, { err: null, confirmationStatus: 'processed' }, { err: null, confirmationStatus: 'confirmed' }],
    heights: [1000],
  });
  assert.strictEqual(await checkLanded(conn, ambiguous, fast), 'landed');
});

test('checkLanded: throws when it cannot tell before the deadline', async () => {
  const { checkLanded } = require('./airdrop');
  const conn = fakeStatusConnection({ statuses: [null], heights: [1000] });
  await assert.rejects(checkLanded(conn, ambiguous, { pollMs: 1, timeoutMs: 20 }), /could not tell whether SIG1 landed/);
});
