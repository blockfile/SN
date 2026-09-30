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

// Live path with fetch, the token reads and the RPC stubbed out.
async function withLiveJupiter({ confirmErr = null } = {}, fn) {
  const { Keypair, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
  const config = require('../config');
  const tokens = require('./tokens');
  const { connection, wallet } = require('./connection');
  const realTokens = { getMintInfo: tokens.getMintInfo, readTokenBalance: tokens.readTokenBalance, readTokenBalanceSettled: tokens.readTokenBalanceSettled };
  const realConn = { sendRawTransaction: connection.sendRawTransaction, confirmTransaction: connection.confirmTransaction };
  const realFetch = global.fetch;
  const realSlippagePct = config.slippagePct;

  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message();
  const swapTransaction = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).includes('/quote') ? { outAmount: '5000' } : { swapTransaction, lastValidBlockHeight: 99 };
    return { ok: true, status: 200, json: async () => body };
  };
  tokens.getMintInfo = async () => ({ decimals: 6, programId: tokens.TOKEN_2022_PROGRAM_ID });
  tokens.readTokenBalance = async () => 1000n;
  tokens.readTokenBalanceSettled = async () => 6000n;
  connection.sendRawTransaction = async () => 'jupsig';
  connection.confirmTransaction = async () => ({ context: { slot: 1 }, value: { err: confirmErr } });
  config.slippagePct = 5; // the AMM setting .env.example ships — must not leak into Jupiter
  config.dryRun = false;
  try {
    await fn(urls);
  } finally {
    config.dryRun = true;
    config.slippagePct = realSlippagePct;
    global.fetch = realFetch;
    Object.assign(tokens, realTokens);
    Object.assign(connection, realConn);
  }
}

test('buyViaJupiter (live) measures the balance delta of a confirmed swap', async () => {
  await withLiveJupiter({}, async () => {
    const r = await buyViaJupiter('DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP', 0.2);
    assert.strictEqual(r.signature, 'jupsig');
    assert.strictEqual(r.tokensBoughtRaw, '5000');
  });
});

test('buyViaJupiter (live) throws when the swap fails on-chain', async () => {
  await withLiveJupiter({ confirmErr: { InstructionError: [3, { Custom: 6001 }] } }, async () => {
    await assert.rejects(buyViaJupiter('DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP', 0.2), /jupsig failed/);
  });
});
