'use strict';

const config = require('../config');
const { walletPubkey } = require('./connection');

// Owners that must never receive an airdrop: the operating wallet, the dev
// wallet, any manually-listed vaults (AIRDROP_EXCLUDE), and — in live mode —
// the derived canonical pool PDA for the holder mint (the LP/curve reserve
// account). Pool derivation is best-effort: a
// failure must never break a cycle, so the manual list is the guaranteed path.
async function buildExcludeSet(holderMint) {
  const set = new Set();
  const add = (v) => { if (v) set.add(typeof v === 'string' ? v : v.toBase58()); };

  add(walletPubkey());
  add(config.devWallet);
  for (const a of config.airdropExclude) add(a);

  if (!config.dryRun && holderMint) {
    try {
      const { resolveCanonicalPool } = require('./pumpswap');
      add(resolveCanonicalPool(holderMint)); // PublicKey | string
    } catch (_err) {
      // derivation unavailable — rely on AIRDROP_EXCLUDE
    }
  }
  return set;
}

module.exports = { buildExcludeSet };
