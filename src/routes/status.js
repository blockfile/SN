'use strict';

const express = require('express');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config');
const repo = require('../db/repository');
const scheduler = require('../jobs/scheduler');
const { connection, walletPubkey, wallet } = require('../solana/connection');
const { getUnclaimedSol } = require('../services/metrics');
const { getSolPriceUsd, toUsd } = require('../solana/price');

const router = express.Router();

const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'SN';

// GET /api/status — everything the dashboard needs: cards, totals (with USD),
// live unclaimed fees, scheduler state, and the last cycle.
router.get('/status', async (req, res, next) => {
  try {
    const [stats, lastCycle, unclaimed, price] = await Promise.all([
      repo.getStats(),
      repo.getLastCycle(),
      getUnclaimedSol().catch(() => ({ sol: null, at: Date.now() })),
      getSolPriceUsd(),
    ]);

    let solBalance = null;
    let balanceSource = 'none';
    if (!config.dryRun) {
      try {
        const lamports = await connection.getBalance(wallet.publicKey);
        solBalance = lamports / LAMPORTS_PER_SOL;
        balanceSource = 'rpc';
      } catch (err) {
        balanceSource = `rpc_error: ${err.message}`;
      }
    }

    res.json({
      dryRun: config.dryRun,
      tokenSymbol: TOKEN_SYMBOL,
      solPriceUsd: price,

      // top cards
      cards: {
        unclaimedSol: unclaimed.sol == null ? null : +unclaimed.sol.toFixed(6),
        unclaimedUsd: toUsd(unclaimed.sol, price),
        totalClaimedSol: stats.total_sol_claimed,
        totalClaimedUsd: toUsd(stats.total_sol_claimed, price),
      },

      wallet: {
        pubkey: walletPubkey(),
        ephemeral: config.walletIsEphemeral,
        solBalance,
        balanceSource,
      },
      token: {
        mint: config.tokenMint,
        nvdaxMint: config.nvdaxMint,
        siMint: config.siMint,
        pumpswapPoolId: config.pumpswapPoolId,
      },
      // Cycle parameters (trigger, fee split, eligibility).
      config: {
        pollSchedule: config.pollSchedule,
        minClaimUsd: config.minClaimUsd,
        marketingPct: config.marketingPct,
        burnPct: config.burnPct,
        nvdaxPct: config.nvdaxPct,
        siPct: config.siPct,
        marketingWallet: config.marketingWallet || walletPubkey(),
        rewardCapPct: config.rewardCapPct,
        minHold: config.minHold,
        minAirdropUsd: config.minAirdropUsd,
      },
      totals: {
        cycles: stats.cycles,
        completed: stats.completed,
        partial: stats.partial,
        failed: stats.failed,
        skipped: stats.skipped,
        solClaimed: stats.total_sol_claimed,
      },
      scheduler: scheduler.getState(),
      lastCycle,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
