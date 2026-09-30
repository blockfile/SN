'use strict';

const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
const { transferSol } = require('./tokens');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Send the dev/tech cut (in SOL) to the configured wallet.
 * @returns {Promise<{signature, recipient, simulated}>}
 */
async function sendDevFee(solAmount) {
  if (config.dryRun) {
    return { signature: fakeSig('devfee'), recipient: config.devWallet || 'simDevWallet', simulated: true };
  }

  if (!config.devWallet) {
    throw new Error('DEV_WALLET is required when DEV_FEE_PCT > 0');
  }
  const to = new PublicKey(config.devWallet);
  const signature = await transferSol(connection, wallet, to, solAmount * LAMPORTS_PER_SOL);
  return { signature, recipient: config.devWallet, simulated: false };
}

module.exports = { sendDevFee };
