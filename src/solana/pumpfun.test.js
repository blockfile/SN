'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.DRY_RUN_FEE_PER_POLL = '0.5';
delete require.cache[require.resolve('../config')];
const BN = require('bn.js');
const { Keypair } = require('@solana/web3.js');
const simvault = require('./simvault');
const { getClaimableSol, simulateFeeAccrual, claimCreatorFees, creatorVaultLamports } = require('./pumpfun');

function fakeSdk() {
  const calls = { amm: 0 };
  const sdk = {
    getCreatorVaultBalance: async () => new BN(5),
    pumpAmmSdk: { getCoinCreatorVaultBalance: async () => { calls.amm += 1; return new BN(7); } },
  };
  return { sdk, calls };
}

test('creatorVaultLamports skips the PumpSwap vault until its account exists (no SDK warning spam)', async () => {
  const { sdk, calls } = fakeSdk();
  const conn = { getAccountInfo: async () => null }; // pre-graduation: no AMM vault account
  const lamports = await creatorVaultLamports(sdk, conn, Keypair.generate().publicKey);
  assert.strictEqual(lamports.toNumber(), 5, 'bonding-curve fees only');
  assert.strictEqual(calls.amm, 0, 'never asks the SDK for a vault that does not exist');
});

test('creatorVaultLamports adds the PumpSwap vault once it exists', async () => {
  const { sdk, calls } = fakeSdk();
  const conn = { getAccountInfo: async () => ({ lamports: 1 }) };
  const lamports = await creatorVaultLamports(sdk, conn, Keypair.generate().publicKey);
  assert.strictEqual(lamports.toNumber(), 12);
  assert.strictEqual(calls.amm, 1);
});

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
