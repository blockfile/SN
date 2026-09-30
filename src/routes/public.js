'use strict';

// Public, frontend-shaped endpoints for the frontend site. These emit the
// exact shapes in frontend/API_SPEC.md (GET /activity, GET /stats) so the
// frontend only has to point at these URLs — no field remapping on its side.

const express = require('express');
const repo = require('../db/repository');
const { getUnclaimedSol } = require('../services/metrics');
const { getMarketData } = require('../services/marketdata');
const { getSolPriceUsd } = require('../solana/price');
const { walletPubkey } = require('../solana/connection');
const { toPublicActivityRow, toPublicStats, toPublicSummary } = require('../services/format');
const config = require('../config');
const { nextRun, thresholdProgress } = require('../services/countdown');
const scheduler = require('../jobs/scheduler');

const router = express.Router();

// Tiny in-memory TTL cache. The frontend polls activity ~4s and stats ~20s and
// the spec asks the backend to cache; this also de-dupes concurrent requests.
function cached(ttlMs, fn) {
  let value;
  let expires = 0;
  let inflight = null;
  return async () => {
    if (Date.now() < expires) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await fn();
        expires = Date.now() + ttlMs;
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

const loadActivity = cached(3000, async () => {
  const [steps, price] = await Promise.all([repo.getAllSteps(100, 0), getSolPriceUsd()]);
  return steps.map((s) => toPublicActivityRow(s, price)); // repo returns newest-first
});

const loadStats = cached(15000, async () => {
  const [stats, unclaimed, market] = await Promise.all([
    repo.getStats(),
    getUnclaimedSol().catch(() => ({ sol: null })),
    getMarketData().catch(() => ({ tokenInLp: null, marketCap: null })),
  ]);
  return toPublicStats({
    stats,
    unclaimedSol: unclaimed.sol,
    operatingWallet: walletPubkey(),
    market,
  });
});

// GET /activity — array of transactions, newest first (API_SPEC.md §1)
router.get('/activity', async (req, res, next) => {
  try {
    res.json(await loadActivity());
  } catch (err) {
    next(err);
  }
});

// GET /stats — single object of live numbers (API_SPEC.md §2)
router.get('/stats', async (req, res, next) => {
  try {
    res.json(await loadStats());
  } catch (err) {
    next(err);
  }
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// Map a frontend token tab to its reward_mint. 'OUR' is the legacy tab key for
// the main token (BABYCUPSY). Unknown/unconfigured tokens map to a sentinel so
// the query returns empty (never an unfiltered dump).
function tokenToMint(token) {
  if (!token) return null;
  const map = {
    CUPSY: config.cupsyMint,
    BABYCUPSY: config.tokenMint,
    OUR: config.tokenMint,
  };
  return map[String(token).toUpperCase()] || '__none__';
}

// GET /airdrops?limit=&offset=&token=CUPSY|BABYCUPSY|OUR — per-recipient send history,
// newest first. `token` filters by reward stream (the frontend's tabs).
router.get('/airdrops', async (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const token = req.query.token ? String(req.query.token).toUpperCase() : null;
    const rewardMint = tokenToMint(token);
    const { total, items } = await repo.getAirdrops(limit, offset, rewardMint);
    res.json({ total, limit, offset, token, items });
  } catch (err) {
    next(err);
  }
});

// Unclaimed creator fees for the threshold-progress endpoints below. Uses the
// shared 20s cache (so a 6s frontend poll costs no extra RPC) and falls back to
// the scheduler's last poll reading if the RPC is unreachable.
async function readUnclaimedSol() {
  try {
    const { sol } = await getUnclaimedSol();
    if (sol != null) return sol;
  } catch (_err) {
    /* fall through to the scheduler's cached reading */
  }
  return scheduler.getState().lastClaimable;
}

// GET /countdown — next vault CHECK plus progress toward the claim threshold.
// Airdrops are threshold-triggered (unclaimed fees >= MIN_CLAIM_SOL), so there is
// no fixed next-airdrop time; nextCheckAt is when the vault is next read, and
// progressPct is how close that balance is to firing a cycle. nextAirdropAt is
// retained as an alias of nextCheckAt so existing frontends keep working.
// Not cached: serverTime must be fresh so the client can anchor to the server clock.
router.get('/countdown', async (req, res, next) => {
  try {
    const now = Date.now();
    const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, now);
    const unclaimedSol = await readUnclaimedSol();
    res.json({
      serverTime: now,
      nextCheckAt: nextAirdropAt,
      nextAirdropAt,
      intervalSec,
      unclaimedSol: unclaimedSol == null ? null : +unclaimedSol.toFixed(6),
      thresholdSol: config.minClaimSol,
      progressPct: thresholdProgress(unclaimedSol, config.minClaimSol),
    });
  } catch (err) {
    next(err);
  }
});

// GET /accumulator — the reward-pot fill level, in the exact shape the frontend's
// RewardJar expects: { accumulatedSol, thresholdSol }. accumulatedSol is the live
// unclaimed creator-fee balance; when it reaches thresholdSol the next poll fires a
// cycle, the vault drains, and the jar splashes back toward 0.
router.get('/accumulator', async (req, res, next) => {
  try {
    const sol = await readUnclaimedSol();
    res.json({
      accumulatedSol: sol == null ? 0 : +sol.toFixed(6),
      thresholdSol: config.minClaimSol,
    });
  } catch (err) {
    next(err);
  }
});

// Headline numbers for the frontend.
const loadSummary = cached(10000, async () => {
  const [stats, byMint, holderCounts, price, market] = await Promise.all([
    repo.getStats(),
    repo.getAirdropTotals(),
    repo.getLatestEligibleHolders(),
    getSolPriceUsd().catch(() => 0),
    getMarketData().catch(() => ({ marketCap: null })),
  ]);
  return toPublicSummary({
    stats,
    byMint,
    eligibleHolders: holderCounts.eligible,
    totalHolders: holderCounts.total,
    price,
    cupsyMint: config.cupsyMint,
    marketCapUsd: market.marketCap ?? null,
  });
});

// GET /summary — hero headline stats.
router.get('/summary', async (req, res, next) => {
  try {
    res.json(await loadSummary());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
