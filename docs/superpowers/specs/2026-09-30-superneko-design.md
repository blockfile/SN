# Super Neko ($SN) reward engine — design

**Date:** 2026-09-30
**Status:** Draft — awaiting review
**Repo:** github.com/blockfile/SN (seeded from the BABYCUPSY engine, commit 87fda5c)
**Site:** https://superneko.meme

## Goal

Reuse the proven claim → buy → airdrop engine for Super Neko. $SN creator fees
from pump.fun fund each cycle. Each cycle splits the claimed SOL four ways:

| Share | Default | Action |
|---|---|---|
| Marketing | 50% | SOL transfer to `MARKETING_WALLET` |
| Buyback & burn | 10% | buy $SN, burn it (SPL `burnChecked`) |
| NvidiaX rewards | 20% | buy NVDAx, airdrop pro-rata to $SN holders |
| $SI rewards | 20% | buy $SI, airdrop pro-rata to $SN holders |

The shares total 100%. **Marketing is the reserve**: transaction fees and
new-recipient rent (about 0.002 SOL per new Token-2022 account, times two reward
tokens) are paid out of the marketing share before it is sent.

## Tokens (verified on-chain 2026-09-30)

| | Mint | Program | Decimals | Notes |
|---|---|---|---|---|
| $SN (holder) | `TOKEN_MINT` — blank until pump.fun launch | detected at runtime | detected | |
| NvidiaX = NVIDIA xStock (NVDAx) | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | Token-2022 | 8 | Backed Finance tokenized equity. Extensions: scaledUiAmount, pausable, permanentDelegate, transferHook (unset), defaultAccountState, freeze authority |
| $SI (Super Inu) | `DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP` | Token-2022 | 6 | **1% transfer fee** (authority is a single wallet that can raise it); no mint/freeze authority |

Both reward tokens route through Jupiter from SOL with low price impact at our
sizes (0.1 SOL quote: NVDAx 0.01%, SI 0.02%). Neither has a pump.fun curve or
canonical PumpSwap pool, so `resolveBuyRoute` already falls through to Jupiter.
Mints are hard-coded defaults in config — never looked up by name (many fake
"NVIDIA xStock" copies exist).

**Compliance note (operator-acknowledged risk):** NVDAx is a securities
product whose terms bar delivery to US persons and restrict it to professional
/qualified investors. The issuer can freeze or claw back tokens in any
account. Airdropping it to anonymous holders carries legal risk for the
operator. `NVDAX_PCT=0` disables the leg without code changes.

## Trigger — $100 of unclaimed fees

- The scheduler polls every minute (`POLL_SCHEDULE=* * * * *`).
- Each tick: read unclaimed SOL → get SOL/USD → fire a cycle when
  `unclaimedSol × price ≥ MIN_CLAIM_USD` (default **100**).
- The price comes from the existing CoinGecko cache (`price.js`), with a new
  staleness limit: a price older than 10 min counts as missing. **No price →
  skip the tick** (logged reason `no price`), never fire blind.
- DRY_RUN uses a fixed `DRY_RUN_SOL_PRICE_USD` (default 150), so tests never
  touch the network.
- `POST /api/run` still ignores the threshold.
- `MIN_CLAIM_SOL` is removed; `/countdown` and `/accumulator` report
  `unclaimedUsd`, `thresholdUsd`, and `progressPct` (plus `unclaimedSol` for
  reference).

## Cycle

Order matters: marketing runs **last**, so the real cost of the other steps
is known before paying it. Gas and ATA rent come out of the marketing share.

1. **Snapshot the wallet balance** `B0` (before the claim).
2. **Claim** $SN creator fees → `solClaimed`. Nothing claimed → `skipped`.
3. **Rewards leg**: snapshot $SN holders once (`MIN_HOLD`, default **1**), then
   for each reward token:
   a. guard (see Safety) — skip this token if a guard trips;
   b. buy with its % of `solClaimed` (amount measured by balance delta, as today);
   c. compute pro-rata allocations with the dust filter;
   d. airdrop.
4. **Buyback & burn**: buy $SN with `BURN_PCT`; burn exactly the measured
   `tokensBoughtRaw` from the wallet's $SN account. Never burn pre-existing balance.
5. **Marketing**: `B1` = current balance.
   `send = min(solClaimed × MARKETING_PCT, B1 − B0 − txFee)`, clamped at ≥ 0.
   `B1 − B0` is what is left of this cycle's claim after the other steps: 50%
   minus the real overhead (gas, priority fees, rent) by default. So marketing
   receives its share net of costs. There are no estimates, because it uses
   measured balances.
   - **`MARKETING_WALLET` blank or equal to the operating (dev) wallet → no
     transfer**; the share simply stays in the dev wallet. The step is recorded
     as `marketing` with `status: kept`.
