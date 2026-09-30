'use strict';

const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
const { sendIxs, readTokenBalance, readTokenBalanceSettled, getMintInfo } = require('./tokens');

// PumpSwap AMM program (mainnet).
const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function requireTokenMint() {
  if (!config.tokenMint) throw new Error('TOKEN_MINT is required for live mode');
  return new PublicKey(config.tokenMint);
}

/** The canonical (post-graduation) pool — explicit override, else derived from the mint. */
function resolveCanonicalPool(mint) {
  if (config.dryRun) return 'simCanonicalPool';
  const { canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');
  if (mint) return canonicalPumpPoolPda(new PublicKey(mint));
  if (config.pumpswapPoolId) return new PublicKey(config.pumpswapPoolId);
  return canonicalPumpPoolPda(requireTokenMint());
}

/** Buy on a PumpSwap pool (post-bond canonical), spending `solAmount` SOL. */
async function buyOnAmm(solAmount, poolKey) {
  if (config.dryRun) {
    const baseDecimals = 6;
    const tokensBought = +(solAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('ammbuy'),
      tokensBought,
      tokensBoughtRaw: String(Math.floor(tokensBought * 10 ** baseDecimals)),
      baseDecimals,
      simulated: true,
    };
  }

  const BN = require('bn.js');
  const { OnlinePumpAmmSdk, PumpAmmSdk } = require('@pump-fun/pump-swap-sdk');
  const pool = poolKey || resolveCanonicalPool();
  const online = new OnlinePumpAmmSdk(connection);
  const offline = new PumpAmmSdk();

  const poolData = await online.fetchPool(pool);
  const { decimals: baseDecimals, programId: baseProgram } = await getMintInfo(connection, poolData.baseMint);
  const balBefore = await readTokenBalance(connection, poolData.baseMint, wallet.publicKey, baseProgram);

  const lamports = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));
  const swapState = await online.swapSolanaState(pool, wallet.publicKey);
  const ixs = await offline.buyQuoteInput(swapState, lamports, config.slippagePct);
  const signature = await sendIxs(connection, wallet, ixs, { label: 'buy on AMM' });

  // Retry the read — a freshly-created ATA can 404 right after confirmation.
  const balAfter = await readTokenBalanceSettled(connection, poolData.baseMint, wallet.publicKey, baseProgram, balBefore);
  const boughtRaw = balAfter - balBefore;
  return {
    signature,
    tokensBought: Number(boughtRaw) / 10 ** baseDecimals,
    tokensBoughtRaw: boughtRaw.toString(),
    baseDecimals,
    simulated: false,
  };
}

module.exports = {
  resolveCanonicalPool,
  buyOnAmm,
  PUMPSWAP_PROGRAM_ID,
};
