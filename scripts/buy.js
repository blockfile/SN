'use strict';

// Buy a tiny amount (auto: bonding curve if pre-bond, AMM if graduated).
//   node scripts/buy.js [SOL] [--confirm]      e.g. node scripts/buy.js 0.001 --confirm
const { requireConfirm, hr, arg } = require('./_util');
const { isGraduated, buyOnCurve } = require('../src/solana/pumpfun');
const { buyOnAmm, resolveCanonicalPool } = require('../src/solana/pumpswap');

(async () => {
  const amount = parseFloat(arg(0)) || 0.001;
  hr(`BUY ~${amount} SOL`);
  const grad = await isGraduated();
  console.log('graduated:', grad);
  const via = grad.graduated ? 'AMM (canonical)' : 'bonding curve';
  if (!(await requireConfirm(`buy with ${amount} SOL via ${via}`))) process.exit(0);

  const r = grad.graduated
    ? await buyOnAmm(amount, resolveCanonicalPool())
    : await buyOnCurve(amount);
  console.log('result:', r);
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
