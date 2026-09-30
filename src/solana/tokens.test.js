'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('getTokenSupplyRaw returns a simulated 1B supply in DRY_RUN', async () => {
  process.env.DRY_RUN = 'true';
  const { getTokenSupplyRaw } = require('./tokens');
  const supply = await getTokenSupplyRaw(null, 'AnyMint11111111111111111111111111111111111');
  assert.strictEqual(supply, 1_000_000_000n * 10n ** 6n);
});
