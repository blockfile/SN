'use strict';

const { PublicKey } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
// Called through the module object so tests can stub the chain.
const tokens = require('./tokens');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Buyback & burn: destroy exactly `amountRaw` of `mint` from the operating
 * wallet's token account (SPL burnChecked — lowers on-chain supply). The caller
 * passes only what THIS cycle bought, never the wallet's pre-existing balance.
 * `keepAtLeastRaw` (the wallet's balance before the buy) is re-checked live as a
 * second line of defence: the burn is refused if it would leave less than that.
 * @returns {Promise<{signature: string|null, burnedRaw: string, simulated: boolean}>}
 */
async function burnBought(mint, amountRaw, { keepAtLeastRaw } = {}) {
  const amount = BigInt(amountRaw.toString());
  if (amount <= 0n) return { signature: null, burnedRaw: '0', simulated: config.dryRun };
  if (config.dryRun) return { signature: fakeSig('burn'), burnedRaw: amount.toString(), simulated: true };

  const mintPk = new PublicKey(mint);
  const { decimals, programId } = await tokens.getMintInfo(connection, mint);
  if (keepAtLeastRaw != null) {
    const balance = await tokens.readTokenBalance(connection, mintPk, wallet.publicKey, programId);
    if (balance - amount < BigInt(keepAtLeastRaw.toString())) {
      throw new Error('burn would dip into pre-existing balance');
    }
  }
  const account = tokens.getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, programId);
  const ix = tokens.createBurnCheckedInstruction(account, mintPk, wallet.publicKey, amount, decimals, [], programId);
  const signature = await tokens.sendIxs(connection, wallet, [ix], { label: `burn ${amount} of ${mint}` });
  return { signature, burnedRaw: amount.toString(), simulated: false };
}

module.exports = { burnBought };
