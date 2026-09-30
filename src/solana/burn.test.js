'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { burnBought } = require('./burn');

test('burnBought burns exactly the amount given (DRY_RUN)', async () => {
  const r = await burnBought('SNmint1111111111111111111111111111111111111', '12345');
  assert.strictEqual(r.burnedRaw, '12345');
  assert.strictEqual(r.simulated, true);
  assert.match(r.signature, /^burn_/);
});

test('burnBought with nothing bought sends nothing', async () => {
  const r = await burnBought('SNmint1111111111111111111111111111111111111', '0');
  assert.strictEqual(r.signature, null);
  assert.strictEqual(r.burnedRaw, '0');
});

// Live path with the chain stubbed out: the burn must never reach into what the
// wallet held before this cycle's buy.
async function withLiveBurn(balanceRaw, fn) {
  const config = require('../config');
  const tokens = require('./tokens');
  const real = { getMintInfo: tokens.getMintInfo, readTokenBalance: tokens.readTokenBalance, sendIxs: tokens.sendIxs };
  const sent = [];
  config.dryRun = false;
  tokens.getMintInfo = async () => ({ decimals: 6, programId: tokens.TOKEN_PROGRAM_ID });
  tokens.readTokenBalance = async () => balanceRaw;
  tokens.sendIxs = async (_conn, _wallet, ixs) => {
    sent.push(ixs);
    return 'burnsig';
  };
  try {
    await fn(sent);
  } finally {
    config.dryRun = true;
    Object.assign(tokens, real);
  }
}

test('burnBought (live) refuses a burn that would dip into the pre-existing balance', async () => {
  await withLiveBurn(1000n, async (sent) => {
    // 1000 held now, 500 held before the buy → only 500 is ours to burn.
    await assert.rejects(
      burnBought('SNmint1111111111111111111111111111111111111', '600', { keepAtLeastRaw: 500n }),
      /burn would dip into pre-existing balance/
    );
    assert.strictEqual(sent.length, 0, 'nothing sent');
  });
});

test('burnBought (live) burns exactly what was bought when the pre-existing balance is intact', async () => {
  await withLiveBurn(1000n, async (sent) => {
    const r = await burnBought('SNmint1111111111111111111111111111111111111', '500', { keepAtLeastRaw: 500n });
    assert.deepStrictEqual(r, { signature: 'burnsig', burnedRaw: '500', simulated: false });
    assert.strictEqual(sent.length, 1);
  });
});
