'use strict';

const config = require('../config');

// SOL→USD price, cached so the dashboard can poll freely without hammering the source.
let cache = { value: null, at: 0 };
const TTL_MS = 60_000;
// A cached price older than this is too stale to move money on (cycle trigger,
// dust threshold). Display paths still show it.
const MAX_AGE_MS = 10 * 60_000;

async function getSolPriceUsd() {
  const now = Date.now();
  if (config.dryRun) {
    // Fixed simulated price — dry runs and tests never touch the network.
    const px = config.dryRunSolPriceUsd > 0 ? config.dryRunSolPriceUsd : null;
    cache = { value: px, at: px == null ? 0 : now };
    return px;
  }
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

/** True when a price fetched at `at` (epoch ms) is recent enough to act on. */
function isFresh(at, now = Date.now()) {
  return at > 0 && now - at <= MAX_AGE_MS;
}

/** Like getSolPriceUsd, but null when only a stale cached value is available. */
async function getFreshSolPriceUsd() {
  const px = await getSolPriceUsd();
  return px != null && isFresh(cache.at) ? px : null;
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

module.exports = { getSolPriceUsd, getFreshSolPriceUsd, getCachedSolPriceUsd, toUsd, isFresh, MAX_AGE_MS };
