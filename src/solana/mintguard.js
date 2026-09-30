'use strict';

const { PublicKey } = require('@solana/web3.js');
const { getMint, getPausableConfig, getTransferFeeConfig } = require('@solana/spl-token');
const config = require('../config');
const { connection } = require('./connection');
const { getMintInfo } = require('./tokens');

// Both reward tokens are Token-2022 mints whose issuers can change the rules
// under us: NVDAx is pausable (every transfer fails while paused) and $SI's fee
// authority can raise its 1% transfer fee. Checked before each buy so a tripped
// guard skips just that leg and the SOL stays in the wallet.

// Pure decision over the mint's live state.
function evaluateMintGuard({ paused, transferFeeBps }, { maxTransferFeeBps }) {
  if (paused) return { ok: false, reason: 'mint is paused' };
  if (transferFeeBps != null && transferFeeBps > maxTransferFeeBps) {
    return { ok: false, reason: `transfer fee ${transferFeeBps} bps exceeds max ${maxTransferFeeBps} bps` };
  }
  return { ok: true };
}

// A fee change is scheduled as newerTransferFee and takes effect at its epoch.
// Once that epoch arrives the newer fee is the fee (so a lowered fee unblocks the
// leg); until then guard on the higher of the two, so a pending raise counts.
function maxFeeBps(feeConfig, epoch) {
  if (!feeConfig) return null;
  const older = feeConfig.olderTransferFee;
  const newer = feeConfig.newerTransferFee;
  if (BigInt(epoch) >= BigInt(newer.epoch)) return newer.transferFeeBasisPoints;
  return Math.max(older.transferFeeBasisPoints, newer.transferFeeBasisPoints);
}

async function readMintState(mint) {
  const { programId } = await getMintInfo(connection, mint);
  const mintAcc = await getMint(connection, new PublicKey(mint), 'confirmed', programId);
  const { epoch } = await connection.getEpochInfo();
  const pausable = getPausableConfig(mintAcc);
  return {
    paused: pausable ? pausable.paused : false,
    transferFeeBps: maxFeeBps(getTransferFeeConfig(mintAcc), epoch),
  };
}

/** @returns {Promise<{ok: boolean, reason?: string}>} never throws */
async function checkRewardMint(mint) {
  if (config.dryRun) return { ok: true };
  try {
    return evaluateMintGuard(await readMintState(mint), config);
  } catch (err) {
    return { ok: false, reason: `mint check failed: ${err.message}` };
  }
}

module.exports = { evaluateMintGuard, maxFeeBps, checkRewardMint };
