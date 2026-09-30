'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { evaluateMintGuard, maxFeeBps, checkRewardMint } = require('./mintguard');

const limits = { maxTransferFeeBps: 100 };

test('evaluateMintGuard passes a normal mint and the current 1% SI fee', () => {
  assert.deepStrictEqual(evaluateMintGuard({ paused: false, transferFeeBps: null }, limits), { ok: true });
  assert.deepStrictEqual(evaluateMintGuard({ paused: false, transferFeeBps: 100 }, limits), { ok: true });
});

test('evaluateMintGuard blocks a paused mint', () => {
  const r = evaluateMintGuard({ paused: true, transferFeeBps: null }, limits);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /paused/);
});

test('evaluateMintGuard blocks a transfer fee above the max', () => {
  const r = evaluateMintGuard({ paused: false, transferFeeBps: 500 }, limits);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /500 bps/);
});

// spl-token decodes TransferFee.epoch as a bigint.
const feeCfg = (olderBps, newerBps, newerEpoch) => ({
  olderTransferFee: { epoch: 0n, transferFeeBasisPoints: olderBps },
  newerTransferFee: { epoch: newerEpoch, transferFeeBasisPoints: newerBps },
});

test('maxFeeBps takes the higher of the older/newer fee while a change is pending', () => {
  assert.strictEqual(maxFeeBps(feeCfg(100, 900, 600n), 599), 900, 'a pending raise counts');
  assert.strictEqual(maxFeeBps(feeCfg(500, 100, 600n), 599), 500, 'the older fee is still in effect');
  assert.strictEqual(maxFeeBps(null, 599), null);
});

test('maxFeeBps uses the newer fee once its epoch arrives (a lowered fee unblocks the leg)', () => {
  assert.strictEqual(maxFeeBps(feeCfg(500, 100, 600n), 600), 100);
  assert.strictEqual(maxFeeBps(feeCfg(500, 100, 600n), 750), 100);
  assert.strictEqual(maxFeeBps(feeCfg(100, 900, 600n), 600), 900, 'a raise in effect still counts');
});

test('checkRewardMint is a no-op pass in DRY_RUN', async () => {
  assert.deepStrictEqual(await checkRewardMint('DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'), { ok: true });
});
