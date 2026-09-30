'use strict';

const { toUsd } = require('../solana/price');

const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'BABYCUPSY';

// Map a stored step to the activity-row shape the dashboard renders. The cycle
// emits these step types: claim, buy, airdrop (+ error). `leg` tags which reward
// leg a step belongs to.
function toActivityRow(s, price) {
  const d = s.detail || {};
  let type;
  let amountSol = null;
  let status = 'Completed';

  switch (s.name) {
    case 'claim':
      type = 'Auto Claim';
      amountSol = d.solClaimed ?? null;
      status = 'Claimed';
      break;
    case 'buy':
      type = 'Buy';
      amountSol = d.solSpent ?? null;
      break;
    case 'airdrop':
      type = 'Airdrop';
      status = d.failed ? 'Failed' : 'Completed';
      break;
    default:
      type = s.name;
  }
  if (s.status === 'failed') status = 'Failed';

  return {
    id: s.id ?? null,
    cycleId: s.cycle_id,
    type,
    rawType: s.name,
    amountSol,
    usdValue: toUsd(amountSol, price),
    leg: d.leg ?? null,
    status,
    txHash: s.signature ?? null,
    at: s.created_at,
  };
}

// ── Public (frontend-facing) shapes — match frontend's API_SPEC.md exactly ──
// These power GET /activity and GET /stats, consumed by the frontend site.

// rawType (stored step name) -> the frontend's lowercase activity enum.
const PUBLIC_TYPE = {
  claim: 'claim',
  buy: 'buy',
  airdrop: 'airdrop',
};

// Map a stored step to the exact ActivityRow shape the frontend table renders.
// Caller passes steps newest-first (repo.getAllSteps already sorts desc).
function toPublicActivityRow(s, price) {
  const d = s.detail || {};

  let amountSol = null;
  let status = 'completed';
  switch (s.name) {
    case 'claim':
      amountSol = d.solClaimed ?? null;
      status = 'claimed';
      break;
    case 'buy':
      amountSol = d.solSpent ?? null;
      break;
    case 'airdrop':
      status = d.failed ? 'failed' : 'completed';
      break;
    default:
      break;
  }
  if (s.status === 'failed') status = 'failed';

  return {
    id: s.id != null ? String(s.id) : s.signature ?? null,
    type: PUBLIC_TYPE[s.name] ?? s.name,
    amountSol,
    // usdtValue MUST be a number — the frontend table calls .toLocaleString()
    // on it with no null guard.
    usdtValue: toUsd(amountSol, price) ?? 0,
    leg: d.leg ?? null,
    status,
    txHash: s.signature ?? null,
    timestamp: Date.parse(s.created_at) || null, // ISO -> epoch ms
  };
}

// Map the backend aggregates to frontend's flat /stats object. tokenInLp and
// marketCap have no backend source yet -> null (frontend shows its placeholder).
function toPublicStats({ stats, unclaimedSol, operatingWallet, market = {} }) {
  return {
    tokenInLp: market.tokenInLp ?? null, // tokens in the LP (DexScreener); null until listed
    marketCap: market.marketCap ?? null, // USD market cap (DexScreener); null until listed
    unclaimedFeesSol: unclaimedSol == null ? null : +unclaimedSol.toFixed(6),
    totalCreatorFeesClaimed: stats.total_sol_claimed,
    // The signer that performs claim/buy/airdrop (whose activity the table lists).
    operatingWallet: operatingWallet ?? null,
  };
}

// The unclaimed-fees card payload (used by /api/unclaimed and the SSE stream).
// Timer model: a cycle claims whatever has accrued on a fixed schedule — there is
// no claim threshold — so this reports the live balance only.
function buildUnclaimedPayload(sol, price) {
  return {
    unclaimedSol: sol == null ? null : +sol.toFixed(6),
    unclaimedUsd: toUsd(sol, price),
    solPriceUsd: price,
  };
}

// Headline numbers for the frontend: $CUPSY distributed to BABYCUPSY holders.
// byMint is keyed by reward_mint (repo.getAirdropTotals): { sends, totalUi, holders }.
function toPublicSummary({ stats, byMint, eligibleHolders = 0, totalHolders = null, price, cupsyMint, marketCapUsd = null }) {
  const z = { totalUi: 0, holders: 0, sends: 0 };
  const cupsy = byMint[cupsyMint] || z;
  const claimedSol = stats.total_sol_claimed || 0;
  return {
    creatorFeesClaimedSol: claimedSol,
    creatorFeesClaimedUsd: +(claimedSol * (price || 0)).toFixed(2),
    marketCapUsd: marketCapUsd ?? null,
    // $CUPSY sent to BABYCUPSY holders
    cupsyDistributed: cupsy.totalUi,
    // currently-eligible holders (latest cycle's snapshot) — NOT the all-time recipient union
    holders: eligibleHolders,
    // ALL wallets with any balance (Solscan-style), from the same snapshot;
    // null until a cycle has recorded it
    totalHolders,
    distributions: cupsy.sends,
  };
}

module.exports = {
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
  toPublicSummary,
  buildUnclaimedPayload,
  TOKEN_SYMBOL,
};
