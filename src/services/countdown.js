'use strict';

// Interval minutes from a cron schedule's minute field: "*/N" → N, bare "*" → 1
// (every minute). Anything else falls back to 5 — we only support fixed-interval
// schedules here.
function intervalMinutes(schedule) {
  const minuteField = String(schedule || '').trim().split(/\s+/)[0] || '*';
  if (minuteField === '*') return 1;
  const m = /^\*\/(\d+)$/.exec(minuteField);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0) return n;
  }
  return 5;
}

// Next cron fire time (epoch ms) strictly after nowMs for a "*/N * * * *" schedule:
// the next local-time minute boundary where minute % N === 0 and seconds are 0.
function nextRun(schedule, nowMs) {
  const intervalMin = intervalMinutes(schedule);
  const d = new Date(nowMs);
  d.setSeconds(0, 0);
  do {
    d.setMinutes(d.getMinutes() + 1);
  } while (d.getMinutes() % intervalMin !== 0);
  return { nextAirdropAt: d.getTime(), intervalSec: intervalMin * 60 };
}

// Progress toward the claim threshold, 0-100 (clamped). Null when the unclaimed
// balance isn't known yet (no poll has landed) or the threshold is disabled.
function thresholdProgress(unclaimedSol, thresholdSol) {
  if (unclaimedSol == null || !Number.isFinite(unclaimedSol)) return null;
  if (!Number.isFinite(thresholdSol) || thresholdSol <= 0) return 100;
  const pct = (unclaimedSol / thresholdSol) * 100;
  return +Math.min(100, Math.max(0, pct)).toFixed(1);
}

module.exports = { nextRun, intervalMinutes, thresholdProgress };
