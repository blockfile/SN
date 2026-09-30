'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { connection, wallet } = require('../solana/connection');
const pumpfun = require('../solana/pumpfun');
const airdrop = require('../solana/airdrop');
const mintguard = require('../solana/mintguard');
const { getMintInfo, readTokenBalance } = require('../solana/tokens');
const { computeWeightedAllocations, minRawForUsd } = require('../services/distribution');
const { getFreshSolPriceUsd } = require('../solana/price');
const { snapshotRewardHolders, rewardTokens, requireBought } = require('./cycle');

/**
 * One-off reward airdrop outside a cycle — for rewards a cycle couldn't deliver
 * (tokens left in the wallet, or SOL left over from a failed buy). Same holder
 * snapshot, exclusions, cap, dust floor and airdrop as a cycle, recorded as its
 * own cycle (mode 'redistribute') so /summary and /airdrops include it.
 *
 *   token      'nvdax' | 'si'
 *   amountRaw  airdrop this many raw units already in the wallet, worth `valueSol`
 *              SOL (what they cost — prices the dust floor)
 *   buySol     or: buy the token with this much SOL first, then airdrop what arrived
 *   preview    plan only (amountRaw mode): nothing is sent or recorded
 */
async function redistribute({ token, amountRaw, valueSol, buySol, preview = false }) {
  const reward = rewardTokens().find((r) => r.leg === token);
  if (!reward || !reward.mint) throw new Error('token must be nvdax or si');
  const buying = buySol > 0;
  if (!buying && !(amountRaw && valueSol > 0)) throw new Error('give amountRaw + valueSol, or buySol');

  const guard = await mintguard.checkRewardMint(reward.mint);
  if (!guard.ok) throw new Error(`${token} guard: ${guard.reason}`);
  // Without a price there is no dust floor — fail closed, as the cycle does.
  const solPriceUsd = await getFreshSolPriceUsd();
  if (solPriceUsd == null) throw new Error('no fresh SOL price — try again shortly');

  const { holders, totalHolders, capPct, supplyRaw } = await snapshotRewardHolders();
  const plan = (raw, solValue) => {
    const minAmountRaw = minRawForUsd({ minUsd: config.minAirdropUsd, solSpent: solValue, solPriceUsd, tokensBoughtRaw: raw });
    return computeWeightedAllocations(holders, raw.toString(), { capPct, supplyRaw, clusters: config.clusters, minAmountRaw });
  };

  if (preview) {
    if (buying) return { mint: reward.mint, eligibleHolders: holders.length, totalHolders, allocations: null };
    return { mint: reward.mint, eligibleHolders: holders.length, totalHolders, allocations: plan(BigInt(amountRaw), valueSol) };
  }

  if (!buying && !config.dryRun) {
    // Only ever send what the wallet actually holds.
    const { programId } = await getMintInfo(connection, reward.mint);
    const balance = await readTokenBalance(connection, reward.mint, wallet.publicKey, programId);
    if (balance < BigInt(amountRaw)) throw new Error(`wallet holds ${balance} raw ${token}, less than ${amountRaw}`);
  }

  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (m) => console.log(`[redistribute ${id}] ${m}`);
  try {
    let raw = BigInt(amountRaw || 0);
    let solValue = valueSol;
    if (buying) {
      const buy = await pumpfun.buyToken(reward.mint, buySol);
      raw = requireBought(buy);
      solValue = buySol;
      await repo.addStep({
        cycleId: id,
        name: 'buy',
        status: 'ok',
        signature: buy.signature,
        detail: { leg: token, buyMint: reward.mint, solSpent: buySol, tokensBought: buy.tokensBought },
      });
      log(`bought ${buy.tokensBought} ${token} with ${buySol} SOL`);
    }

    const allocations = plan(raw, solValue);
    const res = await airdrop.airdropToken({ rewardMint: reward.mint, allocations, cycleId: id });
    await repo.addStep({
      cycleId: id,
      name: 'airdrop',
      status: res.failed ? 'failed' : 'ok',
      detail: { leg: token, rewardMint: reward.mint, recipients: allocations.length, sent: res.sent, failed: res.failed },
    });
    log(`${token}: ${allocations.length} recipients, sent=${res.sent} failed=${res.failed}`);

    await repo.finishCycle(id, {
      status: res.failed ? 'partial' : allocations.length ? 'complete' : 'skipped',
      mode: 'redistribute',
      eligible_holders: holders.length,
      total_holders: totalHolders,
      note: allocations.length ? `${token} sent=${res.sent} failed=${res.failed}` : `${token}: every share below MIN_AIRDROP_USD`,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { leg: token, message } });
    await repo.finishCycle(id, { status: 'failed', mode: 'redistribute', error: message });
    log(`FAILED: ${message}`);
  }
  return repo.getCycleWithSteps(id);
}

module.exports = { redistribute };
