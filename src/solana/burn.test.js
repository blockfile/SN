'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { burnBought } = require('./burn');

test('burnBought burns exactly the amount given (DRY_RUN)', async () => {
  const r = await burnBought('SNmint1111111111111111111111111111111111111', '12345');
  assert.strictEqual(r.burnedRaw, '12345');
  assert.strictEqual(r.simulated, true);
  assert.match(r.signature, /^burn_/);
});

test('burnBought with nothing bought sends nothing', async () => {
  const r = await burnBought('SNmint1111111111111111111111111111111111111', '0');
  assert.strictEqual(r.signature, null);
  assert.strictEqual(r.burnedRaw, '0');
});
