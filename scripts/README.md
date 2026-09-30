# Live test runbook

Prove each integration in isolation, with **tiny amounts**, before letting the
10-minute loop run. Every mutating script previews by default and only sends a real
transaction when you add `--confirm`.

## 0. Prerequisites

In `.env` (NOT `.env.example` — keep secrets out of the committed template):

```
DRY_RUN=false
RPC_URL=<paid RPC, e.g. Helius/QuickNode>
WALLET_PRIVATE_KEY=<the TOKEN CREATOR wallet's key — base58 or JSON array>
TOKEN_MINT=<your pump.fun token mint>
DEV_WALLET=<wallet for the 2% cut>
MONGODB_URI=<atlas or local>
```

Fund the wallet with a **small** amount of SOL (e.g. 0.1) for the first tests.

> Rehearse first: keep `DRY_RUN=true` and run any script — it simulates, touches
> nothing. Flip to `DRY_RUN=false` only when you're ready to spend real SOL.

## 1. Preflight (no transactions)

```
node scripts/check.js
```
Confirms RPC works, wallet + balance, claimable creator fees, graduation state, and
your derived pool addresses. Fix anything flagged ⚠️ before continuing.

## 2. Claim creator fees

```
node scripts/claim.js                 # preview
node scripts/claim.js --confirm       # execute
```

## 3. Buy a tiny amount

```
node scripts/buy.js 0.001 --confirm
```
Auto-routes: bonding curve if pre-bond, AMM if graduated. **This is where you confirm
the slippage convention** — if it reverts or fills at a wild price, adjust `SLIPPAGE_PCT`.

## 4. Create / seed the pool (pre-bond only)

```
node scripts/create-pool.js 0.005 --confirm
```
Uses the tokens from step 3 + the given SOL. First run creates the pool; later runs
deposit. Leaves LP in the wallet (not yet locked).

## 5. Lock the LP  ⚠️ riskiest step

```
node scripts/lock.js --confirm
```
Locks the wallet's LP balance on Streamflow for `LOCK_YEARS`. **This is the make-or-break
Token-2022 test** — if it fails on escrow, Streamflow may not accept the PumpSwap LP mint
and we need a different locker (or to burn). On success, verify at app.streamflow.finance.

## 6. One full cycle end-to-end

```
node scripts/run-once.js --confirm
```
Runs claim → dev fee → buy → liquidity → lock as one cycle and records it to MongoDB.

## 7. Go live

Only after 1–6 pass: `npm start`. The scheduler runs the cycle every 10 minutes.
Watch `GET /api/status` and `GET /api/cycles`.

---

**Safety reminders**
- Start tiny. Confirm each step lands on a Solana explorer before the next.
- The pre-bond pool you create is intentionally abandoned at graduation; LP locked
  there is locked forever.
- Don't raise the loop's real balance until a full `run-once` has succeeded.
