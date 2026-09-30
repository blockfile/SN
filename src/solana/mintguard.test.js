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

test('maxFeeBps takes the higher of the older/newer fee (a pending raise counts)', () => {
  const cfg = { olderTransferFee: { transferFeeBasisPoints: 100 }, newerTransferFee: { transferFeeBasisPoints: 900 } };
  assert.strictEqual(maxFeeBps(cfg), 900);
  assert.strictEqual(maxFeeBps(null), null);
});

test('checkRewardMint is a no-op pass in DRY_RUN', async () => {
  assert.deepStrictEqual(await checkRewardMint('DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'), { ok: true });
});
