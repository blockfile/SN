'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('getTokenSupplyRaw returns a simulated 1B supply in DRY_RUN', async () => {
  process.env.DRY_RUN = 'true';
  const { getTokenSupplyRaw } = require('./tokens');
  const supply = await getTokenSupplyRaw(null, 'AnyMint11111111111111111111111111111111111');
  assert.strictEqual(supply, 1_000_000_000n * 10n ** 6n);
});

const SI = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP';

test('readTokenBalance: a missing token account reads as 0', async () => {
  process.env.DRY_RUN = 'true';
  const { Keypair } = require('@solana/web3.js');
  const { readTokenBalance } = require('./tokens');
  const connection = { getAccountInfo: async () => null };
  assert.strictEqual(await readTokenBalance(connection, SI, Keypair.generate().publicKey), 0n);
});

test('readTokenBalance: an RPC error is rethrown, never read as 0', async () => {
  process.env.DRY_RUN = 'true';
  const { Keypair } = require('@solana/web3.js');
  const { readTokenBalance } = require('./tokens');
  const connection = {
    getAccountInfo: async () => {
      throw new Error('429 Too Many Requests');
    },
  };
  await assert.rejects(readTokenBalance(connection, SI, Keypair.generate().publicKey), /429 Too Many Requests/);
});
