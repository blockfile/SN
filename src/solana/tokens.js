'use strict';

const {
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  PublicKey,
} = require('@solana/web3.js');
// bs58 v6 is ESM-only; under CommonJS require() the API is on `.default`.
const bs58lib = require('bs58');
const bs58 = bs58lib.default || bs58lib;
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} = require('@solana/spl-token');
const config = require('../config');

/**
 * Read an SPL (or Token-2022) token balance for owner. Returns 0n if the ATA
 * doesn't exist yet. `programId` selects classic SPL vs Token-2022.
 * Any other error (rate limit, fetch failure) is rethrown: buys measure what
 * they bought as after − before, so a failed pre-buy read taken as 0 would
 * count the wallet's whole existing balance as bought (and burn it).
 */
async function readTokenBalance(connection, mint, owner, programId = TOKEN_PROGRAM_ID) {
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(mint),
    owner,
    true,
    programId
  );
  try {
    const acct = await getAccount(connection, ata, 'confirmed', programId);
    return acct.amount; // bigint, base units
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) return 0n;
    throw err;
  }
}

/**
 * Read a token balance, retrying until it rises above `above` (the pre-buy
 * balance). Works around RPC read-after-write lag: getAccount immediately after
 * sendAndConfirmTransaction can still 404 a freshly-created ATA, which would
 * otherwise read as 0 and make a real buy look like it bought nothing. Falls
 * through after the retries so a genuine no-op buy still resolves (to ~`above`).
 */
async function readTokenBalanceSettled(
  connection,
  mint,
  owner,
  programId = TOKEN_PROGRAM_ID,
  above = -1n,
  { tries = 10, delayMs = 800 } = {}
) {
  let bal = await readTokenBalance(connection, mint, owner, programId);
  for (let i = 0; i < tries && bal <= above; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    bal = await readTokenBalance(connection, mint, owner, programId);
  }
  return bal;
}

/** Fetch a mint's decimals + owning token program. */
async function getMintInfo(connection, mint) {
  const mintPk = new PublicKey(mint);
  const accInfo = await connection.getAccountInfo(mintPk);
  if (!accInfo) throw new Error(`mint ${mint} not found`);
  const programId = accInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const info = await getMint(connection, mintPk, 'confirmed', programId);
  return { decimals: info.decimals, programId };
}

/** Total supply of `mint` in base units. DRY_RUN returns a simulated 1B @ 6 decimals. */
async function getTokenSupplyRaw(connection, mint) {
  if (config.dryRun) return 1_000_000_000n * 10n ** 6n;
  const res = await connection.getTokenSupply(new PublicKey(mint));
  return BigInt(res.value.amount);
}

/**
 * Prepend compute-budget (priority fee) instructions and send + confirm.
 * The tx is signed before it is sent so its signature is known up front: a
 * confirm can throw (blockhash expiry, dropped websocket, HTTP timeout) even
 * though the tx landed. Any error after signing carries `err.signature` and
 * `err.lastValidBlockHeight`, so a caller can check before it retries.
 */
async function sendIxs(connection, wallet, ixs, { label } = {}) {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: config.priorityFeeMicroLamports,
    })
  );
  for (const ix of ixs) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);
  const signature = bs58.encode(tx.signature);
  try {
    await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.signature = signature;
    e.lastValidBlockHeight = lastValidBlockHeight;
    throw e;
  }
  if (label) console.log(`[tx] ${label}: ${signature}`);
  return signature;
}

/**
 * If the wallet holds a WSOL ATA (e.g. from the AMM-side fee payout), close it
 * to unwrap into native SOL. No-op if there's no WSOL account.
 */
async function unwrapWsol(connection, wallet) {
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, true, TOKEN_PROGRAM_ID);
  try {
    await getAccount(connection, wsolAta, 'confirmed', TOKEN_PROGRAM_ID);
  } catch (_err) {
    return null; // no WSOL account to unwrap
  }
  const ix = createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey);
  return sendIxs(connection, wallet, [ix], { label: 'unwrap WSOL' });
}

/** Transfer native SOL (lamports) from the wallet to a recipient. */
async function transferSol(connection, wallet, toPubkey, lamports) {
  const ix = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey,
    lamports: Math.floor(lamports),
  });
  return sendIxs(connection, wallet, [ix], { label: 'transfer SOL' });
}

module.exports = {
  readTokenBalance,
  readTokenBalanceSettled,
  getMintInfo,
  getTokenSupplyRaw,
  sendIxs,
  unwrapWsol,
  transferSol,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
};
