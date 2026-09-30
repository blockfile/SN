'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('config exposes BABYCUPSY threshold reward-loop defaults', () => {
  const config = require('./config');
  assert.strictEqual(config.cupsyBuyPct, 80);
  assert.strictEqual(config.rewardCapPct, 0);
  assert.strictEqual(config.minHold, 100000);
  assert.strictEqual(config.pollSchedule, '* * * * *');
  assert.strictEqual(config.minClaimSol, 0.25);
  assert.strictEqual(config.dryRunFeePerPoll, 0.05);
  assert.strictEqual(config.airdropBatchSize, 8);
  assert.ok(Array.isArray(config.clusters));
  assert.ok(Array.isArray(config.airdropExclude));
});

test('config.clusters parses a JSON array-of-arrays from env', () => {
  delete require.cache[require.resolve('./config')];
  process.env.CLUSTERS = '[["AAA","BBB"],["CCC"]]';
  const config = require('./config');
  assert.deepStrictEqual(config.clusters, [['AAA', 'BBB'], ['CCC']]);
  delete process.env.CLUSTERS;
  delete require.cache[require.resolve('./config')];
});
