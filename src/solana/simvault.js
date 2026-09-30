'use strict';

// In-memory simulated creator-fee vault, used ONLY in DRY_RUN so the threshold
// trigger (fire at >= MIN_CLAIM_USD) can be exercised and tested without real fees.
// Live mode never touches this — real fees accrue on-chain.
let balanceSol = 0;

// Add `rate` SOL to the simulated vault; returns the new balance.
function accrue(rate) {
  balanceSol += Number(rate) || 0;
  return balanceSol;
}

// Current simulated balance, WITHOUT mutating it.
function peek() {
  return balanceSol;
}

// Claim the whole vault: return the balance and reset to 0.
function drain() {
  const sol = balanceSol;
  balanceSol = 0;
  return sol;
}

// Test helper — force the balance to a known value.
function reset(sol = 0) {
  balanceSol = Number(sol) || 0;
  return balanceSol;
}

module.exports = { accrue, peek, drain, reset };
