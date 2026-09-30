'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getClaimableSol, simulateFeeAccrual } = require('../solana/pumpfun');
const bus = require('../events');

const state = {
  task: null,
  paused: false,
  isRunning: false,
  lastRunAt: null,
  lastResult: null, // { id, status }
  lastClaimable: null,
  startedAt: null,
};

/**
 * One timer tick (every POLL_SCHEDULE, default every minute). Advances the simulated
 * vault (DRY_RUN only), reads the claimable creator-fee balance, and runs a cycle
 * only once that balance has reached MIN_CLAIM_SOL — below the threshold the tick
 * skips silently (no cycle row) and fees keep accruing. Overlap-guarded.
 * @param {string} trigger 'poll' | 'manual'
 * @returns {Promise<{ran:boolean, claimable?:number, reason?:string, cycle?:object}>}
 */
async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  simulateFeeAccrual(); // no-op in live mode
  const claimable = await getClaimableSol();
  state.lastClaimable = claimable;
  // Push the fresh balance to SSE clients so the frontend's threshold progress
  // bar tracks accrual live instead of polling /countdown.
  bus.emit('unclaimed', claimable);
  if (!(claimable > 0)) {
    return { ran: false, claimable, reason: 'nothing claimable' };
  }
  if (claimable < config.minClaimSol) {
    return { ran: false, claimable, reason: 'below threshold' };
  }

  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable, cycle };
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
    `[scheduler] started — checks "${config.pollSchedule}", claims at >= ${config.minClaimSol} SOL (dryRun=${config.dryRun})`
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
 * schedule and the MIN_CLAIM_SOL threshold (operator override for flushing a
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
    minClaimSol: config.minClaimSol,
    paused: state.paused,
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastClaimable: state.lastClaimable,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState };
