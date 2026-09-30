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
    console.warn('[superneko] CLUSTERS is not valid JSON — ignoring');
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
  // Jupiter buys' own slippage, in bps. Kept tight: the reward buys are ~40% of
  // each claim, and a loose tolerance is what a sandwich bot extracts.
  jupiterSlippageBps: num(process.env.JUPITER_SLIPPAGE_BPS, 100),

  // Schedule — the vault is CHECKED on this timer (default every minute). A cycle
  // only runs when the unclaimed balance has reached the MIN_CLAIM_USD threshold;
  // otherwise the tick skips silently and fees keep accruing. POST /api/run
  // ignores the threshold and claims whatever is there.
  pollSchedule: process.env.POLL_SCHEDULE || '* * * * *',
  // DRY_RUN only: simulated SOL added to the fee vault each tick, so cycles have
  // something to claim without real fees. Kept below the MIN_CLAIM_USD threshold so dry runs
  // exercise the accumulate-over-several-ticks path rather than firing every tick.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.05),

  // Eligibility + airdrop. TOKEN_MINT (above) is $SN: its creator fees fund each
  // cycle, and its holders receive the NVDAx and $SI rewards.
  rewardCapPct: num(process.env.REWARD_CAP_PCT, 0), // per-wallet weight cap, % of supply (0 = no cap)
  minHold: num(process.env.MIN_HOLD, 1), // min $SN balance to qualify (whole tokens)
  clusters: parseClusters(process.env.CLUSTERS), // wallet groups treated as one person for the cap
  // Recipients per airdrop tx. Token-2022 ATA creation is compute-heavy, so keep
  // this small enough to fit COMPUTE_UNIT_LIMIT (failed batches retry one by one).
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 5),
  // Extra owner addresses excluded from airdrops (both pool vaults, etc.), comma-separated.
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Super Neko cycle ───────────────────────────────────────────────────────
  // Trigger: a cycle fires once unclaimed creator fees are worth >= minClaimUsd.
  minClaimUsd: num(process.env.MIN_CLAIM_USD, 100),
  // DRY_RUN only: fixed SOL/USD so dry runs and tests never touch the network.
  // 0 simulates "no price available".
  dryRunSolPriceUsd: num(process.env.DRY_RUN_SOL_PRICE_USD, 150),

  // Split of each claim, percent. Must sum to <= 100; any remainder stays in the
  // operating (dev) wallet. Marketing is the reserve: gas + ATA rent spent by the
  // other legs are deducted from it before it is sent.
  marketingPct: num(process.env.MARKETING_PCT, 50),
  burnPct: num(process.env.BURN_PCT, 10),
  nvdaxPct: num(process.env.NVDAX_PCT, 20),
  siPct: num(process.env.SI_PCT, 20),
  // Blank (or the operating wallet itself) = the marketing share stays in the dev wallet.
  marketingWallet: process.env.MARKETING_WALLET || null,

  // Reward tokens. Hard-coded mints — never resolve these by name (many fake
  // "NVIDIA xStock" copies exist on-chain).
  nvdaxMint: process.env.NVDAX_MINT || 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', // NVIDIA xStock (Token-2022, 8 dp)
  siMint: process.env.SI_MINT || 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP', // Super Inu (Token-2022, 6 dp, 1% transfer fee)
  // Skip a reward token's leg when its Token-2022 transfer fee exceeds this.
  maxTransferFeeBps: num(process.env.MAX_TRANSFER_FEE_BPS, 100),
  // Drop allocations worth less than this (≈ one new token account's rent) and
  // redistribute them to the remaining holders.
  minAirdropUsd: num(process.env.MIN_AIRDROP_USD, 0.5),

  // Storage (MongoDB)
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'superneko',

  // CORS allowlist (comma-separated). Default: localhost dev origins. Set to your
  // frontend domain(s) in production, or "*" to allow any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173,https://superneko.meme,https://www.superneko.meme')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Secret protecting the POST control endpoints. Blank = open (dev); set in prod.
  apiKey: process.env.API_KEY || null,
};

// Fail fast on a misconfigured split — a sum over 100 would spend SOL the claim
// never produced.
function validateSplit(c) {
  const parts = { MARKETING_PCT: c.marketingPct, BURN_PCT: c.burnPct, NVDAX_PCT: c.nvdaxPct, SI_PCT: c.siPct };
  for (const [key, value] of Object.entries(parts)) {
    if (!(value >= 0)) throw new Error(`${key} must be >= 0 (got ${value})`);
  }
  const sum = Object.values(parts).reduce((s, v) => s + v, 0);
  if (sum > 100) {
    throw new Error(`fee split sums to ${sum}% (MARKETING_PCT+BURN_PCT+NVDAX_PCT+SI_PCT must be <= 100)`);
  }
}
validateSplit(config);

module.exports = config;
