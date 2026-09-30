'use strict';

// SOL→USD price, cached so the dashboard can poll freely without hammering the source.
let cache = { value: null, at: 0 };
const TTL_MS = 60_000;

async function getSolPriceUsd() {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) return cache.value;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );
    const j = await res.json();
    const px = j && j.solana && j.solana.usd;
    if (typeof px === 'number' && px > 0) {
      cache = { value: px, at: now };
      return px;
    }
  } catch (_err) {
    // fall through to stale/null
  }
  return cache.value; // last known price, or null if never fetched
}

/** Last fetched price without triggering a fetch (null until first fetch). */
function getCachedSolPriceUsd() {
  return cache.value;
}

/** Convert a SOL amount to USD (rounded to cents), or null if no price. */
function toUsd(sol, price) {
  if (sol == null || price == null) return null;
  return +(sol * price).toFixed(2);
}

module.exports = { getSolPriceUsd, getCachedSolPriceUsd, toUsd };
