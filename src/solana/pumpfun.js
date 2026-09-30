'use strict';

const { LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
const { sendIxs, unwrapWsol, readTokenBalance, readTokenBalanceSettled, getMintInfo, NATIVE_MINT } = require('./tokens');
const { buyOnAmm, resolveCanonicalPool } = require('./pumpswap');
const { buyViaJupiter } = require('./jupiter');
const simvault = require('./simvault');

// pump.fun main program (mainnet).
const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// pump.fun tokens are 6 decimals.
const PUMP_TOKEN_DECIMALS = 6;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function requireTokenMint() {
  if (!config.tokenMint) throw new Error('TOKEN_MINT is required for live mode');
  return new PublicKey(config.tokenMint);
}

/**
 * Claim creator fees from pump.fun (works pre- and post-graduation).
 * @returns {Promise<{signature, solClaimed, simulated, note?}>}
 */
/**
 * Read the claimable creator-fee balance WITHOUT claiming (gates the threshold trigger).
 * @returns {Promise<number>} claimable SOL
 */
async function getClaimableSol() {
  if (config.dryRun) {
    return simvault.peek(); // pure read — accrual happens in simulateFeeAccrual()
  }
  const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
  const sdk = new OnlinePumpSdk(connection);
  const lamports = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
  return lamports.toNumber() / LAMPORTS_PER_SOL;
}

/**
 * Advance the simulated creator-fee vault by one poll's worth of fees. DRY_RUN
 * only — in live mode fees accrue on-chain, so this is a no-op. Called once per
 * scheduler poll so the >= threshold trigger can actually be reached and tested.
 */
function simulateFeeAccrual() {
  if (config.dryRun) simvault.accrue(config.dryRunFeePerPoll);
}

async function claimCreatorFees() {
  if (config.dryRun) {
    const solClaimed = +simvault.drain().toFixed(6);
    return { signature: fakeSig('claim'), solClaimed, simulated: true };
  }

  const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
  const sdk = new OnlinePumpSdk(connection);

  const claimable = await sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
  if (claimable.isZero()) {
    return { signature: null, solClaimed: 0, simulated: false, note: 'nothing to claim' };
  }

  const ixs = await sdk.collectCoinCreatorFeeInstructions(wallet.publicKey);
  const signature = await sendIxs(connection, wallet, ixs, { label: 'claim creator fees' });
  await unwrapWsol(connection, wallet); // AMM-side fees pay WSOL → unwrap to native SOL

  return { signature, solClaimed: claimable.toNumber() / LAMPORTS_PER_SOL, simulated: false };
}

/**
 * Has the token graduated (bonding curve complete / migrated to PumpSwap)?
 * @returns {Promise<{graduated: boolean, source: string}>}
 */
async function isGraduated(mint) {
  if (config.dryRun) {
    return { graduated: config.simulateGraduated, source: 'simulated' };
  }

  const { OnlinePumpSdk, canonicalPumpPoolPda } = require('@pump-fun/pump-sdk');
  mint = mint ? new PublicKey(mint) : requireTokenMint();
  const sdk = new OnlinePumpSdk(connection);

  // Primary: the bonding curve's `complete` flag.
  try {
    const { bondingCurve } = await sdk.fetchBuyState(mint, wallet.publicKey);
    if (bondingCurve && bondingCurve.complete === true) {
      return { graduated: true, source: 'bondingCurve.complete' };
    }
    if (bondingCurve) return { graduated: false, source: 'bondingCurve.complete' };
  } catch (_err) {
    // Curve account missing — fall through to pool-existence check.
  }

  // Corroborating: does the canonical PumpSwap pool exist?
  const poolInfo = await connection.getAccountInfo(canonicalPumpPoolPda(mint));
  return { graduated: poolInfo !== null, source: 'canonicalPool' };
}

/**
 * Buy the token on its bonding curve, spending `solAmount` SOL.
 * @returns {Promise<{signature, tokensBought, tokensBoughtRaw, baseDecimals, simulated}>}
 */
async function buyOnCurve(mint, solAmount) {
  if (config.dryRun) {
    const tokensBought = +(solAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('curvebuy'),
      tokensBought,
      tokensBoughtRaw: String(Math.floor(tokensBought * 10 ** PUMP_TOKEN_DECIMALS)),
      baseDecimals: PUMP_TOKEN_DECIMALS,
      simulated: true,
    };
  }

  const BN = require('bn.js');
  const { OnlinePumpSdk, PumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
  mint = mint ? new PublicKey(mint) : requireTokenMint();
  const user = wallet.publicKey;
  const online = new OnlinePumpSdk(connection);
  const offline = new PumpSdk();

  // Detect the mint's actual token program — pump.fun issues some tokens as Token-2022.
  const { decimals: baseDecimals, programId: tokenProgram } = await getMintInfo(connection, mint);

  const [global, feeConfig, buyState] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig(),
    online.fetchBuyState(mint, user),
  ]);
  const { bondingCurve, bondingCurveAccountInfo, associatedUserAccountInfo } = buyState;
  if (bondingCurve.complete) {
    throw new Error('token already graduated — use the AMM buy, not the curve');
  }

  const solLamports = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));
  const expectedTokens = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: global.tokenTotalSupply,
    bondingCurve,
    amount: solLamports,
    quoteMint: NATIVE_MINT,
  });

  const balBefore = await readTokenBalance(connection, mint, user, tokenProgram);
  const ixs = await offline.buyInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    amount: expectedTokens,
    solAmount: solLamports,
    slippage: config.curveSlippagePct, // percent
    tokenProgram,
  });
  const signature = await sendIxs(connection, wallet, ixs, { label: 'buy on bonding curve' });

  // Retry the read — a freshly-created ATA can 404 right after confirmation.
  const balAfter = await readTokenBalanceSettled(connection, mint, user, tokenProgram, balBefore);
  const boughtRaw = balAfter - balBefore;
  return {
    signature,
    tokensBought: Number(boughtRaw) / 10 ** baseDecimals,
    tokensBoughtRaw: boughtRaw.toString(),
    baseDecimals,
    simulated: false,
  };
}

