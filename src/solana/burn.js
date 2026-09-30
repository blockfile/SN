'use strict';

const { PublicKey } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
const { getMintInfo, sendIxs, getAssociatedTokenAddressSync, createBurnCheckedInstruction } = require('./tokens');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Buyback & burn: destroy exactly `amountRaw` of `mint` from the operating
 * wallet's token account (SPL burnChecked — lowers on-chain supply). The caller
 * passes only what THIS cycle bought, never the wallet's pre-existing balance.
 * @returns {Promise<{signature: string|null, burnedRaw: string, simulated: boolean}>}
 */
async function burnBought(mint, amountRaw) {
  const amount = BigInt(amountRaw.toString());
  if (amount <= 0n) return { signature: null, burnedRaw: '0', simulated: config.dryRun };
  if (config.dryRun) return { signature: fakeSig('burn'), burnedRaw: amount.toString(), simulated: true };

  const mintPk = new PublicKey(mint);
  const { decimals, programId } = await getMintInfo(connection, mint);
  const account = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, programId);
  const ix = createBurnCheckedInstruction(account, mintPk, wallet.publicKey, amount, decimals, [], programId);
  const signature = await sendIxs(connection, wallet, [ix], { label: `burn ${amount} of ${mint}` });
  return { signature, burnedRaw: amount.toString(), simulated: false };
}

module.exports = { burnBought };
