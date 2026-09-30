'use strict';

// Claim creator fees.   node scripts/claim.js [--confirm]
const { requireConfirm, hr } = require('./_util');
const { claimCreatorFees } = require('../src/solana/pumpfun');

(async () => {
  hr('CLAIM CREATOR FEES');
  if (!(await requireConfirm('claim creator fees → wallet'))) process.exit(0);
  const r = await claimCreatorFees();
  console.log('result:', r);
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
