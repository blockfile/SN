'use strict';

// Lock the wallet's entire LP balance on Streamflow for LOCK_YEARS.
// THE riskiest step (Token-2022 LP ↔ Streamflow). Test with a small LP balance first.
//   node scripts/lock.js [LP_MINT] [--confirm]
// If LP_MINT is omitted, uses our pre-bond pool's LP mint.
const { config, requireConfirm, hr, arg } = require('./_util');
const { lockLp } = require('../src/solana/streamflow');
const { resolveOurPool } = require('../src/solana/pumpswap');

(async () => {
  hr('LOCK LP ON STREAMFLOW');
  let lpMint = arg(0);
  if (!lpMint) {
    if (config.dryRun) {
      lpMint = 'simOurLpMint';
    } else {
      const { lpMintPda } = require('@pump-fun/pump-swap-sdk');
      lpMint = lpMintPda(resolveOurPool()).toBase58();
    }
  }
  console.log('lp mint   :', lpMint);
  console.log('lock years:', config.lockYears);

  if (!(await requireConfirm(`lock entire LP balance of ${lpMint} for ${config.lockYears} years`)))
    process.exit(0);

  const r = await lockLp(lpMint, null, null, config.lockYears);
  console.log('result:', r);
  console.log('\nIf this succeeded on mainnet, check it at app.streamflow.finance (lockId above).');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  console.error('If this is a Token-2022 escrow error, Streamflow may not accept this LP mint — see notes.');
  process.exit(1);
});
