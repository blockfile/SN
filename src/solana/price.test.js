'use strict';
const test = require('node:test');
const assert = require('node:assert');

function freshPrice(env) {
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./price')];
  return require('./price');
}

test('isFresh: recent is fresh; stale or never-fetched is not', () => {
  const { isFresh, MAX_AGE_MS } = freshPrice({ DRY_RUN: 'true' });
  const now = 1_000_000_000;
  assert.strictEqual(isFresh(now - 1000, now), true);
  assert.strictEqual(isFresh(now - MAX_AGE_MS - 1, now), false);
  assert.strictEqual(isFresh(0, now), false);
});

test('DRY_RUN serves the fixed simulated price; 0 means no price', async () => {
  try {
    let price = freshPrice({ DRY_RUN: 'true', DRY_RUN_SOL_PRICE_USD: '200' });
    assert.strictEqual(await price.getSolPriceUsd(), 200);
    assert.strictEqual(await price.getFreshSolPriceUsd(), 200);

    price = freshPrice({ DRY_RUN: 'true', DRY_RUN_SOL_PRICE_USD: '0' });
    assert.strictEqual(await price.getFreshSolPriceUsd(), null);
  } finally {
    delete process.env.DRY_RUN_SOL_PRICE_USD;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('./price')];
  }
});