6. **Finish** with status `complete`, or `partial` if any leg failed.

**Failure isolation:** each leg (NVDAx, SI, burn, marketing) runs in its own
try/catch. A failure records a `failed` step and the cycle continues. Unspent
SOL from a failed or skipped leg stays in the wallet (the marketing formula
caps at its 50%, so it is never swept to marketing).

**Config:** `MARKETING_PCT=50`, `BURN_PCT=10`, `NVDAX_PCT=20`, `SI_PCT=20`.
Startup fails if they sum to more than 100. Any unallocated remainder (0 by
default) stays in the dev wallet.

## Safety guards for the Token-2022 reward tokens

- **NVDAx paused** (`pausableConfig.paused`) → skip the NVDAx leg this cycle.
- **SI fee raised** — read `transferFeeConfig` each cycle; if the fee in effect
  this epoch, or a pending newer fee, is above `MAX_TRANSFER_FEE_BPS` (default
  100) → skip the SI leg. Once a lowered fee's epoch arrives it alone counts.
- **Transfers** use `createTransferCheckedWithTransferHookInstruction`, which
  behaves as `transferChecked` today and keeps working if the issuer ever sets
  a transfer hook.
- **Per-recipient isolation:** when a batch fails (e.g. one frozen account), its
  recipients are retried one by one, so a single bad account can't sink the
  batch.
- **Raw units everywhere.** NVDAx's scaled-UI multiplier and SI's fee don't
  affect the maths: allocations and transfers use raw amounts. SI recipients
  receive 99% of the amount sent (the fee is withheld on-chain); the recorded
  `amount_raw` is the gross amount sent.

## Holder eligibility and dust

- `MIN_HOLD` default **1** $SN; configurable in `.env`.
- Auto-excluded: the operating wallet, the marketing wallet, the pump.fun
  **bonding-curve PDA** of $SN (new — without it the curve reserve would take
  most of the rewards before graduation), the canonical PumpSwap pool, and
  `AIRDROP_EXCLUDE`.
- **Dust filter:** an allocation worth less than `MIN_AIRDROP_USD` (default
  **0.50**, i.e. roughly a new token account's rent) is dropped, and its share
  is redistributed to the remaining holders so the total still sums exactly.
  The value uses the leg's own buy price (`solSpent / tokensBoughtRaw × SOL price`).
  Implemented as `opts.minAmountRaw` in `computeWeightedAllocations`.

## API

- `/summary`: add `nvdaxDistributed`, `siDistributed`, `snBurned`,
  `marketingSol`; drop `cupsyDistributed`.
- New `/burns` endpoint: a list of burn steps (cycle, amount, signature, time).
- `/airdrops?token=NVDAX|SI`.
- `/api/status`: exposes the four percentages, reward mints, and `minClaimUsd`.
- Activity feed: new `burn` and `marketing` step types get public labels.
- `finishCycle` allowlist gains `marketing_sol`, `sn_burned` (UI units), and `legs`; legacy LP/lock fields are dropped.

## Rebrand and cleanup

- `babycupsy`/`cupsy` → `superneko`/`sn` across package.json, server.js log
  prefixes, config keys, tests, `.env.example`, and `docs/DEPLOY.md` (domain
  `superneko.meme`, API `api.superneko.meme`, pm2 name `superneko`, Mongo db
  `superneko`).
- `CORS_ORIGINS` default includes `https://superneko.meme` and
  `https://www.superneko.meme`.
- Remove dead legacy config (LP/lock/devFee fields and their stats sums)
  that the cycle never uses; remove the orphan `/sse-test` route.
- Fix `scripts/buy.js`, which calls `buyOnCurve(amount)` with the wrong arguments.

## Testing (DRY_RUN, `node --test`)

- Scheduler: below/at the USD threshold, no-price skip, stale price, and
  `triggerNow` override.
- Split: percentages validated at startup; per-leg SOL amounts are correct.
- Marketing: sends 50% minus the measured overhead; never above 50% (a
  skipped leg's SOL isn't swept); clamped at 0; a blank or dev wallet produces
  `kept`.
- Cycle: the full DRY_RUN run records the steps claim, buy×2, airdrop×2,
  buy+burn, marketing; one failing leg → `partial` while the others complete.
- Guards: paused NVDAx and a raised SI fee each skip only their own leg (pure
  functions over parsed mint data).
- Distribution: the dust filter drops and redistributes, and the sum stays exact.
- Burn: it burns exactly the bought amount.

## Out of scope

The superneko.meme frontend; changing reward tokens at runtime; recovering
withheld SI fees; KYC/geo-filtering of recipients.
