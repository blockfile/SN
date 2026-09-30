'use strict';

const { PublicKey } = require('@solana/web3.js');
const config = require('../config');
const { walletPubkey } = require('./connection');

// pump.fun accounts that hold the holder mint's supply but aren't people: the
// bonding-curve PDAs (the curve reserve's token account is owned by the curve —
// before graduation it holds most of the supply and would swallow the rewards)
// and the canonical PumpSwap pool. PDA derivation is pure (no RPC), so this
// can't fail a cycle; an invalid mint just yields nothing.
function derivedExcludes(holderMint) {
  let mint;
  try {
    mint = new PublicKey(holderMint);
  } catch (_err) {
    return [];
  }
  const { bondingCurvePda, bondingCurveV2Pda, canonicalPumpPoolPda } = require('@pump-fun/pump-sdk');
  return [bondingCurvePda(mint), bondingCurveV2Pda(mint), canonicalPumpPoolPda(mint)].map((pk) => pk.toBase58());
}

// Owners that must never receive an airdrop: the operating wallet, the
// marketing wallet, any manually-listed vaults (AIRDROP_EXCLUDE), and the
// pump.fun curve/pool PDAs for the holder mint.
async function buildExcludeSet(holderMint) {
  const set = new Set();
  const add = (v) => { if (v) set.add(typeof v === 'string' ? v : v.toBase58()); };

  add(walletPubkey());
  add(config.marketingWallet);
  for (const a of config.airdropExclude) add(a);
  if (holderMint) for (const a of derivedExcludes(holderMint)) add(a);
  return set;
}

module.exports = { buildExcludeSet, derivedExcludes };
