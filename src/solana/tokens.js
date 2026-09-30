'use strict';

const {
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SystemProgram,
  PublicKey,
} = require('@solana/web3.js');
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
} = require('@solana/spl-token');
const config = require('../config');

/**
 * Read an SPL (or Token-2022) token balance for owner. Returns 0n if the ATA
 * doesn't exist yet. `programId` selects classic SPL vs Token-2022.
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
  } catch (_err) {
    return 0n; // account not found => zero balance
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

/** Prepend compute-budget (priority fee) instructions and send + confirm. */
async function sendIxs(connection, wallet, ixs, { label } = {}) {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: config.priorityFeeMicroLamports,
    })
  );
  for (const ix of ixs) tx.add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
  });
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
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
};
