'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { connection } = require('../solana/connection');
const { claimCreatorFees, buyToken } = require('../solana/pumpfun');
const { snapshotEligibleHolders } = require('../solana/holders');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../solana/airdrop');
const { getMintInfo, getTokenSupplyRaw } = require('../solana/tokens');
const { buildExcludeSet } = require('../solana/exclude');

// Run one reward leg. Snapshot holders of `holderMint` (>= minHold) ONCE, then for
// each { mint, solAmount } in `buys`: buy it and airdrop it weighted by holdings —
// each wallet's weight capped at `capPct`% of the holder mint's supply, clusters
// grouped as one wallet. Distribution is based ONLY on the amount bought THIS cycle
// (buy.tokensBoughtRaw), never the wallet's existing balance.
async function runRewardLeg(cycleId, { name, holderMint, minHold, capPct = null, clusters = [], buys }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [Leg ${name}] ${m}`);

  const decimals = config.dryRun ? 6 : (await getMintInfo(connection, holderMint)).decimals;
  const minHoldRaw = BigInt(Math.trunc(minHold)) * 10n ** BigInt(decimals);
  const exclude = await buildExcludeSet(holderMint);
  const { holders, totalHolders } = await snapshotEligibleHolders({ mint: holderMint, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${minHold}) of ${totalHolders} total`);

  const supplyRaw = capPct == null ? null : await getTokenSupplyRaw(connection, holderMint);

  const results = [];
  for (const { mint: buyMint, solAmount } of buys) {
    const buy = await buyToken(buyMint, solAmount);
    await repo.addStep({ cycleId, name: 'buy', status: 'ok', signature: buy.signature, detail: { leg: name, buyMint, solSpent: solAmount, tokensBought: buy.tokensBought } });
    log(`bought ${buy.tokensBought} of ${buyMint} with ${solAmount} SOL`);

    const distributeRaw = BigInt(buy.tokensBoughtRaw || '0');
    const allocations = computeWeightedAllocations(holders, distributeRaw.toString(), { capPct, supplyRaw, clusters });
    const result = await airdropToken({ rewardMint: buyMint, allocations, cycleId });
    await repo.addStep({ cycleId, name: 'airdrop', status: result.failed ? 'failed' : 'ok', detail: { leg: name, rewardMint: buyMint, recipients: allocations.length, sent: result.sent, failed: result.failed } });
    log(`airdrop ${buyMint} sent=${result.sent} failed=${result.failed}`);
    results.push({ buyMint, tokensBought: buy.tokensBought, sent: result.sent, failed: result.failed });
  }
  return { results, eligibleHolders: holders.length, totalHolders };
}

/**
 * One reward cycle (fired by the scheduler once unclaimed creator fees reach
 * MIN_CLAIM_SOL — ticks below that threshold are skipped upstream):
 *   claim BABYCUPSY creator fees (once)
 *   buy $CUPSY (80%) -> airdrop to BABYCUPSY holders pro-rata by holdings
 *     (optional per-wallet cap via REWARD_CAP_PCT; 0 = no cap)
 *   the remaining 20% stays in the operating wallet (tx fees + per-recipient rent)
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (m) => console.log(`[cycle ${id}] ${m}`);
  try {
    const claim = await claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { solClaimed: claim.solClaimed } });
    log(`claimed ${claim.solClaimed} SOL`);
    if (!(claim.solClaimed > 0)) {
      await repo.finishCycle(id, { status: 'skipped', sol_claimed: claim.solClaimed, note: 'nothing claimed' });
      return repo.getCycleWithSteps(id);
    }
    if (!config.tokenMint || !config.cupsyMint) {
      throw new Error('TOKEN_MINT (BABYCUPSY) and CUPSY_MINT ($CUPSY) are required');
    }

    const sol = (pct) => +(claim.solClaimed * (pct / 100)).toFixed(6);

    // Buy $CUPSY and airdrop it to BABYCUPSY holders pro-rata (no cap unless
    // REWARD_CAP_PCT > 0).
    const legA = await runRewardLeg(id, {
      name: 'A',
      holderMint: config.tokenMint,
      minHold: config.minHold,
      capPct: config.rewardCapPct > 0 ? config.rewardCapPct : null,
      clusters: config.clusters,
      buys: [{ mint: config.cupsyMint, solAmount: sol(config.cupsyBuyPct) }],
    });

    const sent = legA.results.reduce((s, r) => s + r.sent, 0);
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'airdrop',
      sol_claimed: claim.solClaimed,
      eligible_holders: legA.eligibleHolders,
      total_holders: legA.totalHolders,
      note: `sent ${sent}`,
    });
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    console.log(`[cycle ${id}] FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg };
