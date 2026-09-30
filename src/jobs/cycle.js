'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { connection } = require('../solana/connection');
const pumpfun = require('../solana/pumpfun');
const { snapshotEligibleHolders } = require('../solana/holders');
const { computeWeightedAllocations, minRawForUsd } = require('../services/distribution');
const airdrop = require('../solana/airdrop');
const { getMintInfo, getTokenSupplyRaw } = require('../solana/tokens');
const { buildExcludeSet } = require('../solana/exclude');
const mintguard = require('../solana/mintguard');
const burn = require('../solana/burn');
const marketing = require('../solana/marketing');
const { getFreshSolPriceUsd } = require('../solana/price');

// SOL for a leg: pct% of the claim, 6 dp (what the buy step records).
const share = (solClaimed, pct) => +(solClaimed * (pct / 100)).toFixed(6);

async function recordLegFailure(cycleId, leg, err) {
  const message = err && err.message ? err.message : String(err);
  console.log(`[cycle ${cycleId}] [${leg}] FAILED: ${message}`);
  await repo.addStep({ cycleId, name: 'error', status: 'failed', detail: { leg, message } });
}

// Rewards: snapshot $SN holders ONCE, then for each reward token buy it and
// airdrop it pro-rata. Distribution uses only what THIS cycle bought. Each token
// is isolated — a guard trip or failure skips only that token, and its SOL
// stays in the wallet.
async function runRewardsLeg(cycleId, solClaimed, solPriceUsd) {
  const log = (m) => console.log(`[cycle ${cycleId}] [rewards] ${m}`);
  const holderMint = config.tokenMint;

  const decimals = config.dryRun ? 6 : (await getMintInfo(connection, holderMint)).decimals;
  const minHoldRaw = BigInt(Math.trunc(config.minHold)) * 10n ** BigInt(decimals);
  const exclude = await buildExcludeSet(holderMint);
  const { holders, totalHolders } = await snapshotEligibleHolders({ mint: holderMint, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : await getTokenSupplyRaw(connection, holderMint);

  const rewards = [
    { leg: 'nvdax', mint: config.nvdaxMint, pct: config.nvdaxPct },
    { leg: 'si', mint: config.siMint, pct: config.siPct },
  ];
  const results = [];
  for (const r of rewards) {
    const solAmount = share(solClaimed, r.pct);
    if (!(solAmount > 0) || !r.mint) {
      results.push({ leg: r.leg, status: 'skipped', reason: 'disabled' });
      continue;
    }
    if (holders.length === 0) {
      results.push({ leg: r.leg, status: 'skipped', reason: 'no eligible holders' });
      continue;
    }
    try {
      const guard = await mintguard.checkRewardMint(r.mint);
      if (!guard.ok) {
        await repo.addStep({ cycleId, name: 'guard', status: 'skipped', detail: { leg: r.leg, mint: r.mint, reason: guard.reason } });
        log(`${r.leg} skipped: ${guard.reason}`);
        results.push({ leg: r.leg, status: 'skipped', reason: guard.reason });
        continue;
      }

      const buy = await pumpfun.buyToken(r.mint, solAmount);
      await repo.addStep({
        cycleId,
        name: 'buy',
        status: 'ok',
        signature: buy.signature,
        detail: { leg: r.leg, buyMint: r.mint, solSpent: solAmount, tokensBought: buy.tokensBought },
      });

      const boughtRaw = BigInt(buy.tokensBoughtRaw || '0');
      const minAmountRaw = minRawForUsd({
        minUsd: config.minAirdropUsd,
        solSpent: solAmount,
        solPriceUsd,
        tokensBoughtRaw: boughtRaw,
      });
      const allocations = computeWeightedAllocations(holders, boughtRaw.toString(), {
        capPct,
        supplyRaw,
        clusters: config.clusters,
        minAmountRaw,
      });
      const res = await airdrop.airdropToken({ rewardMint: r.mint, allocations, cycleId });
      await repo.addStep({
        cycleId,
        name: 'airdrop',
        status: res.failed ? 'failed' : 'ok',
        detail: { leg: r.leg, rewardMint: r.mint, recipients: allocations.length, sent: res.sent, failed: res.failed },
      });
      log(`${r.leg}: bought ${buy.tokensBought} with ${solAmount} SOL, sent=${res.sent} failed=${res.failed}`);
      results.push({ leg: r.leg, status: res.failed ? 'failed' : 'ok', sent: res.sent, failed: res.failed });
    } catch (err) {
      await recordLegFailure(cycleId, r.leg, err);
      results.push({ leg: r.leg, status: 'failed', reason: err.message });
    }
  }
  return { results, eligibleHolders: holders.length, totalHolders };
}

// Buyback & burn: buy $SN with BURN_PCT and burn exactly what was bought.
async function runBurnLeg(cycleId, solClaimed) {
  const solAmount = share(solClaimed, config.burnPct);
  if (!(solAmount > 0)) return { leg: 'burn', status: 'skipped', reason: 'disabled' };
  try {
    const buy = await pumpfun.buyToken(config.tokenMint, solAmount);
    await repo.addStep({
      cycleId,
      name: 'buy',
      status: 'ok',
      signature: buy.signature,
      detail: { leg: 'burn', buyMint: config.tokenMint, solSpent: solAmount, tokensBought: buy.tokensBought },
    });
    const b = await burn.burnBought(config.tokenMint, buy.tokensBoughtRaw || '0');
    await repo.addStep({
      cycleId,
      name: 'burn',
      status: 'ok',
      signature: b.signature,
      detail: { leg: 'burn', mint: config.tokenMint, burnedRaw: b.burnedRaw, tokensBurned: buy.tokensBought },
    });
    console.log(`[cycle ${cycleId}] [burn] bought + burned ${buy.tokensBought} $SN with ${solAmount} SOL`);
    return { leg: 'burn', status: 'ok', tokensBurned: buy.tokensBought };
  } catch (err) {
    await recordLegFailure(cycleId, 'burn', err);
    return { leg: 'burn', status: 'failed', reason: err.message };
  }
}

// Marketing — the reserve. Runs last so it can pay out net of the real cost of
// every other leg (see marketing.computeMarketingSend). DRY_RUN has no real
// balances, so it pays the full share.
async function runMarketingLeg(cycleId, solClaimed, balanceBeforeSol) {
  try {
    const cap = share(solClaimed, config.marketingPct);
    const balanceAfterSol = await marketing.getWalletSolBalance();
    const solMarketing =
      balanceBeforeSol == null || balanceAfterSol == null
        ? cap
        : marketing.computeMarketingSend({ solClaimed, marketingPct: config.marketingPct, balanceBeforeSol, balanceAfterSol });
    const m = await marketing.sendMarketing(solMarketing);
    await repo.addStep({
      cycleId,
      name: 'marketing',
      status: m.status,
      signature: m.signature,
      detail: { leg: 'marketing', solShare: cap, solMarketing, solSent: m.solSent, recipient: m.recipient },
    });
    console.log(`[cycle ${cycleId}] [marketing] ${m.status} ${solMarketing} SOL (share ${cap}) → ${m.recipient}`);
    return { leg: 'marketing', status: m.status, solMarketing };
  } catch (err) {
    await recordLegFailure(cycleId, 'marketing', err);
    return { leg: 'marketing', status: 'failed', reason: err.message };
  }
}

/**
 * One Super Neko cycle (fired by the scheduler once unclaimed creator fees are
 * worth MIN_CLAIM_USD):
 *   claim $SN creator fees
 *   rewards: buy NVDAx (NVDAX_PCT) + $SI (SI_PCT), airdrop each pro-rata to $SN holders
 *   buyback & burn: buy $SN (BURN_PCT) and burn it
 *   marketing (MARKETING_PCT, the reserve): send net of gas/rent to MARKETING_WALLET
 * Legs are isolated: one failing marks the cycle 'partial', the rest still run.
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (m) => console.log(`[cycle ${id}] ${m}`);
  try {
    if (!config.tokenMint) throw new Error('TOKEN_MINT ($SN) is required');

    const balanceBeforeSol = await marketing.getWalletSolBalance();
    const claim = await pumpfun.claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { solClaimed: claim.solClaimed } });
    log(`claimed ${claim.solClaimed} SOL`);
    if (!(claim.solClaimed > 0)) {
      await repo.finishCycle(id, { status: 'skipped', sol_claimed: claim.solClaimed, note: 'nothing claimed' });
      return repo.getCycleWithSteps(id);
    }

    const solPriceUsd = await getFreshSolPriceUsd();
    let rewards;
    try {
      rewards = await runRewardsLeg(id, claim.solClaimed, solPriceUsd);
    } catch (err) {
      // Snapshot/setup failure — both reward tokens are lost for this cycle.
      await recordLegFailure(id, 'rewards', err);
      rewards = { results: [{ leg: 'rewards', status: 'failed', reason: err.message }], eligibleHolders: null, totalHolders: null };
    }
    const burnRes = await runBurnLeg(id, claim.solClaimed);
    const mkt = await runMarketingLeg(id, claim.solClaimed, balanceBeforeSol);

    const legs = [...rewards.results, burnRes, mkt];
    const anyFailed = legs.some((l) => l.status === 'failed');
    await repo.finishCycle(id, {
      status: anyFailed ? 'partial' : 'complete',
      mode: 'rewards',
      sol_claimed: claim.solClaimed,
      eligible_holders: rewards.eligibleHolders,
      total_holders: rewards.totalHolders,
      marketing_sol: mkt.solMarketing ?? 0,
      sn_burned: burnRes.tokensBurned ?? 0,
      legs,
      note: legs.map((l) => `${l.leg}=${l.status}`).join(' '),
    });
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle };
