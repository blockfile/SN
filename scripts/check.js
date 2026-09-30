'use strict';

// Read-only preflight. Sends NO transactions. Verifies your config + on-chain state.
//   node scripts/check.js
const { PublicKey } = require('@solana/web3.js');
const { NATIVE_MINT } = require('@solana/spl-token');
const { config, connection, wallet, hr, sol } = require('./_util');

(async () => {
  hr('CONFIG');
  console.log('dryRun     :', config.dryRun);
  console.log('rpcUrl     :', config.rpcUrl);
  console.log('wallet     :', wallet.publicKey.toBase58(), config.walletIsEphemeral ? '⚠️ EPHEMERAL — set WALLET_PRIVATE_KEY' : '');
  console.log('tokenMint  :', config.tokenMint || '⚠️ MISSING — set TOKEN_MINT');
  console.log('devFeePct  :', config.devFeePct, '→ devWallet:', config.devWallet || '⚠️ unset');
  console.log('lockYears  :', config.lockYears);

  hr('RPC + WALLET BALANCE');
  const lamports = await connection.getBalance(wallet.publicKey);
  console.log('SOL balance:', sol(lamports), 'SOL');
  if (lamports === 0) console.log('⚠️ wallet has 0 SOL — fund it before any live test');

  if (!config.tokenMint) {
    console.log('\nSet TOKEN_MINT to run the remaining checks.');
    process.exit(0);
  }
  const mint = new PublicKey(config.tokenMint);

  hr('CLAIMABLE CREATOR FEES');
  const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
  const psdk = new OnlinePumpSdk(connection);
  try {
    const claimable = await psdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
    console.log('claimable  :', sol(claimable.toString()), 'SOL');
    if (config.walletIsEphemeral) console.log('   (meaningless — this is a random wallet, not the creator)');
  } catch (e) {
    console.log('claimable check failed:', e.message);
  }

  hr('GRADUATION STATE');
  try {
    const { bondingCurve } = await psdk.fetchBuyState(mint, wallet.publicKey);
    console.log('bondingCurve.complete:', bondingCurve.complete, bondingCurve.complete ? '(GRADUATED)' : '(pre-bond)');
  } catch (e) {
    console.log('no bonding-curve account for this mint:', e.message);
  }
  const { canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');
  const canon = canonicalPumpPoolPda(mint);
  const canonInfo = await connection.getAccountInfo(canon);
  console.log('canonical pool:', canon.toBase58(), canonInfo ? 'EXISTS (graduated)' : 'not found (pre-bond)');

  hr('OUR PRE-BOND POOL');
  const { poolPda, lpMintPda } = require('@pump-fun/pump-swap-sdk');
  const ourPool = poolPda(0, wallet.publicKey, mint, NATIVE_MINT);
  const ourInfo = await connection.getAccountInfo(ourPool);
  console.log('our pool   :', ourPool.toBase58(), ourInfo ? 'EXISTS' : 'not created yet');
  console.log('our LP mint:', lpMintPda(ourPool).toBase58());

  console.log('\n✅ preflight complete (no transactions sent)');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ check failed:', e.message);
  process.exit(1);
});