// Decide how to buy `mint`:
//   'amm'     — graduated pump.fun token / canonical PumpSwap pool
//   'curve'   — live pump.fun bonding curve (pre-graduation)
//   'jupiter' — anything else with DEX liquidity (e.g. $PUMP, which has neither)
async function resolveBuyRoute(mint) {
  if (config.dryRun) return config.simulateGraduated ? 'amm' : 'curve';

  const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
  const { canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');
  const mintPk = new PublicKey(mint);
  const sdk = new OnlinePumpSdk(connection);

  // 1) On a pump.fun bonding curve? The curve account persists post-graduation
  //    (complete=true), so this also catches graduated pump.fun tokens.
  try {
    const { bondingCurve } = await sdk.fetchBuyState(mintPk, wallet.publicKey);
    if (bondingCurve) return bondingCurve.complete ? 'amm' : 'curve';
  } catch (_err) {
    // No bonding-curve account — not a pump.fun-launched token.
  }
  // 2) Graduated to a canonical PumpSwap pool?
  if (await connection.getAccountInfo(canonicalPumpPoolPda(mintPk))) return 'amm';
  // 3) Neither — route through Jupiter (any liquid token, any DEX).
  return 'jupiter';
}

// Buy `mint` with `solAmount` SOL via the best available route.
async function buyToken(mint, solAmount) {
  const route = await resolveBuyRoute(mint);
  if (route === 'amm') return buyOnAmm(solAmount, resolveCanonicalPool(mint));
  if (route === 'curve') return buyOnCurve(mint, solAmount);
  return buyViaJupiter(mint, solAmount);
}

module.exports = { claimCreatorFees, getClaimableSol, simulateFeeAccrual, isGraduated, resolveBuyRoute, buyOnCurve, buyToken, PUMP_PROGRAM_ID };
