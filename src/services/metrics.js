'use strict';

// Shared, cached read of the live unclaimed creator-fee balance so /api/unclaimed
// and /api/status don't each hit the RPC on every request.
const { getClaimableSol } = require('../solana/pumpfun');

let cache = { value: null, at: 0 };
const TTL_MS = 20_000;

async function getUnclaimedSol() {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) {
    return { sol: cache.value, at: cache.at, fresh: false };
  }
  const sol = await getClaimableSol();
  cache = { value: sol, at: now };
  return { sol, at: now, fresh: true };
}

module.exports = { getUnclaimedSol };
