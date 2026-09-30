# Live test runbook

Prove each integration in isolation, with **tiny amounts**, before letting the
scheduler run. Every mutating script previews by default and only sends a real
transaction when you add `--confirm`.

## 0. Prerequisites

In `.env` (NOT `.env.example` — keep secrets out of the committed template):

```
DRY_RUN=false
RPC_URL=<paid RPC, e.g. Helius/QuickNode>
WALLET_PRIVATE_KEY=<the $SN CREATOR (dev) wallet's key — base58 or JSON array>
TOKEN_MINT=<the $SN mint>
MARKETING_WALLET=<optional; blank keeps the marketing share in the dev wallet>
MONGODB_URI=<atlas or local>
```

Fund the wallet with a **small** amount of SOL for the first tests. First cycles pay
~0.0016 SOL rent per new NVDAx/$SI recipient, deducted from the marketing share.

> Rehearse first: keep `DRY_RUN=true` and run any script — it simulates, touches
> nothing. Flip to `DRY_RUN=false` only when you're ready to spend real SOL.

## 1. Preflight (no transactions)

```
node scripts/check.js
```
Confirms RPC, wallet + balance, claimable creator fees, graduation state, split and
reward mints. Fix anything flagged ⚠️ before continuing.

## 2. Claim creator fees

```
node scripts/claim.js                 # preview
node scripts/claim.js --confirm       # execute
```

## 3. Buy a tiny amount of $SN

```
node scripts/buy.js 0.001 --confirm
```
Auto-routes: bonding curve if pre-bond, AMM if graduated.

## 4. One full cycle end-to-end

```
node scripts/run-once.js --confirm
```
Runs claim → NVDAx + $SI buy/airdrop → $SN buyback & burn → marketing as one cycle
and records it to MongoDB. Check every signature on Solscan.

Stop the server first (`pm2 stop superneko`). `run-once.js` runs in its own process
and does not share the server's in-memory cycle lock, so a scheduler tick could fire
a second cycle at the same time.

## 5. Go live

Only after 1–4 pass: `npm start`. The scheduler checks every minute and fires a cycle
once unclaimed fees are worth `MIN_CLAIM_USD` ($100). Watch `GET /api/status` and
`GET /api/cycles`.

---

**Safety reminders**
- Start tiny. Confirm each step lands on a Solana explorer before the next.
- NVDAx is a tokenized security (issuer can pause/freeze/claw back; restricted for US
  persons). `NVDAX_PCT=0` disables that leg.
