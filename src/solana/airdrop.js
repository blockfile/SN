'use strict';
const { PublicKey } = require('@solana/web3.js');
const { getMint, getTransferHook } = require('@solana/spl-token');
const config = require('../config');
const repo = require('../db/repository');
const { connection, wallet } = require('./connection');
const {
  getMintInfo,
  sendIxs,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction,
} = require('./tokens');

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Did the tx behind an ambiguous send failure land? `err` carries the
 * signature and blockhash expiry that sendIxs attaches.
 *   'landed' — confirmed/finalized without error
 *   'failed' — errored on-chain, or its blockhash expired with no status (it
 *              can never land now)
 * Throws when it can't tell within `timeoutMs`.
 */
async function checkLanded(connection, err, { pollMs = 2000, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Height before status: expired AND still no status means it never landed.
    const expired = (await connection.getBlockHeight('confirmed')) > err.lastValidBlockHeight;
    const { value } = await connection.getSignatureStatuses([err.signature], { searchTransactionHistory: true });
    const status = value && value[0];
    if (status) {
      const settled = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
      if (settled) return status.err == null ? 'landed' : 'failed';
    } else if (expired) {
      return 'failed';
    }
    if (Date.now() + pollMs > deadline) {
      throw new Error(`could not tell whether ${err.signature} landed within ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(pollMs);
  }
}

// Send one batch; if it fails, retry each recipient alone so a single bad
// account (frozen by the issuer, etc.) can't fail everyone in its batch.
// A send can throw after its tx landed (expiry, timeout), so with `checkLanded`
// the batch is only retried once its tx is known not to have landed; if that
// can't be determined it is marked failed — a missed payout beats a double one.
async function sendWithFallback(batch, sendFn, { checkLanded: landed } = {}) {
  try {
    const signature = await sendFn(batch);
    return batch.map((a) => ({ a, status: 'ok', signature }));
  } catch (err) {
    if (landed && err && err.signature) {
      let outcome;
      try {
        outcome = await landed(err);
      } catch (e) {
        outcome = `unknown (${e.message})`;
      }
      if (outcome === 'landed') {
        console.error(`[airdrop] batch of ${batch.length} threw (${err.message}) but landed: ${err.signature}`);
        return batch.map((a) => ({ a, status: 'ok', signature: err.signature }));
      }
      if (outcome !== 'failed') {
        console.error(`[airdrop] batch of ${batch.length} failed (${err.message}), ${err.signature} ${outcome} — NOT retrying`);
        return batch.map((a) => ({ a, status: 'failed', signature: null }));
      }
    }
    if (batch.length === 1) {
      console.error(`[airdrop] ${batch[0].owner} failed: ${err.message}`);
      return [{ a: batch[0], status: 'failed', signature: null }];
    }
    console.error(`[airdrop] batch of ${batch.length} failed (${err.message}) — retrying one by one`);
    const out = [];
    for (const a of batch) {
      try {
        out.push({ a, status: 'ok', signature: await sendFn([a]) });
      } catch (e) {
        console.error(`[airdrop] ${a.owner} failed: ${e.message}`);
        out.push({ a, status: 'failed', signature: null });
      }
    }
    return out;
  }
}

// Live sender for `rewardMint`. Token-2022 mints may carry a transfer hook (NVDAx
// has an unset hook slot its issuer can fill at any time); when one is set, the
// transfer needs the hook's extra accounts, which the hook-aware builder resolves.
async function makeLiveSender(rewardMint) {
  const mintPk = new PublicKey(rewardMint);
  const { decimals, programId } = await getMintInfo(connection, rewardMint);
  const hook = getTransferHook(await getMint(connection, mintPk, 'confirmed', programId));
  const hasHook = !!(hook && !hook.programId.equals(PublicKey.default));
  const source = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, programId);

  const send = async (batch) => {
    const ixs = [];
    for (const a of batch) {
      const owner = new PublicKey(a.owner);
      const dest = getAssociatedTokenAddressSync(mintPk, owner, true, programId);
      const amount = BigInt(a.amountRaw);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, dest, owner, mintPk, programId));
      ixs.push(
        hasHook
          ? await createTransferCheckedWithTransferHookInstruction(connection, source, mintPk, dest, wallet.publicKey, amount, decimals, [], 'confirmed', programId)
          : createTransferCheckedInstruction(source, mintPk, dest, wallet.publicKey, amount, decimals, [], programId)
      );
    }
    return sendIxs(connection, wallet, ixs, { label: `airdrop batch (${batch.length})` });
  };
  return { send, decimals, checkLanded: (err) => checkLanded(connection, err) };
}

// Airdrop a reward token to allocations [{owner, amountRaw}], batching transfers.
// Records every recipient send (repo.addAirdrop). Returns { sent, failed }.
// amount_ui is raw / 10^decimals — NVDAx's scaled-UI multiplier is not applied.
async function airdropToken({ rewardMint, allocations, cycleId }) {
  if (allocations.length === 0) return { sent: 0, failed: 0 };

  let decimals = 6;
  let send = async () => fakeSig('airdrop');
  let landed; // live only: resolves an ambiguous batch failure before any retry
  if (!config.dryRun) ({ send, decimals, checkLanded: landed } = await makeLiveSender(rewardMint));
  const uiOf = (raw) => Number(raw) / 10 ** decimals;

  let sent = 0;
  let failed = 0;
  for (const batch of chunk(allocations, config.airdropBatchSize)) {
    for (const r of await sendWithFallback(batch, send, { checkLanded: landed })) {
      await repo.addAirdrop({
        cycleId,
        rewardMint,
        recipient: r.a.owner,
        amountRaw: r.a.amountRaw,
        amountUi: uiOf(r.a.amountRaw),
        signature: r.signature,
        status: r.status,
      });
      if (r.status === 'ok') sent += 1;
      else failed += 1;
    }
  }
  return { sent, failed };
}

module.exports = { airdropToken, sendWithFallback, checkLanded };
