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

// Progress toward the claim threshold, 0-100 (clamped). Unit-agnostic (the
// trigger passes USD). Null when the value isn't known yet (no poll landed / no
// price); 100 when the threshold is disabled.
function thresholdProgress(value, threshold) {
  if (value == null || !Number.isFinite(value)) return null;
  if (!Number.isFinite(threshold) || threshold <= 0) return 100;
  const pct = (value / threshold) * 100;
  return +Math.min(100, Math.max(0, pct)).toFixed(1);
}

module.exports = { nextRun, intervalMinutes, thresholdProgress };
