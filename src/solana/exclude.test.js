'use strict';
const test = require('node:test');
const assert = require('node:assert');

// A real, valid base58 mint so the PDAs derive.
const MINT = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP';

test('buildExcludeSet: wallet, marketing wallet, AIRDROP_EXCLUDE, and pump.fun curve/pool PDAs', async () => {
  process.env.DRY_RUN = 'true';
  process.env.MARKETING_WALLET = 'Mkt1111111111111111111111111111111111111111';
  process.env.AIRDROP_EXCLUDE = 'GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52, Other22222222222222222222222222222222222222';
  delete require.cache[require.resolve('../config')];
  const { walletPubkey } = require('./connection');
  const { buildExcludeSet } = require('./exclude');
  const { bondingCurvePda, canonicalPumpPoolPda } = require('@pump-fun/pump-sdk');
  const { PublicKey } = require('@solana/web3.js');

  try {
    const set = await buildExcludeSet(MINT);
    assert.ok(set.has(walletPubkey()), 'operating wallet excluded');
    assert.ok(set.has('Mkt1111111111111111111111111111111111111111'), 'marketing wallet excluded');
    assert.ok(set.has('GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52'));
    assert.ok(set.has('Other22222222222222222222222222222222222222'));
    assert.ok(set.has(bondingCurvePda(new PublicKey(MINT)).toBase58()), 'bonding-curve reserve excluded');
    assert.ok(set.has(canonicalPumpPoolPda(new PublicKey(MINT)).toBase58()), 'canonical pool excluded');
  } finally {
    delete process.env.MARKETING_WALLET;
    delete process.env.AIRDROP_EXCLUDE;
    delete require.cache[require.resolve('../config')];
  }
});

test('derivedExcludes returns [] for an invalid mint instead of throwing', () => {
  const { derivedExcludes } = require('./exclude');
  assert.deepStrictEqual(derivedExcludes('not-a-mint'), []);
});
