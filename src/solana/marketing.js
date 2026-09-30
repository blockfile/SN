'use strict';

const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet, walletPubkey } = require('./connection');
const { transferSol } = require('./tokens');

// Fee headroom for the marketing transfer itself: 5,000 lamports base + the
// compute-unit priority fee sendIxs attaches (≈10,000 lamports at defaults).
const TX_FEE_SOL = 0.00002;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// null = keep the share in the operating (dev) wallet: MARKETING_WALLET unset,
// or set to the operating wallet itself.
function resolveMarketingDestination(marketingWallet, operatingWallet) {
  if (!marketingWallet || marketingWallet === operatingWallet) return null;
  return marketingWallet;
}

// Marketing is the reserve. It runs last and sends its share net of whatever the
// other legs really spent (gas, priority fees, new-account rent): the cycle's
// leftover SOL is balanceAfter − balanceBefore. Capped at the marketing share so
// SOL from a skipped or failed leg is never swept into it.
function computeMarketingSend({ solClaimed, marketingPct, balanceBeforeSol, balanceAfterSol, txFeeSol = TX_FEE_SOL }) {
  const share = (solClaimed * marketingPct) / 100;
  const available = balanceAfterSol - balanceBeforeSol - txFeeSol;
  return Math.max(0, +Math.min(share, available).toFixed(9));
}

/** Operating wallet balance in SOL; null in DRY_RUN (nothing real to measure). */
async function getWalletSolBalance() {
  if (config.dryRun) return null;
  return (await connection.getBalance(wallet.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
}

/** @returns {Promise<{status: 'ok'|'kept'|'skipped', signature: string|null, recipient: string, solSent: number}>} */
async function sendMarketing(solAmount) {
  const to = resolveMarketingDestination(config.marketingWallet, walletPubkey());
  if (!to) return { status: 'kept', signature: null, recipient: walletPubkey(), solSent: 0 };
  if (!(solAmount > 0)) return { status: 'skipped', signature: null, recipient: to, solSent: 0 };
  if (config.dryRun) return { status: 'ok', signature: fakeSig('marketing'), recipient: to, solSent: solAmount };
  const signature = await transferSol(connection, wallet, new PublicKey(to), Math.floor(solAmount * LAMPORTS_PER_SOL));
  return { status: 'ok', signature, recipient: to, solSent: solAmount };
}

module.exports = { resolveMarketingDestination, computeMarketingSend, getWalletSolBalance, sendMarketing, TX_FEE_SOL };
