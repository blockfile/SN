'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_FEE_PER_POLL = '0.5';
delete require.cache[require.resolve('../config')];
const simvault = require('./simvault');
const { getClaimableSol, simulateFeeAccrual, claimCreatorFees } = require('./pumpfun');

test('DRY_RUN: getClaimableSol peeks, simulateFeeAccrual accrues, claim drains', async () => {
  simvault.reset(0);
  assert.strictEqual(await getClaimableSol(), 0);

  simulateFeeAccrual(); // +0.5
  assert.strictEqual(await getClaimableSol(), 0.5);
  assert.strictEqual(await getClaimableSol(), 0.5); // peeking does not accrue

  simulateFeeAccrual(); // +0.5 -> 1.0
  assert.strictEqual(await getClaimableSol(), 1);

  const claim = await claimCreatorFees();
  assert.strictEqual(claim.solClaimed, 1);
  assert.strictEqual(claim.simulated, true);
  assert.strictEqual(await getClaimableSol(), 0); // drained
});
