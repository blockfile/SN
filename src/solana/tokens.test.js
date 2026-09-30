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

// Fake RPC for sendIxs: records what was sent/confirmed; can fail at each step.
function fakeSendConnection({ sendErr, confirmErr, confirmValueErr } = {}) {
  const { Keypair } = require('@solana/web3.js');
  const blockhash = Keypair.generate().publicKey.toBase58();
  const calls = { sent: [], confirmed: [] };
  const connection = {
    getLatestBlockhash: async (commitment) => {
      calls.blockhashCommitment = commitment;
      return { blockhash, lastValidBlockHeight: 1234 };
    },
    sendRawTransaction: async (raw) => {
      calls.sent.push(raw);
      if (sendErr) throw sendErr;
      return 'rpc-echo';
    },
    confirmTransaction: async (strategy, commitment) => {
      calls.confirmed.push([strategy, commitment]);
      if (confirmErr) throw confirmErr;
      return { context: { slot: 1 }, value: { err: confirmValueErr || null } };
    },
  };
  return { connection, calls, blockhash };
}

function transferIx(wallet) {
  const { Keypair, SystemProgram } = require('@solana/web3.js');
  return SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
}

test('sendIxs signs before sending and resolves to the signature it confirmed', async () => {
  process.env.DRY_RUN = 'true';
  const { Keypair, Transaction } = require('@solana/web3.js');
  const bs58lib = require('bs58');
  const bs58 = bs58lib.default || bs58lib;
  const { sendIxs } = require('./tokens');
  const wallet = Keypair.generate();
  const { connection, calls, blockhash } = fakeSendConnection();

  const signature = await sendIxs(connection, wallet, [transferIx(wallet)], { label: 'test' });

  assert.strictEqual(calls.blockhashCommitment, 'confirmed');
  assert.strictEqual(calls.sent.length, 1);
  const tx = Transaction.from(calls.sent[0]);
  assert.strictEqual(signature, bs58.encode(tx.signature), 'the signature of the bytes actually sent');
  assert.strictEqual(tx.recentBlockhash, blockhash);
  assert.ok(tx.feePayer.equals(wallet.publicKey));
  assert.strictEqual(tx.instructions.length, 3, 'compute-budget limit + price, then the transfer');
  assert.deepStrictEqual(calls.confirmed, [[{ signature, blockhash, lastValidBlockHeight: 1234 }, 'confirmed']]);
});

test('sendIxs throws on an on-chain error and tags the error with the signature', async () => {
  process.env.DRY_RUN = 'true';
  const { Keypair } = require('@solana/web3.js');
  const { sendIxs } = require('./tokens');
  const wallet = Keypair.generate();
  const { connection, calls } = fakeSendConnection({ confirmValueErr: { InstructionError: [2, 'Custom'] } });
  const err = await sendIxs(connection, wallet, [transferIx(wallet)]).then(
    () => assert.fail('should throw'),
    (e) => e
  );
  assert.strictEqual(err.signature, calls.confirmed[0][0].signature);
  assert.strictEqual(err.lastValidBlockHeight, 1234);
});

test('sendIxs tags an ambiguous confirm or send failure with the signature and expiry', async () => {
  process.env.DRY_RUN = 'true';
  const { Keypair } = require('@solana/web3.js');
  const { sendIxs } = require('./tokens');
  const wallet = Keypair.generate();
  for (const opts of [{ confirmErr: new Error('block height exceeded') }, { sendErr: new Error('fetch failed') }]) {
    const { connection } = fakeSendConnection(opts);
    const err = await sendIxs(connection, wallet, [transferIx(wallet)]).then(
      () => assert.fail('should throw'),
      (e) => e
    );
    assert.match(err.message, /block height exceeded|fetch failed/);
    assert.strictEqual(typeof err.signature, 'string');
    assert.ok(err.signature.length >= 64, 'a base58 tx signature');
    assert.strictEqual(err.lastValidBlockHeight, 1234);
  }
});
