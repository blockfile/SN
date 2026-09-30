'use strict';
const { PublicKey } = require('@solana/web3.js');
const config = require('../config');
const repo = require('../db/repository');
const { connection, wallet } = require('./connection');
const {
  getMintInfo,
  sendIxs,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} = require('./tokens');

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Airdrop a reward token to allocations [{owner, amountRaw}], batching transfers.
// Records every recipient send (repo.addAirdrop). Returns { sent, failed }.
async function airdropToken({ rewardMint, allocations, cycleId }) {
  if (allocations.length === 0) return { sent: 0, failed: 0 };

  let decimals = 6;
  let programId;
  if (!config.dryRun) {
    const info = await getMintInfo(connection, rewardMint);
    decimals = info.decimals;
    programId = info.programId;
  }
  const uiOf = (raw) => Number(raw) / 10 ** decimals;
  const batches = chunk(allocations, config.airdropBatchSize);

  let sent = 0;
  let failed = 0;
  for (const batch of batches) {
    let signature;
    let status = 'ok';
    try {
      if (config.dryRun) {
        signature = fakeSig('airdrop');
      } else {
        const mintPk = new PublicKey(rewardMint);
        const source = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, programId);
        const ixs = [];
        for (const a of batch) {
          const owner = new PublicKey(a.owner);
          const dest = getAssociatedTokenAddressSync(mintPk, owner, true, programId);
          ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, dest, owner, mintPk, programId));
          ixs.push(createTransferCheckedInstruction(source, mintPk, dest, wallet.publicKey, BigInt(a.amountRaw), decimals, [], programId));
        }
        signature = await sendIxs(connection, wallet, ixs, { label: `airdrop batch (${batch.length})` });
      }
    } catch (err) {
      status = 'failed';
      signature = null;
      console.error(`[airdrop] batch failed: ${err.message}`);
    }
    for (const a of batch) {
      await repo.addAirdrop({
        cycleId,
        rewardMint,
        recipient: a.owner,
        amountRaw: a.amountRaw,
        amountUi: uiOf(a.amountRaw),
        signature,
        status,
      });
      if (status === 'ok') sent += 1;
      else failed += 1;
    }
  }
  return { sent, failed };
}

module.exports = { airdropToken };
