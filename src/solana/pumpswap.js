'use strict';

const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
const { sendIxs, readTokenBalance, readTokenBalanceSettled, getMintInfo, NATIVE_MINT } = require('./tokens');

// PumpSwap AMM program (mainnet).
const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const OUR_POOL_INDEX = 0; // our wallet as owner → distinct from the canonical pool

// DRY_RUN-only flag simulating whether our pool has been created yet.
let simOurPoolCreated = false;

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

/** Our own pre-bond pool — deterministic from (index, ourWallet, mint, WSOL). */
function resolveOurPool() {
  if (config.dryRun) return 'simOurPool';
  const { poolPda } = require('@pump-fun/pump-swap-sdk');
  return poolPda(OUR_POOL_INDEX, wallet.publicKey, requireTokenMint(), NATIVE_MINT);
}

async function poolExists(poolKey) {
  if (config.dryRun) return simOurPoolCreated;
  const info = await connection.getAccountInfo(poolKey);
  return info !== null;
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

/**
 * Create our pre-bond pool, seeding it with the base tokens we hold + `quoteSol` SOL.
 * createPool auto-deposits the initial liquidity and mints LP to us in one tx.
 */
async function createOurPool(baseTokenHint, quoteSol) {
  if (config.dryRun) {
    simOurPoolCreated = true;
    const lpDecimals = 9;
    const lpReceived = +Math.sqrt(Math.max(baseTokenHint, 0) * Math.max(quoteSol, 0)).toFixed(6);
    return {
      signature: fakeSig('createpool'),
      lpReceived,
      lpReceivedRaw: String(Math.floor(lpReceived * 10 ** lpDecimals)),
      lpMint: 'simOurLpMint',
      lpDecimals,
      pool: 'simOurPool',
      simulated: true,
    };
  }

  const BN = require('bn.js');
  const { OnlinePumpAmmSdk, PumpAmmSdk, poolPda, lpMintPda } = require('@pump-fun/pump-swap-sdk');
  const mint = requireTokenMint();
  const online = new OnlinePumpAmmSdk(connection);
  const offline = new PumpAmmSdk();

  const { programId: baseProgram } = await getMintInfo(connection, mint);
  const baseBalance = await readTokenBalance(connection, mint, wallet.publicKey, baseProgram);
  if (baseBalance <= 0n) throw new Error('no base tokens to seed the pool');
  const baseIn = new BN(baseBalance.toString());
  const quoteIn = new BN(Math.floor(quoteSol * LAMPORTS_PER_SOL));

  const state = await online.createPoolSolanaState(OUR_POOL_INDEX, wallet.publicKey, mint, NATIVE_MINT);
  const ixs = await offline.createPoolInstructions(state, baseIn, quoteIn);
  const signature = await sendIxs(connection, wallet, ixs, { label: 'create pool' });

  const pool = poolPda(OUR_POOL_INDEX, wallet.publicKey, mint, NATIVE_MINT);
  const lpMint = lpMintPda(pool);
  const { decimals: lpDecimals, programId: lpProgram } = await getMintInfo(connection, lpMint);
  const lpBalance = await readTokenBalance(connection, lpMint, wallet.publicKey, lpProgram);
  return {
    signature,
    lpReceived: Number(lpBalance) / 10 ** lpDecimals,
    lpReceivedRaw: lpBalance.toString(),
    lpMint: lpMint.toBase58(),
    lpDecimals,
    pool: pool.toBase58(),
    simulated: false,
  };
}

/** Deposit the base tokens we hold (+ matching SOL) into an existing pool. */
async function depositToPool(poolKey, baseTokenHint, quoteSolHint) {
  if (config.dryRun) {
    const lpDecimals = 9;
    const lpReceived = +Math.sqrt(Math.max(baseTokenHint, 0) * Math.max(quoteSolHint, 0)).toFixed(6);
    return {
      signature: fakeSig('deposit'),
      lpReceived,
      lpReceivedRaw: String(Math.floor(lpReceived * 10 ** lpDecimals)),
      lpMint: typeof poolKey === 'string' ? `${poolKey}-lp` : 'simLpMint',
      lpDecimals,
      pool: typeof poolKey === 'string' ? poolKey : 'simPool',
      simulated: true,
    };
  }

  const BN = require('bn.js');
  const { OnlinePumpAmmSdk, PumpAmmSdk, lpMintPda } = require('@pump-fun/pump-swap-sdk');
  const online = new OnlinePumpAmmSdk(connection);
  const offline = new PumpAmmSdk();

  const poolData = await online.fetchPool(poolKey);
  const { programId: baseProgram } = await getMintInfo(connection, poolData.baseMint);
  const baseBalance = await readTokenBalance(connection, poolData.baseMint, wallet.publicKey, baseProgram);
  if (baseBalance <= 0n) throw new Error('no base tokens to add as liquidity');
  // The SDK sizes the deposit's max base at the requested amount PLUS a slippage
  // buffer, so requesting our FULL balance makes maxBase exceed what we hold and the
  // (Token-2022) TransferChecked fails with "insufficient funds" (0x1) whenever the
  // pool ratio drifts. Request a margin below the balance (slippage% + 1%) so the
  // buffered max still fits. Leftover dust is picked up by the next deposit.
  const marginBps = BigInt(Math.round((config.slippagePct + 1) * 100));
  const baseAmount = new BN(((baseBalance * (10000n - marginBps)) / 10000n).toString());
  if (baseAmount.lten(0)) throw new Error('base balance too small to add as liquidity after margin');

  const liqState = await online.liquiditySolanaState(poolKey, wallet.publicKey);
  const { lpToken } = offline.depositAutocompleteQuoteAndLpTokenFromBase(liqState, baseAmount, config.slippagePct);
  const ixs = await offline.depositInstructions(liqState, lpToken, config.slippagePct);
  const signature = await sendIxs(connection, wallet, ixs, { label: 'add liquidity' });

  const lpMint = lpMintPda(poolKey);
  const { decimals: lpDecimals } = await getMintInfo(connection, lpMint);
  return {
    signature,
    lpReceived: Number(lpToken) / 10 ** lpDecimals,
    lpReceivedRaw: lpToken.toString(),
    lpMint: lpMint.toBase58(),
    lpDecimals,
    pool: poolKey.toBase58 ? poolKey.toBase58() : String(poolKey),
    simulated: false,
  };
}

module.exports = {
  resolveCanonicalPool,
  resolveOurPool,
  poolExists,
  buyOnAmm,
  createOurPool,
  depositToPool,
  PUMPSWAP_PROGRAM_ID,
};
