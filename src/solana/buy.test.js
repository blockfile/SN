'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.SIMULATE_GRADUATED = 'true';
const { buyToken } = require('./pumpfun');

test('buyToken returns a simulated AMM buy under DRY_RUN + graduated', async () => {
  const r = await buyToken('SomeMint1111111111111111111111111111111111', 0.5);
  assert.strictEqual(r.simulated, true);
  assert.ok(r.tokensBought > 0);
  assert.ok(typeof r.signature === 'string');
});

test('pumpswap keeps only the buy path; the legacy own-pool LP code is gone', () => {
  const pumpswap = require('./pumpswap');
  for (const k of ['OUR_POOL_INDEX', 'resolveOurPool', 'poolExists', 'createOurPool', 'depositToPool']) {
    assert.ok(!(k in pumpswap), `${k} should be gone`);
  }
  assert.strictEqual(typeof pumpswap.buyOnAmm, 'function');
  assert.strictEqual(typeof pumpswap.resolveCanonicalPool, 'function');
});
