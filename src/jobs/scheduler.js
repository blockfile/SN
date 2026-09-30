'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getClaimableSol, simulateFeeAccrual } = require('../solana/pumpfun');
const bus = require('../events');
const { getFreshSolPriceUsd } = require('../solana/price');

const state = {
  task: null,
  paused: false,
  isRunning: false,
  lastRunAt: null,
  lastResult: null, // { id, status }
  lastClaimable: null,
  lastClaimableUsd: null,
  startedAt: null,
};

/**
 * One timer tick (every POLL_SCHEDULE, default every minute). Advances the simulated
 * vault (DRY_RUN only), reads the claimable creator-fee balance, and runs a cycle
 * only once that balance is worth MIN_CLAIM_USD at the current SOL price — below
 * the threshold, or with no fresh price, the tick skips silently (no cycle row)
 * and fees keep accruing. Overlap-guarded.
 * @param {string} trigger 'poll' | 'manual'
 * @returns {Promise<{ran:boolean, claimable?:number, claimableUsd?:number, reason?:string, cycle?:object}>}
 */
async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }
  // Take the lock before the first await: otherwise a triggerNow() (or another
  // tick) landing while we read the vault/price starts a second, concurrent cycle.
  state.isRunning = true;
  try {
    simulateFeeAccrual(); // no-op in live mode
    const claimable = await getClaimableSol();
    state.lastClaimable = claimable;
    // Push the fresh balance to SSE clients so the frontend's threshold progress
    // bar tracks accrual live instead of polling /countdown.
    bus.emit('unclaimed', claimable);
    if (!(claimable > 0)) {
      state.lastClaimableUsd = 0;
      return { ran: false, claimable, reason: 'nothing claimable' };
    }
    // The trigger is a USD amount. Without a fresh SOL price we can't know whether
    // it's reached, so skip this tick rather than fire blind.
    const price = await getFreshSolPriceUsd();
    if (price == null) {
      state.lastClaimableUsd = null;
      console.log('[scheduler] no fresh SOL price — skipping tick');
      return { ran: false, claimable, reason: 'no price' };
    }
    const claimableUsd = +(claimable * price).toFixed(2);
    state.lastClaimableUsd = claimableUsd;
    if (claimable * price < config.minClaimUsd) {
      return { ran: false, claimable, claimableUsd, reason: 'below threshold' };
    }

    state.lastRunAt = new Date().toISOString();
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable, claimableUsd, cycle };
  } finally {
    state.isRunning = false;
  }
}

function start() {
  if (state.task) return;
  if (!cron.validate(config.pollSchedule)) {
    throw new Error(`Invalid POLL_SCHEDULE: ${config.pollSchedule}`);
  }
  state.startedAt = new Date().toISOString();
  state.task = cron.schedule(config.pollSchedule, () => {
    pollOnce('poll').catch((err) => console.error('[scheduler] poll error:', err));
  });
  console.log(
    `[scheduler] started — checks "${config.pollSchedule}", claims at >= $${config.minClaimUsd} of fees (dryRun=${config.dryRun})`
  );
}

function pause() {
  state.paused = true;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

function resume() {
  state.paused = false;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

/**
 * Manual trigger from the API — forces a cycle immediately, ignoring both the
 * schedule and the MIN_CLAIM_USD threshold (operator override for flushing a
 * small balance).
 */
async function triggerNow() {
  if (state.isRunning) return { skipped: true, reason: 'cycle already running' };
  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return cycle;
  } finally {
    state.isRunning = false;
  }
}

function getState() {
  return {
    pollSchedule: config.pollSchedule,
    minClaimUsd: config.minClaimUsd,
    paused: state.paused,
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastClaimable: state.lastClaimable,
    lastClaimableUsd: state.lastClaimableUsd,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState };
