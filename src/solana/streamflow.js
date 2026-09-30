'use strict';

const config = require('../config');
const { connection, wallet } = require('./connection');
const { readTokenBalance, getMintInfo } = require('./tokens');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Lock LP tokens on Streamflow with a far-future unlock (lock-to-self).
 * NOTE: a 999-year unlock is "locked, reclaimable at unlock" — NOT a burn.
 * In live mode it locks the LP balance the wallet actually holds.
 * @returns {Promise<{signature, lockId, unlockDate, simulated}>}
 */
async function lockLp(lpMint, lpAmountRawHint, lpDecimalsHint, years) {
  // Streamflow's program requires now < start < end and start <= cliff <= end.
  // So: start a little in the future, cliff (full unlock) far out, end just after cliff.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const startSeconds = nowSeconds + 120; // strictly future (clock-skew safe), and < cliff
  const unlockSeconds = nowSeconds + years * 365 * 24 * 60 * 60; // the 999-yr cliff
  const unlockDate = new Date(unlockSeconds * 1000).toISOString();

  if (config.dryRun) {
    return { signature: fakeSig('lock'), lockId: fakeSig('streamflow'), unlockDate, simulated: true };
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  const BN = require('bn.js');
  const { SolanaStreamClient } = require('@streamflow/stream');

  // Lock the LP we actually hold (Token-2022 mint). The deposit that minted this
  // LP just confirmed, and the public RPC pool can briefly lag, so retry the
  // balance read before giving up — a single stale 0 read otherwise throws a
  // false "no LP tokens to lock" even though the LP is sitting in the wallet.
  const { programId } = await getMintInfo(connection, lpMint);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let balance = 0n;
  for (let attempt = 0; attempt < 8; attempt++) {
    balance = await readTokenBalance(connection, lpMint, wallet.publicKey, programId);
    if (balance > 0n) break;
    await sleep(1500);
  }
  if (balance <= 0n) throw new Error('no LP tokens to lock');
  const total = new BN(balance.toString());

  const client = new SolanaStreamClient(config.rpcUrl);

  // Token-lock config: nothing releases before the far-future cliff; cliffAmount
  // = total-1 unlocks then; the trailing 1 unit trickles after. Satisfies
  // Streamflow's isTokenLock criteria so it shows under "Locks" in their app.
  const params = {
    recipient: wallet.publicKey.toBase58(),
    tokenId: typeof lpMint === 'string' ? lpMint : lpMint.toBase58(),
    amount: total,
    start: startSeconds,
    cliff: unlockSeconds,
    cliffAmount: total.subn(1),
    period: 1,
    amountPerPeriod: new BN(1),
    name: 'LP Lock',
    canTopup: false,
    cancelableBySender: false,
    cancelableByRecipient: false,
    transferableBySender: false,
    transferableByRecipient: false,
  };

  const res = await client.create(params, { sender: wallet, isNative: false });
  return {
    signature: res.txId,
    lockId: res.metadataId,
    unlockDate,
    simulated: false,
  };
}

module.exports = { lockLp };
