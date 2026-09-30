'use strict';

// Create our pre-bond pool (or deposit if it already exists) using the tokens the
// wallet holds + a tiny SOL amount on the quote side. Run buy.js first to get tokens.
//   node scripts/create-pool.js [QUOTE_SOL] [--confirm]   e.g. node scripts/create-pool.js 0.005 --confirm
const { requireConfirm, hr, arg } = require('./_util');
const { createOurPool, depositToPool, resolveOurPool, poolExists } = require('../src/solana/pumpswap');

(async () => {
  const quoteSol = parseFloat(arg(0)) || 0.005;
  hr(`CREATE / DEPOSIT OUR POOL (quote ${quoteSol} SOL)`);
  const ourPool = resolveOurPool();
  const exists = await poolExists(ourPool);
  console.log('our pool exists:', exists, '→', exists ? 'will DEPOSIT' : 'will CREATE');

  if (!(await requireConfirm(exists ? 'deposit into our pool' : 'create our pool + seed initial liquidity')))
    process.exit(0);

  const r = exists
    ? await depositToPool(ourPool, 0, quoteSol)
    : await createOurPool(0, quoteSol);
  console.log('result:', r);
  console.log('\nNote: LP is now in the wallet but NOT yet locked — run scripts/lock.js next.');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
