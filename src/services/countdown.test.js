'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextRun, intervalMinutes, thresholdProgress } = require('./countdown');

// Local-time helper: epoch ms for 2026-06-29 hh:mm:ss.
const at = (h, m, s) => new Date(2026, 5, 29, h, m, s).getTime();

test('nextRun targets the next 5-minute boundary', () => {
  const r = nextRun('*/5 * * * *', at(12, 1, 30));
  assert.strictEqual(r.nextAirdropAt, at(12, 5, 0));
  assert.strictEqual(r.intervalSec, 300);
});

test('nextRun on a boundary rolls to the NEXT slot', () => {
  const r = nextRun('*/5 * * * *', at(12, 5, 0));
  assert.strictEqual(r.nextAirdropAt, at(12, 10, 0));
});

test('intervalMinutes parses */N, reads bare * as every minute, else falls back to 5', () => {
  assert.strictEqual(intervalMinutes('*/5 * * * *'), 5);
  assert.strictEqual(intervalMinutes('*/3 * * * *'), 3);
  assert.strictEqual(intervalMinutes('* * * * *'), 1, 'the every-minute default');
  assert.strictEqual(intervalMinutes('0 * * * *'), 5, 'unsupported schedule falls back');
});

test('nextRun on the every-minute schedule targets the next minute boundary', () => {
  const r = nextRun('* * * * *', at(12, 1, 30));
  assert.strictEqual(r.nextAirdropAt, at(12, 2, 0));
  assert.strictEqual(r.intervalSec, 60);
});

test('thresholdProgress reports percent toward the claim threshold, clamped', () => {
  assert.strictEqual(thresholdProgress(0, 0.25), 0);
  assert.strictEqual(thresholdProgress(0.125, 0.25), 50);
  assert.strictEqual(thresholdProgress(0.183, 0.25), 73.2);
  assert.strictEqual(thresholdProgress(0.9, 0.25), 100, 'clamped at 100 once over');
});

test('thresholdProgress is null before the first poll and 100 with no threshold', () => {
  assert.strictEqual(thresholdProgress(null, 0.25), null);
  assert.strictEqual(thresholdProgress(0.1, 0), 100, 'threshold disabled → always ready');
});
