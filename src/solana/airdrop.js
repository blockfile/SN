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

// Send one batch; if it fails, retry each recipient alone so a single bad
// account (frozen by the issuer, etc.) can't fail everyone in its batch.
async function sendWithFallback(batch, sendFn) {
  try {
    const signature = await sendFn(batch);
    return batch.map((a) => ({ a, status: 'ok', signature }));
  } catch (err) {
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
  return { send, decimals };
}

// Airdrop a reward token to allocations [{owner, amountRaw}], batching transfers.
// Records every recipient send (repo.addAirdrop). Returns { sent, failed }.
// amount_ui is raw / 10^decimals — NVDAx's scaled-UI multiplier is not applied.
async function airdropToken({ rewardMint, allocations, cycleId }) {
  if (allocations.length === 0) return { sent: 0, failed: 0 };

  let decimals = 6;
  let send = async () => fakeSig('airdrop');
  if (!config.dryRun) ({ send, decimals } = await makeLiveSender(rewardMint));
  const uiOf = (raw) => Number(raw) / 10 ** decimals;

  let sent = 0;
  let failed = 0;
  for (const batch of chunk(allocations, config.airdropBatchSize)) {
    for (const r of await sendWithFallback(batch, send)) {
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

module.exports = { airdropToken, sendWithFallback };
