'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('buildExcludeSet includes wallet, devWallet and manual AIRDROP_EXCLUDE', async () => {
  process.env.DRY_RUN = 'true';
  process.env.DEV_WALLET = 'Dev1111111111111111111111111111111111111111';
  process.env.AIRDROP_EXCLUDE = 'GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52, Other22222222222222222222222222222222222222';
  delete require.cache[require.resolve('../config')];
  const { walletPubkey } = require('./connection');
  const { buildExcludeSet } = require('./exclude');

  const set = await buildExcludeSet('Holder111111111111111111111111111111111111');
  assert.ok(set.has('GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52'), 'manual vault excluded');
  assert.ok(set.has('Other22222222222222222222222222222222222222'));
  assert.ok(set.has('Dev1111111111111111111111111111111111111111'));
  assert.ok(set.has(walletPubkey()), 'operating wallet excluded');

  delete process.env.DEV_WALLET;
  delete process.env.AIRDROP_EXCLUDE;
  delete require.cache[require.resolve('../config')];
});
