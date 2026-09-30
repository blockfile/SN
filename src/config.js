'use strict';

require('dotenv').config();

const { Keypair } = require('@solana/web3.js');
// bs58 v6 is ESM-only; under CommonJS require() the API is on `.default`.
const bs58lib = require('bs58');
const bs58 = bs58lib.default || bs58lib;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseClusters(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    // Keep only arrays of non-empty strings.
    return parsed
      .filter((g) => Array.isArray(g))
      .map((g) => g.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))
      .filter((g) => g.length > 0);
  } catch (_err) {
    console.warn('[babycupsy] CLUSTERS is not valid JSON — ignoring');
    return [];
  }
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

/**
 * Load the signing wallet.
 * Accepts either a base58 secret key or a JSON array of bytes.
 * In DRY_RUN with no key configured, an ephemeral keypair is generated so the
 * server runs out of the box (no funds are ever touched in dry run).
 */
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) {
      throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    }
    return { keypair: Keypair.generate(), ephemeral: true };
  }
  try {
    if (raw.trim().startsWith('[')) {
      const bytes = Uint8Array.from(JSON.parse(raw));
      return { keypair: Keypair.fromSecretKey(bytes), ephemeral: false };
    }
    return { keypair: Keypair.fromSecretKey(bs58.decode(raw.trim())), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}

const { keypair: wallet, ephemeral: walletIsEphemeral } = loadWallet();

const config = {
  port: num(process.env.PORT, 3000),
  dryRun: DRY_RUN,

  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  wallet,
  walletIsEphemeral,

  // Target token + its PumpSwap pool
  tokenMint: process.env.TOKEN_MINT || null,
  pumpswapPoolId: process.env.PUMPSWAP_POOL_ID || null,

  // Economics
  solSplitBuy: num(process.env.SOL_SPLIT_BUY, 0.5), // fraction of spendable SOL used to buy
  solReserve: num(process.env.SOL_RESERVE, 0.02), // SOL kept back for tx gas, never spent
  lockYears: num(process.env.LOCK_YEARS, 999),

  // SOL held back from each claim to pay the Streamflow lock (measured ≈0.1706/lock).
  lockCostSol: num(process.env.LOCK_COST_SOL, 0.18),

  // Legacy single-airdrop-bot setting — NOT used by the cycle. runCycle()
  // never sends a separate dev cut; 20% of each claim stays in the operating
  // wallet (covers tx fees + per-holder account rent). Kept only so the
  // status/activity display fields stay defined; default 0 so they report no cut.
  devFeePct: num(process.env.DEV_FEE_PCT, 0), // legacy; runCycle ignores it
  devWallet: process.env.DEV_WALLET || null,

  // On-chain execution (live mode only)
  slippagePct: num(process.env.SLIPPAGE_PCT, 1), // PumpSwap AMM slippage (convention TBD — verify live)
  curveSlippagePct: num(process.env.CURVE_SLIPPAGE_PCT, 5), // bonding-curve buy slippage, percent
  priorityFeeMicroLamports: num(process.env.PRIORITY_FEE_MICROLAMPORTS, 50000),
  computeUnitLimit: num(process.env.COMPUTE_UNIT_LIMIT, 200000),

  // DRY_RUN-only: simulate a graduated token to exercise the post-bond path.
  simulateGraduated: bool(process.env.SIMULATE_GRADUATED, false),

  // Jupiter aggregator — buys reward tokens that have no pump.fun bonding curve
  // or canonical PumpSwap pool (e.g. $PUMP). Free lite-api needs no key.
  jupiterApi: process.env.JUPITER_API || 'https://lite-api.jup.ag/swap/v1',
  jupiterApiKey: process.env.JUPITER_API_KEY || null,
  jupiterPriorityFeeLamports: num(process.env.JUPITER_PRIORITY_FEE_LAMPORTS, 1000000), // priority fee per Jupiter swap

  // Schedule — the vault is CHECKED on this timer (default every minute). A cycle
  // only runs when the unclaimed balance has reached minClaimSol; otherwise the tick
  // skips silently and fees keep accruing.
  pollSchedule: process.env.POLL_SCHEDULE || '* * * * *',
  // Trigger threshold: unclaimed creator fees (SOL) required to fire a cycle.
  // POST /api/run ignores this and claims whatever is there.
  minClaimSol: num(process.env.MIN_CLAIM_SOL, 0.25),
  // DRY_RUN only: simulated SOL added to the fee vault each tick, so cycles have
  // something to claim without real fees. Kept below minClaimSol so dry runs
  // exercise the accumulate-over-several-ticks path rather than firing every tick.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.05),

  // Reward loop. TOKEN_MINT (above) is BABYCUPSY: its creator fees fund the cycle. Each
  // claim buys $CUPSY (airdropped to BABYCUPSY holders). 80% → $CUPSY; 20% stays
  // in the wallet for tx fees + per-recipient ATA rent.
  cupsyMint: process.env.CUPSY_MINT || null, // $CUPSY: bought + airdropped to BABYCUPSY holders
  cupsyBuyPct: num(process.env.CUPSY_BUY_PCT, 80), // % of claim → buy $CUPSY (airdrop)
  rewardCapPct: num(process.env.REWARD_CAP_PCT, 0), // per-wallet weight cap, % of supply (0 = no cap)
  minHold: num(process.env.MIN_HOLD, 100000), // min BABYCUPSY balance to qualify
  clusters: parseClusters(process.env.CLUSTERS), // wallet groups treated as one person for the cap
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 8), // recipient transfers per tx
  // Extra owner addresses excluded from airdrops (both pool vaults, etc.), comma-separated.
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Storage (MongoDB)
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'babycupsy',

  // CORS allowlist (comma-separated). Default: localhost dev origins. Set to your
  // frontend domain(s) in production, or "*" to allow any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Secret protecting the POST control endpoints. Blank = open (dev); set in prod.
  apiKey: process.env.API_KEY || null,
};

module.exports = config;
