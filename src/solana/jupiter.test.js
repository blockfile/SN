'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { buyViaJupiter } = require('./jupiter');

test('buyViaJupiter returns a simulated buy under DRY_RUN', async () => {
  const r = await buyViaJupiter('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', 0.2);
  assert.strictEqual(r.simulated, true);
  assert.ok(r.tokensBought > 0, 'bought some tokens');
  assert.ok(typeof r.signature === 'string', 'has a signature');
  assert.ok(BigInt(r.tokensBoughtRaw) > 0n, 'raw amount > 0');
});
