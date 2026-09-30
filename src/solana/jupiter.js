'use strict';

const { PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
const { readTokenBalance, readTokenBalanceSettled, getMintInfo } = require('./tokens');

// Wrapped SOL — Jupiter's input mint for a SOL spend (wrapAndUnwrapSol handles it).
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function jupHeaders() {
  // Free lite-api needs no key; the paid api.jup.ag uses x-api-key.
  return config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {};
}

/**
 * Buy `mint` with `solAmount` SOL through the Jupiter aggregator (routes across
 * every Solana DEX). Used for reward tokens with no pump.fun bonding curve or
 * canonical PumpSwap pool — e.g. $PUMP. Like the other buys, the caller
 * distributes ONLY what landed this call (the measured balance delta).
 * @returns {Promise<{signature, tokensBought, tokensBoughtRaw, baseDecimals, simulated, note?}>}
 */
async function buyViaJupiter(mint, solAmount) {
  if (config.dryRun) {
    const baseDecimals = 6;
    const tokensBought = +(solAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('jupbuy'),
      tokensBought,
      tokensBoughtRaw: String(Math.floor(tokensBought * 10 ** baseDecimals)),
      baseDecimals,
      simulated: true,
    };
  }

  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  if (!(lamports > 0)) {
    return { signature: null, tokensBought: 0, tokensBoughtRaw: '0', baseDecimals: 6, simulated: false, note: 'zero amount' };
  }
  const base = config.jupiterApi.replace(/\/+$/, '');
  const slippageBps = Math.round(config.slippagePct * 100);
  const mintPk = new PublicKey(mint);

  // 1) Quote: SOL -> mint.
  const quoteUrl = `${base}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${slippageBps}`;
  const qRes = await fetch(quoteUrl, { headers: jupHeaders(), signal: AbortSignal.timeout(20000) });
  if (!qRes.ok) throw new Error(`Jupiter quote HTTP ${qRes.status}`);
  const quote = await qRes.json();
  if (!quote || quote.error || !quote.outAmount) {
    throw new Error(`Jupiter quote failed: ${quote && quote.error ? quote.error : 'no route'}`);
  }

  // 2) Build the swap transaction for our wallet.
  const sRes = await fetch(`${base}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...jupHeaders() },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: config.jupiterPriorityFeeLamports,
    }),
  });
  if (!sRes.ok) throw new Error(`Jupiter swap HTTP ${sRes.status}`);
  const swap = await sRes.json();
  if (!swap || !swap.swapTransaction) throw new Error('Jupiter swap: no transaction returned');

  // 3) Sign + send the versioned tx; measure the balance delta so the caller
  //    distributes only what actually arrived (never the wallet's full bag).
  const { decimals: baseDecimals, programId } = await getMintInfo(connection, mintPk);
  const balBefore = await readTokenBalance(connection, mintPk, wallet.publicKey, programId);

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([wallet]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(
    { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight },
    'confirmed'
  );

  const balAfter = await readTokenBalanceSettled(connection, mintPk, wallet.publicKey, programId, balBefore);
  const boughtRaw = balAfter - balBefore;
  return {
    signature,
    tokensBought: Number(boughtRaw) / 10 ** baseDecimals,
    tokensBoughtRaw: boughtRaw.toString(),
    baseDecimals,
    simulated: false,
  };
}

module.exports = { buyViaJupiter, SOL_MINT };
