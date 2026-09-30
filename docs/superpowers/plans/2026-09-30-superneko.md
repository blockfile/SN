# Super Neko ($SN) Reward Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the copied BABYCUPSY engine into Super Neko. $SN pump.fun creator fees trigger a cycle at $100. Each cycle splits the claim four ways: 50% marketing (which is the reserve), 10% $SN buyback & burn, 20% NVDAx airdrop and 20% $SI airdrop to $SN holders.

**Architecture:** This is a Node.js (CommonJS) Express + node-cron service. A scheduler polls the pump.fun creator vault each minute and runs `runCycle()` once the vault's USD value reaches the threshold. The cycle is a sequence of isolated legs (rewards → burn → marketing), each recording steps in MongoDB. Every on-chain helper has a `DRY_RUN` branch that returns simulated results, and that is how all tests run.

**Tech Stack:** Node ≥20, `node --test`, `mongodb-memory-server`, `@solana/web3.js` 1.x, `@solana/spl-token` 0.4.14 (Token-2022 helpers), `@pump-fun/pump-sdk`, Jupiter lite-api.

**Spec:** `docs/superpowers/specs/2026-09-30-superneko-design.md`

## Global Constraints

- Repo: `D:\projects\sn` (Git Bash path `/d/projects/sn`). Run every command from the repo root.
- Every test runs with `DRY_RUN=true`. Tests must never hit the network except for the mongod binary download by `mongodb-memory-server`.
- Default split: `MARKETING_PCT=50`, `BURN_PCT=10`, `NVDAX_PCT=20`, `SI_PCT=20`. Startup fails if the sum is over 100.
- Marketing is the reserve. Gas and ATA rent come out of the marketing share, and the marketing send is never more than `solClaimed × MARKETING_PCT / 100`.
- If `MARKETING_WALLET` is blank or equals the operating wallet, nothing is transferred and the step records `status: 'kept'`.
- Trigger: `unclaimedSol × SOL/USD ≥ MIN_CLAIM_USD` (default `100`). If there is no fresh price (unavailable, or older than 10 minutes), skip the tick. `POST /api/run` ignores the threshold.
- Reward mints are hard-coded defaults and are never looked up by name:
  - NVDAx `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` (Token-2022, 8 dp)
  - $SI `DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP` (Token-2022, 6 dp, 1% transfer fee)
- `MIN_HOLD` defaults to `1`. `MIN_AIRDROP_USD` defaults to `0.5`. `MAX_TRANSFER_FEE_BPS` defaults to `100`. `AIRDROP_BATCH_SIZE` defaults to `5`.
- Burn only the $SN bought in the current cycle, never the wallet's pre-existing balance.
- All token math uses raw integer units (BigInt).
- Follow the existing code style: `'use strict'`, CommonJS, 2-space indent, single quotes, sparse "why" comments.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Config — split, trigger, reward mints, defaults

**Files:**
- Modify: `src/config.js` (the `// Reward loop` block around L121-136; add validation after the object)
- Test: `src/config.test.js`

**Interfaces:**
- Produces these `config` keys: `minClaimUsd`, `dryRunSolPriceUsd`, `marketingPct`, `burnPct`, `nvdaxPct`, `siPct`, `marketingWallet` (string|null), `nvdaxMint`, `siMint`, `maxTransferFeeBps`, `minAirdropUsd`.
- Changes these defaults: `minHold` → `1`, `airdropBatchSize` → `5`.
- Leaves the legacy keys (`cupsyMint`, `cupsyBuyPct`, `minClaimSol`, `devWallet`, …) in place. Task 11 removes them.

- [ ] **Step 1: Install dependencies and record the baseline**

```bash
cd /d/projects/sn && npm install && npm test
```
Expected: install succeeds and all existing tests PASS. The first run downloads a mongod binary. If the baseline fails, stop and report.

- [ ] **Step 2: Write the failing tests**

Replace the first test in `src/config.test.js` and add two new tests. The final file is:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('config exposes the loop defaults', () => {
  delete require.cache[require.resolve('./config')];
  const config = require('./config');
  assert.strictEqual(config.rewardCapPct, 0);
  assert.strictEqual(config.minHold, 1);
  assert.strictEqual(config.pollSchedule, '* * * * *');
  assert.strictEqual(config.dryRunFeePerPoll, 0.05);
  assert.strictEqual(config.airdropBatchSize, 5);
  assert.ok(Array.isArray(config.clusters));
  assert.ok(Array.isArray(config.airdropExclude));
});

test('config exposes the Super Neko split, trigger and reward mints', () => {
  delete require.cache[require.resolve('./config')];
  const config = require('./config');
  assert.strictEqual(config.marketingPct, 50);
  assert.strictEqual(config.burnPct, 10);
  assert.strictEqual(config.nvdaxPct, 20);
  assert.strictEqual(config.siPct, 20);
  assert.strictEqual(config.marketingWallet, null);
  assert.strictEqual(config.minClaimUsd, 100);
  assert.strictEqual(config.dryRunSolPriceUsd, 150);
  assert.strictEqual(config.nvdaxMint, 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh');
  assert.strictEqual(config.siMint, 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP');
  assert.strictEqual(config.maxTransferFeeBps, 100);
  assert.strictEqual(config.minAirdropUsd, 0.5);
});

test('config rejects a split over 100%', () => {
  delete require.cache[require.resolve('./config')];
  process.env.SI_PCT = '30';
  try {
    assert.throws(() => require('./config'), /sums to 110%/);
  } finally {
    delete process.env.SI_PCT;
    delete require.cache[require.resolve('./config')];
  }
});

test('config.clusters parses a JSON array-of-arrays from env', () => {
  delete require.cache[require.resolve('./config')];
  process.env.CLUSTERS = '[["AAA","BBB"],["CCC"]]';
  const config = require('./config');
  assert.deepStrictEqual(config.clusters, [['AAA', 'BBB'], ['CCC']]);
  delete process.env.CLUSTERS;
  delete require.cache[require.resolve('./config')];
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `node --test src/config.test.js`
Expected: FAIL. `minHold` is 100000, `marketingPct` is undefined, and the split test doesn't throw.

- [ ] **Step 4: Implement**

In `src/config.js`, change the `minHold` line to:

```js
  minHold: num(process.env.MIN_HOLD, 1), // min $SN balance to qualify (whole tokens)
```

Change the `airdropBatchSize` line to:

```js
  // Recipients per airdrop tx. Token-2022 ATA creation is compute-heavy, so keep
  // this small enough to fit COMPUTE_UNIT_LIMIT (failed batches retry one by one).
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 5),
```

Insert this block immediately after the `airdropExclude` entry, still inside the object:

```js

  // ── Super Neko cycle ───────────────────────────────────────────────────────
  // Trigger: a cycle fires once unclaimed creator fees are worth >= minClaimUsd.
  minClaimUsd: num(process.env.MIN_CLAIM_USD, 100),
  // DRY_RUN only: fixed SOL/USD so dry runs and tests never touch the network.
  // 0 simulates "no price available".
  dryRunSolPriceUsd: num(process.env.DRY_RUN_SOL_PRICE_USD, 150),

  // Split of each claim, percent. Must sum to <= 100; any remainder stays in the
  // operating (dev) wallet. Marketing is the reserve: gas + ATA rent spent by the
  // other legs are deducted from it before it is sent.
  marketingPct: num(process.env.MARKETING_PCT, 50),
  burnPct: num(process.env.BURN_PCT, 10),
  nvdaxPct: num(process.env.NVDAX_PCT, 20),
  siPct: num(process.env.SI_PCT, 20),
  // Blank (or the operating wallet itself) = the marketing share stays in the dev wallet.
  marketingWallet: process.env.MARKETING_WALLET || null,

  // Reward tokens. Hard-coded mints — never resolve these by name (many fake
  // "NVIDIA xStock" copies exist on-chain).
  nvdaxMint: process.env.NVDAX_MINT || 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', // NVIDIA xStock (Token-2022, 8 dp)
  siMint: process.env.SI_MINT || 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP', // Super Inu (Token-2022, 6 dp, 1% transfer fee)
  // Skip a reward token's leg when its Token-2022 transfer fee exceeds this.
  maxTransferFeeBps: num(process.env.MAX_TRANSFER_FEE_BPS, 100),
  // Drop allocations worth less than this (≈ one new token account's rent) and
  // redistribute them to the remaining holders.
  minAirdropUsd: num(process.env.MIN_AIRDROP_USD, 0.5),
```

Replace `module.exports = config;` at the bottom with:

```js
// Fail fast on a misconfigured split — a sum over 100 would spend SOL the claim
// never produced.
function validateSplit(c) {
  const parts = { MARKETING_PCT: c.marketingPct, BURN_PCT: c.burnPct, NVDAX_PCT: c.nvdaxPct, SI_PCT: c.siPct };
  for (const [key, value] of Object.entries(parts)) {
    if (!(value >= 0)) throw new Error(`${key} must be >= 0 (got ${value})`);
  }
  const sum = Object.values(parts).reduce((s, v) => s + v, 0);
  if (sum > 100) {
    throw new Error(`fee split sums to ${sum}% (MARKETING_PCT+BURN_PCT+NVDAX_PCT+SI_PCT must be <= 100)`);
  }
}
validateSplit(config);

module.exports = config;
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test src/config.test.js && npm test`
Expected: PASS for the whole suite.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config.test.js package-lock.json
git commit -m "feat(config): Super Neko split, USD trigger, reward mints

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Price — DRY_RUN price and a freshness gate

**Files:**
- Modify: `src/solana/price.js` (full rewrite below)
- Create: `src/solana/price.test.js`

**Interfaces:**
- Consumes: `config.dryRun`, `config.dryRunSolPriceUsd` (Task 1).
- Produces:
  - `getFreshSolPriceUsd(): Promise<number|null>` returns null when the price is missing or older than `MAX_AGE_MS`.
  - `isFresh(at: number, now?: number): boolean`
  - `MAX_AGE_MS` (600000)
  - `getSolPriceUsd`, `getCachedSolPriceUsd` and `toUsd` are unchanged.

- [ ] **Step 1: Write the failing test** in `src/solana/price.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

function freshPrice(env) {
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./price')];
  return require('./price');
}

test('isFresh: recent is fresh; stale or never-fetched is not', () => {
  const { isFresh, MAX_AGE_MS } = freshPrice({ DRY_RUN: 'true' });
  const now = 1_000_000_000;
  assert.strictEqual(isFresh(now - 1000, now), true);
  assert.strictEqual(isFresh(now - MAX_AGE_MS - 1, now), false);
  assert.strictEqual(isFresh(0, now), false);
});

test('DRY_RUN serves the fixed simulated price; 0 means no price', async () => {
  try {
    let price = freshPrice({ DRY_RUN: 'true', DRY_RUN_SOL_PRICE_USD: '200' });
    assert.strictEqual(await price.getSolPriceUsd(), 200);
    assert.strictEqual(await price.getFreshSolPriceUsd(), 200);

    price = freshPrice({ DRY_RUN: 'true', DRY_RUN_SOL_PRICE_USD: '0' });
    assert.strictEqual(await price.getFreshSolPriceUsd(), null);
  } finally {
    delete process.env.DRY_RUN_SOL_PRICE_USD;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('./price')];
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/solana/price.test.js`
Expected: FAIL with `isFresh is not a function`.

- [ ] **Step 3: Implement** by replacing `src/solana/price.js` with:

```js
'use strict';

const config = require('../config');

// SOL→USD price, cached so the dashboard can poll freely without hammering the source.
let cache = { value: null, at: 0 };
const TTL_MS = 60_000;
// A cached price older than this is too stale to move money on (cycle trigger,
// dust threshold). Display paths still show it.
const MAX_AGE_MS = 10 * 60_000;

async function getSolPriceUsd() {
  const now = Date.now();
  if (config.dryRun) {
    // Fixed simulated price — dry runs and tests never touch the network.
    const px = config.dryRunSolPriceUsd > 0 ? config.dryRunSolPriceUsd : null;
    cache = { value: px, at: px == null ? 0 : now };
    return px;
  }
  if (cache.value !== null && now - cache.at < TTL_MS) return cache.value;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );
    const j = await res.json();
    const px = j && j.solana && j.solana.usd;
    if (typeof px === 'number' && px > 0) {
      cache = { value: px, at: now };
      return px;
    }
  } catch (_err) {
    // fall through to stale/null
  }
  return cache.value; // last known price, or null if never fetched
}

/** True when a price fetched at `at` (epoch ms) is recent enough to act on. */
function isFresh(at, now = Date.now()) {
  return at > 0 && now - at <= MAX_AGE_MS;
}

/** Like getSolPriceUsd, but null when only a stale cached value is available. */
async function getFreshSolPriceUsd() {
  const px = await getSolPriceUsd();
  return px != null && isFresh(cache.at) ? px : null;
}

/** Last fetched price without triggering a fetch (null until first fetch). */
function getCachedSolPriceUsd() {
  return cache.value;
}

/** Convert a SOL amount to USD (rounded to cents), or null if no price. */
function toUsd(sol, price) {
  if (sol == null || price == null) return null;
  return +(sol * price).toFixed(2);
}

module.exports = { getSolPriceUsd, getFreshSolPriceUsd, getCachedSolPriceUsd, toUsd, isFresh, MAX_AGE_MS };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/solana/price.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solana/price.js src/solana/price.test.js
git commit -m "feat(price): fixed DRY_RUN price and freshness gate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: USD trigger — scheduler, /countdown and /accumulator

**Files:**
- Modify: `src/jobs/scheduler.js` (`pollOnce` L27-56, `start` log L67-69, `getState` L104-115, and the `triggerNow` comment)
- Modify: `src/routes/public.js` (imports L11; `/countdown` L126-149; `/accumulator` L151-165)
- Modify: `src/services/countdown.js` (the `thresholdProgress` comment and parameter names only)
- Modify: `server.js` L39 (banner)
- Test: `src/jobs/scheduler.test.js` (rewrite)

**Interfaces:**
- Consumes: `getFreshSolPriceUsd`, `getSolPriceUsd` and `toUsd` (Task 2); `config.minClaimUsd` (Task 1).
- Produces:
  - `pollOnce` returns `{ran, claimable, claimableUsd?, reason?, cycle?}`, where `reason` is one of `'paused'|'cycle already running'|'nothing claimable'|'no price'|'below threshold'`.
  - `getState()` includes `minClaimUsd` and `lastClaimableUsd` and no longer includes `minClaimSol`.

- [ ] **Step 1: Write the failing test** by replacing `src/jobs/scheduler.test.js` with:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('pollOnce fires only once unclaimed fees are worth MIN_CLAIM_USD', async () => {
  process.env.DRY_RUN = 'true';
  process.env.SIMULATE_GRADUATED = 'true';
  process.env.TOKEN_MINT = 'SNmint1111111111111111111111111111111111111';
  process.env.DRY_RUN_FEE_PER_POLL = '0'; // no simulated accrual — we control the vault
  process.env.MIN_CLAIM_USD = '100';
  process.env.DRY_RUN_SOL_PRICE_USD = '150'; // $100 threshold = 0.6667 SOL
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_sched';
  const config = require('../config');
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../solana/simvault');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    simvault.reset(0);
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.strictEqual(p1.reason, 'nothing claimable');

    // $75 of fees → below the $100 threshold, no cycle row.
    simvault.reset(0.5);
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, false);
    assert.strictEqual(p2.reason, 'below threshold');
    assert.strictEqual(p2.claimable, 0.5);
    assert.strictEqual(p2.claimableUsd, 75);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0);

    // No price → never fire blind, even with plenty of fees.
    config.dryRunSolPriceUsd = 0;
    simvault.reset(5);
    const p3 = await scheduler.pollOnce('poll');
    assert.strictEqual(p3.ran, false);
    assert.strictEqual(p3.reason, 'no price');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0);
    config.dryRunSolPriceUsd = 150;

    // $105 → fires.
    simvault.reset(0.7);
    const p4 = await scheduler.pollOnce('poll');
    assert.strictEqual(p4.ran, true);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1);
    assert.strictEqual(scheduler.getState().minClaimUsd, 100);

    // POST /api/run override ignores the threshold.
    simvault.reset(0.01);
    const manual = await scheduler.triggerNow();
    assert.ok(manual.id, 'manual cycle recorded');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 2);
  } finally {
    await db.close();
    await mongod.stop();
    delete process.env.MIN_CLAIM_USD;
    delete process.env.DRY_RUN_SOL_PRICE_USD;
    delete require.cache[require.resolve('../config')];
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/jobs/scheduler.test.js`
Expected: FAIL. `p2.reason` is `'below threshold'` but `claimableUsd` is undefined, or `p3` fires.

- [ ] **Step 3: Implement the scheduler**

In `src/jobs/scheduler.js`, add this import after the `bus` require:

```js
const { getFreshSolPriceUsd } = require('../solana/price');
```

Add `lastClaimableUsd: null,` to `state` after `lastClaimable`.

Replace the doc comment and body of `pollOnce` from `simulateFeeAccrual();` down to the `below threshold` return with:

```js
  simulateFeeAccrual(); // no-op in live mode
  const claimable = await getClaimableSol();
  state.lastClaimable = claimable;
  // Push the fresh balance to SSE clients so the frontend's threshold progress
  // bar tracks accrual live instead of polling /countdown.
  bus.emit('unclaimed', claimable);
  if (!(claimable > 0)) {
    return { ran: false, claimable, reason: 'nothing claimable' };
  }
  // The trigger is a USD amount. Without a fresh SOL price we can't know whether
  // it's reached, so skip this tick rather than fire blind.
  const price = await getFreshSolPriceUsd();
  if (price == null) {
    state.lastClaimableUsd = null;
    console.log('[scheduler] no fresh SOL price — skipping tick');
    return { ran: false, claimable, reason: 'no price' };
  }
  const claimableUsd = +(claimable * price).toFixed(2);
  state.lastClaimableUsd = claimableUsd;
  if (claimable * price < config.minClaimUsd) {
    return { ran: false, claimable, claimableUsd, reason: 'below threshold' };
  }
```

Change the `return { ran: true, claimable, cycle };` line to `return { ran: true, claimable, claimableUsd, cycle };`.

Replace the doc comment above `pollOnce` with:

```js
/**
 * One timer tick (every POLL_SCHEDULE, default every minute). Advances the simulated
 * vault (DRY_RUN only), reads the claimable creator-fee balance, and runs a cycle
 * only once that balance is worth MIN_CLAIM_USD at the current SOL price — below
 * the threshold, or with no fresh price, the tick skips silently (no cycle row)
 * and fees keep accruing. Overlap-guarded.
 * @param {string} trigger 'poll' | 'manual'
 * @returns {Promise<{ran:boolean, claimable?:number, claimableUsd?:number, reason?:string, cycle?:object}>}
 */
```

Change the start log to:

```js
    `[scheduler] started — checks "${config.pollSchedule}", claims at >= $${config.minClaimUsd} of fees (dryRun=${config.dryRun})`
```

In the `triggerNow` comment, change `MIN_CLAIM_SOL threshold` to `MIN_CLAIM_USD threshold`.

In `getState()`, replace `minClaimSol: config.minClaimSol,` with `minClaimUsd: config.minClaimUsd,`, and add `lastClaimableUsd: state.lastClaimableUsd,` after `lastClaimable`.

- [ ] **Step 4: Update the endpoints**

In `src/routes/public.js`, change the price import to:

```js
const { getSolPriceUsd, toUsd } = require('../solana/price');
```

Replace the `/countdown` comment and handler with:

```js
// GET /countdown — next vault CHECK plus progress toward the USD claim threshold.
// A cycle fires once unclaimed fees are worth MIN_CLAIM_USD, so there is no fixed
// next-airdrop time; nextCheckAt is when the vault is next read. nextAirdropAt is
// kept as an alias so existing frontends keep working.
// Not cached: serverTime must be fresh so the client can anchor to the server clock.
router.get('/countdown', async (req, res, next) => {
  try {
    const now = Date.now();
    const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, now);
    const [unclaimedSol, price] = await Promise.all([readUnclaimedSol(), getSolPriceUsd().catch(() => null)]);
    const unclaimedUsd = toUsd(unclaimedSol, price);
    res.json({
      serverTime: now,
      nextCheckAt: nextAirdropAt,
      nextAirdropAt,
      intervalSec,
      unclaimedSol: unclaimedSol == null ? null : +unclaimedSol.toFixed(6),
      unclaimedUsd,
      thresholdUsd: config.minClaimUsd,
      progressPct: thresholdProgress(unclaimedUsd, config.minClaimUsd),
    });
  } catch (err) {
    next(err);
  }
});
```

Replace the `/accumulator` comment and handler with:

```js
// GET /accumulator — the reward-pot fill level for the frontend jar. The pot
// fires a cycle when accumulatedUsd reaches thresholdUsd; accumulatedSol is kept
// for display.
router.get('/accumulator', async (req, res, next) => {
  try {
    const [sol, price] = await Promise.all([readUnclaimedSol(), getSolPriceUsd().catch(() => null)]);
    res.json({
      accumulatedSol: sol == null ? 0 : +sol.toFixed(6),
      accumulatedUsd: toUsd(sol == null ? 0 : sol, price),
      thresholdUsd: config.minClaimUsd,
    });
  } catch (err) {
    next(err);
  }
});
```

In `src/services/countdown.js`, rename the `thresholdProgress` parameters and comment. The behaviour is unchanged:

```js
// Progress toward the claim threshold, 0-100 (clamped). Unit-agnostic (the
// trigger passes USD). Null when the value isn't known yet (no poll landed / no
// price); 100 when the threshold is disabled.
function thresholdProgress(value, threshold) {
  if (value == null || !Number.isFinite(value)) return null;
  if (!Number.isFinite(threshold) || threshold <= 0) return 100;
  const pct = (value / threshold) * 100;
  return +Math.min(100, Math.max(0, pct)).toFixed(1);
}
```

In `server.js`, change the description line to:

```js
      `pump.fun creator fees → $SN buyback & burn + NVDAx and $SI rewards for $SN holders (claims once unclaimed fees reach $${config.minClaimUsd})`,
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test src/jobs/scheduler.test.js && npm test`
Expected: PASS. `countdown.test.js` still passes because it only calls positional arguments.

Also run `node -e "require('./src/routes/public')"` to confirm the module loads. Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/scheduler.js src/jobs/scheduler.test.js src/routes/public.js src/services/countdown.js server.js
git commit -m "feat(trigger): fire cycles at \$100 of unclaimed fees, skip without a fresh price

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Distribution — dust filter

**Files:**
- Modify: `src/services/distribution.js`
- Test: `src/services/distribution.test.js` (append)

**Interfaces:**
- Produces:
  - `computeWeightedAllocations(holders, totalRaw, opts)` accepts `opts.minAmountRaw` (string|bigint|null). Recipients below it are dropped and the total is re-split among the rest. The sum stays exactly `totalRaw`, or the result is `[]` if everyone is dust.
  - `minRawForUsd({ minUsd, solSpent, solPriceUsd, tokensBoughtRaw }): bigint|null` converts a USD floor to raw units at this buy's price. It returns null when the inputs can't price it.

- [ ] **Step 1: Write the failing tests** by appending to `src/services/distribution.test.js`:

```js
const { minRawForUsd } = require('./distribution');

test('dust filter drops sub-threshold recipients and redistributes their share', () => {
  // A's pro-rata share is 1 unit (< 10) → dropped; B receives everything.
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '1000' }],
    '1001',
    { minAmountRaw: '10' }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1001n);
  assert.strictEqual(m.A, undefined);
  assert.strictEqual(m.B, 1001n);
});

test('dust filter re-checks after redistribution until stable', () => {
  // total 100: A=1%, B=4%, C=95% → A (1) and B (4) are below 5 → C gets all 100.
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '4' }, { owner: 'C', balanceRaw: '95' }],
    '100',
    { minAmountRaw: 5n }
  );
  assert.deepStrictEqual(out, [{ owner: 'C', amountRaw: '100' }]);
});

test('dust filter returns [] when every share is dust', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '1' }],
    '10',
    { minAmountRaw: '100' }
  );
  assert.deepStrictEqual(out, []);
});

test('minRawForUsd converts a USD floor into raw units at this buy price', () => {
  // 0.3 SOL bought 30,000,000 raw at $150/SOL → $45 per 30,000,000 raw → $0.50 = 333,334 raw (ceil).
  assert.strictEqual(minRawForUsd({ minUsd: 0.5, solSpent: 0.3, solPriceUsd: 150, tokensBoughtRaw: 30_000_000n }), 333334n);
  assert.strictEqual(minRawForUsd({ minUsd: 0.5, solSpent: 0.3, solPriceUsd: null, tokensBoughtRaw: 30_000_000n }), null);
  assert.strictEqual(minRawForUsd({ minUsd: 0, solSpent: 0.3, solPriceUsd: 150, tokensBoughtRaw: 30_000_000n }), null);
  assert.strictEqual(minRawForUsd({ minUsd: 0.5, solSpent: 0.3, solPriceUsd: 150, tokensBoughtRaw: 0n }), null);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test src/services/distribution.test.js`
Expected: FAIL. `minRawForUsd` is not a function, and A still receives 1.

- [ ] **Step 3: Implement**

In `src/services/distribution.js`:
- Rename the existing `function computeWeightedAllocations(holders, totalRaw, opts = {})` to `function allocateOnce(holders, totalRaw, opts = {})`. The body is unchanged.
- Update the header comment's `opts.capPct` line to read `number|null — cap each person's weight at capPct% of supplyRaw. null = no cap.`
- Add this after `allocateOnce`:

```js
// Public entry point. opts.minAmountRaw (optional) is the dust floor: recipients
// whose share falls below it are dropped and the total is re-split among the
// rest, repeating until every share clears the floor (each pass removes at least
// one holder, so this terminates). The result still sums exactly to totalRaw —
// or is [] when every share is dust, leaving the tokens in the wallet.
function computeWeightedAllocations(holders, totalRaw, opts = {}) {
  const { minAmountRaw = null, ...rest } = opts;
  let out = allocateOnce(holders, totalRaw, rest);
  if (minAmountRaw == null) return out;
  const min = BigInt(minAmountRaw.toString());
  let pool = holders;
  for (;;) {
    const dust = new Set(out.filter((a) => BigInt(a.amountRaw) < min).map((a) => a.owner));
    if (dust.size === 0) return out;
    pool = pool.filter((h) => !dust.has(h.owner));
    out = allocateOnce(pool, totalRaw, rest);
  }
}

// Dust floor in raw units: the USD value `minUsd` at the price this leg actually
// paid (solSpent SOL for tokensBoughtRaw). Null when it can't be priced — the
// caller then applies no dust filter.
function minRawForUsd({ minUsd, solSpent, solPriceUsd, tokensBoughtRaw }) {
  const bought = BigInt((tokensBoughtRaw ?? 0).toString());
  if (!(minUsd > 0) || !(solSpent > 0) || !(solPriceUsd > 0) || bought <= 0n) return null;
  return BigInt(Math.ceil((minUsd * Number(bought)) / (solSpent * solPriceUsd)));
}
```

Change the export to `module.exports = { computeWeightedAllocations, minRawForUsd };`

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/services/distribution.test.js && npm test`
Expected: PASS, including the old pro-rata, cap and cluster tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/distribution.js src/services/distribution.test.js
git commit -m "feat(distribution): dust floor with exact redistribution

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Mint guards — paused NVDAx, raised SI fee

**Files:**
- Create: `src/solana/mintguard.js`
- Create: `src/solana/mintguard.test.js`

**Interfaces:**
- Consumes: `getMintInfo(connection, mint)` from `src/solana/tokens.js`, which returns `{decimals, programId}`; `config.maxTransferFeeBps`.
- Produces:
  - `evaluateMintGuard({paused, transferFeeBps}, {maxTransferFeeBps}) → {ok:true} | {ok:false, reason:string}`
  - `maxFeeBps(transferFeeConfig|null) → number|null`
  - `checkRewardMint(mint): Promise<{ok, reason?}>`. It always returns `{ok:true}` in DRY_RUN, and returns `{ok:false}` rather than throwing on RPC errors.

- [ ] **Step 1: Write the failing test** in `src/solana/mintguard.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { evaluateMintGuard, maxFeeBps, checkRewardMint } = require('./mintguard');

const limits = { maxTransferFeeBps: 100 };

test('evaluateMintGuard passes a normal mint and the current 1% SI fee', () => {
  assert.deepStrictEqual(evaluateMintGuard({ paused: false, transferFeeBps: null }, limits), { ok: true });
  assert.deepStrictEqual(evaluateMintGuard({ paused: false, transferFeeBps: 100 }, limits), { ok: true });
});

test('evaluateMintGuard blocks a paused mint', () => {
  const r = evaluateMintGuard({ paused: true, transferFeeBps: null }, limits);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /paused/);
});

test('evaluateMintGuard blocks a transfer fee above the max', () => {
  const r = evaluateMintGuard({ paused: false, transferFeeBps: 500 }, limits);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /500 bps/);
});

test('maxFeeBps takes the higher of the older/newer fee (a pending raise counts)', () => {
  const cfg = { olderTransferFee: { transferFeeBasisPoints: 100 }, newerTransferFee: { transferFeeBasisPoints: 900 } };
  assert.strictEqual(maxFeeBps(cfg), 900);
  assert.strictEqual(maxFeeBps(null), null);
});

test('checkRewardMint is a no-op pass in DRY_RUN', async () => {
  assert.deepStrictEqual(await checkRewardMint('DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'), { ok: true });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/solana/mintguard.test.js`
Expected: FAIL with `Cannot find module './mintguard'`.

- [ ] **Step 3: Implement** `src/solana/mintguard.js`

```js
'use strict';

const { PublicKey } = require('@solana/web3.js');
const { getMint, getPausableConfig, getTransferFeeConfig } = require('@solana/spl-token');
const config = require('../config');
const { connection } = require('./connection');
const { getMintInfo } = require('./tokens');

// Both reward tokens are Token-2022 mints whose issuers can change the rules
// under us: NVDAx is pausable (every transfer fails while paused) and $SI's fee
// authority can raise its 1% transfer fee. Checked before each buy so a tripped
// guard skips just that leg and the SOL stays in the wallet.

// Pure decision over the mint's live state.
function evaluateMintGuard({ paused, transferFeeBps }, { maxTransferFeeBps }) {
  if (paused) return { ok: false, reason: 'mint is paused' };
  if (transferFeeBps != null && transferFeeBps > maxTransferFeeBps) {
    return { ok: false, reason: `transfer fee ${transferFeeBps} bps exceeds max ${maxTransferFeeBps} bps` };
  }
  return { ok: true };
}

// A fee raise is scheduled as newerTransferFee and takes effect at a later
// epoch, so guard on the higher of the two.
function maxFeeBps(feeConfig) {
  if (!feeConfig) return null;
  return Math.max(feeConfig.olderTransferFee.transferFeeBasisPoints, feeConfig.newerTransferFee.transferFeeBasisPoints);
}

async function readMintState(mint) {
  const { programId } = await getMintInfo(connection, mint);
  const mintAcc = await getMint(connection, new PublicKey(mint), 'confirmed', programId);
  const pausable = getPausableConfig(mintAcc);
  return {
    paused: pausable ? pausable.paused : false,
    transferFeeBps: maxFeeBps(getTransferFeeConfig(mintAcc)),
  };
}

/** @returns {Promise<{ok: boolean, reason?: string}>} never throws */
async function checkRewardMint(mint) {
  if (config.dryRun) return { ok: true };
  try {
    return evaluateMintGuard(await readMintState(mint), config);
  } catch (err) {
    return { ok: false, reason: `mint check failed: ${err.message}` };
  }
}

module.exports = { evaluateMintGuard, maxFeeBps, checkRewardMint };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/solana/mintguard.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solana/mintguard.js src/solana/mintguard.test.js
git commit -m "feat(guards): skip reward legs when a mint is paused or its fee is raised

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Burn and marketing helpers

**Files:**
- Modify: `src/solana/tokens.js` (import and export `createBurnCheckedInstruction` and `createTransferCheckedWithTransferHookInstruction`)
- Create: `src/solana/burn.js`, `src/solana/burn.test.js`
- Create: `src/solana/marketing.js`, `src/solana/marketing.test.js`

**Interfaces:**
- Produces:
  - `burnBought(mint: string, amountRaw: string|bigint): Promise<{signature: string|null, burnedRaw: string, simulated: boolean}>`
  - `resolveMarketingDestination(marketingWallet: string|null, operatingWallet: string): string|null`
  - `computeMarketingSend({solClaimed, marketingPct, balanceBeforeSol, balanceAfterSol, txFeeSol?}): number` (SOL, ≥0, ≤ share)
  - `getWalletSolBalance(): Promise<number|null>` (null in DRY_RUN)
  - `sendMarketing(solAmount: number): Promise<{status: 'ok'|'kept'|'skipped', signature: string|null, recipient: string, solSent: number}>`
  - `tokens.js` additionally exports `createBurnCheckedInstruction` and `createTransferCheckedWithTransferHookInstruction`.

- [ ] **Step 1: Write the failing tests**

`src/solana/burn.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { burnBought } = require('./burn');

test('burnBought burns exactly the amount given (DRY_RUN)', async () => {
  const r = await burnBought('SNmint1111111111111111111111111111111111111', '12345');
  assert.strictEqual(r.burnedRaw, '12345');
  assert.strictEqual(r.simulated, true);
  assert.match(r.signature, /^burn_/);
});

test('burnBought with nothing bought sends nothing', async () => {
  const r = await burnBought('SNmint1111111111111111111111111111111111111', '0');
  assert.strictEqual(r.signature, null);
  assert.strictEqual(r.burnedRaw, '0');
});
```

`src/solana/marketing.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
const { computeMarketingSend, resolveMarketingDestination } = require('./marketing');

// 1 SOL claimed, 50% marketing share. Wallet had 2 SOL before the claim.
const base = { solClaimed: 1, marketingPct: 50, balanceBeforeSol: 2, txFeeSol: 0 };

test('marketing gets its full share when the other legs spent exactly their budget', () => {
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.5 }), 0.5);
});

test('gas and rent overhead come out of marketing', () => {
  // legs spent 0.5 + 0.01 overhead → 0.49 left
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.49 }), 0.49);
});

test('a skipped leg’s SOL is never swept into marketing', () => {
  // a 0.2 leg was skipped → 0.7 left, but marketing is capped at its 0.5 share
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.7 }), 0.5);
});

test('marketing clamps at 0 when overhead exceeds its share', () => {
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 1.9 }), 0);
});

test('the transfer’s own fee is reserved', () => {
  assert.strictEqual(computeMarketingSend({ ...base, balanceAfterSol: 2.49, txFeeSol: 0.00002 }), 0.48998);
});

test('blank or operating-wallet MARKETING_WALLET keeps the share in the dev wallet', () => {
  assert.strictEqual(resolveMarketingDestination(null, 'DEV'), null);
  assert.strictEqual(resolveMarketingDestination('', 'DEV'), null);
  assert.strictEqual(resolveMarketingDestination('DEV', 'DEV'), null);
  assert.strictEqual(resolveMarketingDestination('MKT', 'DEV'), 'MKT');
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test src/solana/burn.test.js src/solana/marketing.test.js`
Expected: FAIL with `Cannot find module './burn'` and `'./marketing'`.

- [ ] **Step 3: Implement**

In `src/solana/tokens.js`, add `createBurnCheckedInstruction,` and `createTransferCheckedWithTransferHookInstruction,` to the `@solana/spl-token` destructuring and to `module.exports`, after `createTransferCheckedInstruction`.

`src/solana/burn.js`:

```js
'use strict';

const { PublicKey } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet } = require('./connection');
const { getMintInfo, sendIxs, getAssociatedTokenAddressSync, createBurnCheckedInstruction } = require('./tokens');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Buyback & burn: destroy exactly `amountRaw` of `mint` from the operating
 * wallet's token account (SPL burnChecked — lowers on-chain supply). The caller
 * passes only what THIS cycle bought, never the wallet's pre-existing balance.
 * @returns {Promise<{signature: string|null, burnedRaw: string, simulated: boolean}>}
 */
async function burnBought(mint, amountRaw) {
  const amount = BigInt(amountRaw.toString());
  if (amount <= 0n) return { signature: null, burnedRaw: '0', simulated: config.dryRun };
  if (config.dryRun) return { signature: fakeSig('burn'), burnedRaw: amount.toString(), simulated: true };

  const mintPk = new PublicKey(mint);
  const { decimals, programId } = await getMintInfo(connection, mint);
  const account = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, programId);
  const ix = createBurnCheckedInstruction(account, mintPk, wallet.publicKey, amount, decimals, [], programId);
  const signature = await sendIxs(connection, wallet, [ix], { label: `burn ${amount} of ${mint}` });
  return { signature, burnedRaw: amount.toString(), simulated: false };
}

module.exports = { burnBought };
```

`src/solana/marketing.js`:

```js
'use strict';

const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config');
const { connection, wallet, walletPubkey } = require('./connection');
const { transferSol } = require('./tokens');

// Fee headroom for the marketing transfer itself: 5,000 lamports base + the
// compute-unit priority fee sendIxs attaches (≈10,000 lamports at defaults).
const TX_FEE_SOL = 0.00002;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// null = keep the share in the operating (dev) wallet: MARKETING_WALLET unset,
// or set to the operating wallet itself.
function resolveMarketingDestination(marketingWallet, operatingWallet) {
  if (!marketingWallet || marketingWallet === operatingWallet) return null;
  return marketingWallet;
}

// Marketing is the reserve. It runs last and sends its share net of whatever the
// other legs really spent (gas, priority fees, new-account rent): the cycle's
// leftover SOL is balanceAfter − balanceBefore. Capped at the marketing share so
// SOL from a skipped or failed leg is never swept into it.
function computeMarketingSend({ solClaimed, marketingPct, balanceBeforeSol, balanceAfterSol, txFeeSol = TX_FEE_SOL }) {
  const share = (solClaimed * marketingPct) / 100;
  const available = balanceAfterSol - balanceBeforeSol - txFeeSol;
  return Math.max(0, +Math.min(share, available).toFixed(9));
}

/** Operating wallet balance in SOL; null in DRY_RUN (nothing real to measure). */
async function getWalletSolBalance() {
  if (config.dryRun) return null;
  return (await connection.getBalance(wallet.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
}

/** @returns {Promise<{status: 'ok'|'kept'|'skipped', signature: string|null, recipient: string, solSent: number}>} */
async function sendMarketing(solAmount) {
  const to = resolveMarketingDestination(config.marketingWallet, walletPubkey());
  if (!to) return { status: 'kept', signature: null, recipient: walletPubkey(), solSent: 0 };
  if (!(solAmount > 0)) return { status: 'skipped', signature: null, recipient: to, solSent: 0 };
  if (config.dryRun) return { status: 'ok', signature: fakeSig('marketing'), recipient: to, solSent: solAmount };
  const signature = await transferSol(connection, wallet, new PublicKey(to), Math.floor(solAmount * LAMPORTS_PER_SOL));
  return { status: 'ok', signature, recipient: to, solSent: solAmount };
}

module.exports = { resolveMarketingDestination, computeMarketingSend, getWalletSolBalance, sendMarketing, TX_FEE_SOL };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/solana/burn.test.js src/solana/marketing.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solana/tokens.js src/solana/burn.js src/solana/burn.test.js src/solana/marketing.js src/solana/marketing.test.js
git commit -m "feat: buyback burn and marketing-as-reserve helpers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Airdrop — per-recipient fallback and transfer-hook support

**Files:**
- Modify: `src/solana/airdrop.js` (full rewrite below)
- Test: `src/solana/airdrop.test.js` (append)

**Interfaces:**
- Consumes: the `tokens.js` exports, including `createTransferCheckedWithTransferHookInstruction` (Task 6).
- Produces:
  - `airdropToken({rewardMint, allocations, cycleId}) → {sent, failed}` (same signature as before)
  - `sendWithFallback(batch, sendFn) → Promise<Array<{a, status: 'ok'|'failed', signature: string|null}>>`

- [ ] **Step 1: Write the failing tests** by appending to `src/solana/airdrop.test.js`.

Require `./airdrop` inside each test body, not at the top of the file. `airdrop.js` loads `db/index`, which captures `MONGODB_URI` at load time. A top-level require would run before the first test sets the in-memory mongod URI.

```js
test('sendWithFallback: whole batch succeeds in one send', async () => {
  const { sendWithFallback } = require('./airdrop');
  const calls = [];
  const res = await sendWithFallback([{ owner: 'A' }, { owner: 'B' }], async (b) => { calls.push(b.length); return 'sig'; });
  assert.deepStrictEqual(calls, [2]);
  assert.deepStrictEqual(res.map((r) => r.status), ['ok', 'ok']);
});

test('sendWithFallback: a failed batch retries one by one so one bad account can’t sink it', async () => {
  const { sendWithFallback } = require('./airdrop');
  const send = async (b) => {
    if (b.some((a) => a.owner === 'BAD')) throw new Error('account frozen');
    return `sig-${b.map((a) => a.owner).join('')}`;
  };
  const res = await sendWithFallback([{ owner: 'A' }, { owner: 'BAD' }, { owner: 'C' }], send);
  assert.deepStrictEqual(res.map((r) => [r.a.owner, r.status, r.signature]), [
    ['A', 'ok', 'sig-A'],
    ['BAD', 'failed', null],
    ['C', 'ok', 'sig-C'],
  ]);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/solana/airdrop.test.js`
Expected: FAIL with `sendWithFallback is not a function`.

- [ ] **Step 3: Implement** by replacing `src/solana/airdrop.js` with:

```js
'use strict';
const { PublicKey } = require('@solana/web3.js');
const { getMint, getTransferHook } = require('@solana/spl-token');
const config = require('../config');
const repo = require('../db/repository');
const { connection, wallet } = require('./connection');
const {
  getMintInfo,
  sendIxs,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction,
} = require('./tokens');

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Send one batch; if it fails, retry each recipient alone so a single bad
// account (frozen by the issuer, etc.) can't fail everyone in its batch.
async function sendWithFallback(batch, sendFn) {
  try {
    const signature = await sendFn(batch);
    return batch.map((a) => ({ a, status: 'ok', signature }));
  } catch (err) {
    if (batch.length === 1) {
      console.error(`[airdrop] ${batch[0].owner} failed: ${err.message}`);
      return [{ a: batch[0], status: 'failed', signature: null }];
    }
    console.error(`[airdrop] batch of ${batch.length} failed (${err.message}) — retrying one by one`);
    const out = [];
    for (const a of batch) {
      try {
        out.push({ a, status: 'ok', signature: await sendFn([a]) });
      } catch (e) {
        console.error(`[airdrop] ${a.owner} failed: ${e.message}`);
        out.push({ a, status: 'failed', signature: null });
      }
    }
    return out;
  }
}

// Live sender for `rewardMint`. Token-2022 mints may carry a transfer hook (NVDAx
// has an unset hook slot its issuer can fill at any time); when one is set, the
// transfer needs the hook's extra accounts, which the hook-aware builder resolves.
async function makeLiveSender(rewardMint) {
  const mintPk = new PublicKey(rewardMint);
  const { decimals, programId } = await getMintInfo(connection, rewardMint);
  const hook = getTransferHook(await getMint(connection, mintPk, 'confirmed', programId));
  const hasHook = !!(hook && !hook.programId.equals(PublicKey.default));
  const source = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, programId);

  const send = async (batch) => {
    const ixs = [];
    for (const a of batch) {
      const owner = new PublicKey(a.owner);
      const dest = getAssociatedTokenAddressSync(mintPk, owner, true, programId);
      const amount = BigInt(a.amountRaw);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, dest, owner, mintPk, programId));
      ixs.push(
        hasHook
          ? await createTransferCheckedWithTransferHookInstruction(connection, source, mintPk, dest, wallet.publicKey, amount, decimals, [], 'confirmed', programId)
          : createTransferCheckedInstruction(source, mintPk, dest, wallet.publicKey, amount, decimals, [], programId)
      );
    }
    return sendIxs(connection, wallet, ixs, { label: `airdrop batch (${batch.length})` });
  };
  return { send, decimals };
}

// Airdrop a reward token to allocations [{owner, amountRaw}], batching transfers.
// Records every recipient send (repo.addAirdrop). Returns { sent, failed }.
// amount_ui is raw / 10^decimals — NVDAx's scaled-UI multiplier is not applied.
async function airdropToken({ rewardMint, allocations, cycleId }) {
  if (allocations.length === 0) return { sent: 0, failed: 0 };

  let decimals = 6;
  let send = async () => fakeSig('airdrop');
  if (!config.dryRun) ({ send, decimals } = await makeLiveSender(rewardMint));
  const uiOf = (raw) => Number(raw) / 10 ** decimals;

  let sent = 0;
  let failed = 0;
  for (const batch of chunk(allocations, config.airdropBatchSize)) {
    for (const r of await sendWithFallback(batch, send)) {
      await repo.addAirdrop({
        cycleId,
        rewardMint,
        recipient: r.a.owner,
        amountRaw: r.a.amountRaw,
        amountUi: uiOf(r.a.amountRaw),
        signature: r.signature,
        status: r.status,
      });
      if (r.status === 'ok') sent += 1;
      else failed += 1;
    }
  }
  return { sent, failed };
}

module.exports = { airdropToken, sendWithFallback };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/solana/airdrop.test.js && npm test`
Expected: PASS, including the original DRY_RUN "one send per allocation" test.

- [ ] **Step 5: Commit**

```bash
git add src/solana/airdrop.js src/solana/airdrop.test.js
git commit -m "feat(airdrop): per-recipient retry on batch failure, transfer-hook aware

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Holder exclusions — bonding curve and marketing wallet

**Files:**
- Modify: `src/solana/exclude.js` (full rewrite below)
- Test: `src/solana/exclude.test.js` (rewrite)

**Interfaces:**
- Consumes: `config.marketingWallet` (Task 1); `bondingCurvePda`, `bondingCurveV2Pda` and `canonicalPumpPoolPda` from `@pump-fun/pump-sdk`.
- Produces:
  - `buildExcludeSet(holderMint) → Promise<Set<string>>`
  - `derivedExcludes(holderMint) → string[]`, which is pure PDA derivation and returns `[]` for an invalid mint.
- The set no longer contains `config.devWallet`.

- [ ] **Step 1: Write the failing test** by replacing `src/solana/exclude.test.js` with:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

// A real, valid base58 mint so the PDAs derive.
const MINT = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP';

test('buildExcludeSet: wallet, marketing wallet, AIRDROP_EXCLUDE, and pump.fun curve/pool PDAs', async () => {
  process.env.DRY_RUN = 'true';
  process.env.MARKETING_WALLET = 'Mkt1111111111111111111111111111111111111111';
  process.env.AIRDROP_EXCLUDE = 'GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52, Other22222222222222222222222222222222222222';
  delete require.cache[require.resolve('../config')];
  const { walletPubkey } = require('./connection');
  const { buildExcludeSet } = require('./exclude');
  const { bondingCurvePda, canonicalPumpPoolPda } = require('@pump-fun/pump-sdk');
  const { PublicKey } = require('@solana/web3.js');

  try {
    const set = await buildExcludeSet(MINT);
    assert.ok(set.has(walletPubkey()), 'operating wallet excluded');
    assert.ok(set.has('Mkt1111111111111111111111111111111111111111'), 'marketing wallet excluded');
    assert.ok(set.has('GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52'));
    assert.ok(set.has('Other22222222222222222222222222222222222222'));
    assert.ok(set.has(bondingCurvePda(new PublicKey(MINT)).toBase58()), 'bonding-curve reserve excluded');
    assert.ok(set.has(canonicalPumpPoolPda(new PublicKey(MINT)).toBase58()), 'canonical pool excluded');
  } finally {
    delete process.env.MARKETING_WALLET;
    delete process.env.AIRDROP_EXCLUDE;
    delete require.cache[require.resolve('../config')];
  }
});

test('derivedExcludes returns [] for an invalid mint instead of throwing', () => {
  const { derivedExcludes } = require('./exclude');
  assert.deepStrictEqual(derivedExcludes('not-a-mint'), []);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/solana/exclude.test.js`
Expected: FAIL. The marketing wallet and the bonding-curve PDA are missing.

- [ ] **Step 3: Implement** by replacing `src/solana/exclude.js` with:

```js
'use strict';

const { PublicKey } = require('@solana/web3.js');
const config = require('../config');
const { walletPubkey } = require('./connection');

// pump.fun accounts that hold the holder mint's supply but aren't people: the
// bonding-curve PDAs (the curve reserve's token account is owned by the curve —
// before graduation it holds most of the supply and would swallow the rewards)
// and the canonical PumpSwap pool. PDA derivation is pure (no RPC), so this
// can't fail a cycle; an invalid mint just yields nothing.
function derivedExcludes(holderMint) {
  let mint;
  try {
    mint = new PublicKey(holderMint);
  } catch (_err) {
    return [];
  }
  const { bondingCurvePda, bondingCurveV2Pda, canonicalPumpPoolPda } = require('@pump-fun/pump-sdk');
  return [bondingCurvePda(mint), bondingCurveV2Pda(mint), canonicalPumpPoolPda(mint)].map((pk) => pk.toBase58());
}

// Owners that must never receive an airdrop: the operating wallet, the
// marketing wallet, any manually-listed vaults (AIRDROP_EXCLUDE), and the
// pump.fun curve/pool PDAs for the holder mint.
async function buildExcludeSet(holderMint) {
  const set = new Set();
  const add = (v) => { if (v) set.add(typeof v === 'string' ? v : v.toBase58()); };

  add(walletPubkey());
  add(config.marketingWallet);
  for (const a of config.airdropExclude) add(a);
  if (holderMint) for (const a of derivedExcludes(holderMint)) add(a);
  return set;
}

module.exports = { buildExcludeSet, derivedExcludes };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/solana/exclude.test.js && npm test`
Expected: PASS. The cycle test still passes: its sim mint may be invalid base58, in which case `derivedExcludes` returns `[]`.

- [ ] **Step 5: Commit**

```bash
git add src/solana/exclude.js src/solana/exclude.test.js
git commit -m "feat(exclude): never airdrop to the bonding curve, pool, or marketing wallet

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The Super Neko cycle

**Files:**
- Modify: `src/jobs/cycle.js` (full rewrite below)
- Modify: `src/db/repository.js` (`createCycle` L20-41 and the `finishCycle` allowlist L46-65 only)
- Test: `src/jobs/cycle.test.js` (rewrite)

**Interfaces:**
- Consumes:
  - `pumpfun.buyToken(mint, sol) → {signature, tokensBought, tokensBoughtRaw}` and `pumpfun.claimCreatorFees() → {signature, solClaimed}`
  - `mintguard.checkRewardMint` (Task 5)
  - `computeWeightedAllocations` and `minRawForUsd` (Task 4)
  - `airdrop.airdropToken` (Task 7)
  - `burn.burnBought`, `marketing.computeMarketingSend`, `marketing.getWalletSolBalance` and `marketing.sendMarketing` (Task 6)
  - `getFreshSolPriceUsd` (Task 2)
  - `buildExcludeSet` (Task 8)
- Calls go through module objects (`pumpfun.buyToken(...)`, not destructured) so tests can stub them.
- Produces:
  - `runCycle() → cycle with steps`. The cycle document has fields `status` ('complete'|'partial'|'failed'|'skipped'), `mode: 'rewards'`, `sol_claimed`, `eligible_holders`, `total_holders`, `marketing_sol` (number), `sn_burned` (number, UI units) and `legs` (array).
  - Step names: `claim`, `guard`, `buy` (detail.leg is 'nvdax'|'si'|'burn'), `airdrop`, `burn`, `marketing`, `error`.

- [ ] **Step 1: Write the failing test** by replacing `src/jobs/cycle.test.js` with:

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SN = 'SNmint1111111111111111111111111111111111111';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const SI = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP';

let mongod;
let db;
let repo;
let simvault;
let pumpfun;
let mintguard;
let runCycle;

// One mongod per file: db/index captures the URI at module load.
before(async () => {
  process.env.DRY_RUN = 'true';
  process.env.SIMULATE_GRADUATED = 'true';
  process.env.TOKEN_MINT = SN;
  delete process.env.MARKETING_WALLET;
  delete require.cache[require.resolve('../config')];
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_cycle';
  db = require('../db/index');
  repo = require('../db/repository');
  simvault = require('../solana/simvault');
  pumpfun = require('../solana/pumpfun');
  mintguard = require('../solana/mintguard');
  ({ runCycle } = require('./cycle'));
  await db.connect();
});

after(async () => {
  await db.close();
  await mongod.stop();
  delete require.cache[require.resolve('../config')];
});

const count = (cycle, name) => cycle.steps.filter((s) => s.name === name).length;

test('full cycle: NVDAx + SI rewards, $SN buyback & burn, marketing kept in dev wallet', async () => {
  simvault.reset(1.5);
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'complete');
  assert.strictEqual(count(cycle, 'claim'), 1);
  assert.strictEqual(count(cycle, 'buy'), 3, 'NVDAx, SI, $SN buyback');
  assert.strictEqual(count(cycle, 'airdrop'), 2);
  assert.strictEqual(count(cycle, 'burn'), 1);
  assert.strictEqual(count(cycle, 'marketing'), 1);

  const buys = cycle.steps.filter((s) => s.name === 'buy');
  assert.deepStrictEqual(buys.map((b) => [b.detail.leg, b.detail.solSpent]), [['nvdax', 0.3], ['si', 0.3], ['burn', 0.15]]);
  assert.strictEqual(buys[2].detail.buyMint, SN, 'buyback buys $SN');

  const mkt = cycle.steps.find((s) => s.name === 'marketing');
  assert.strictEqual(mkt.status, 'kept', 'no MARKETING_WALLET → stays in the dev wallet');
  assert.strictEqual(cycle.marketing_sol, 0.75);
  assert.ok(cycle.sn_burned > 0, 'records $SN burned');

  const { items } = await repo.getAirdrops(500, 0);
  const mints = new Set(items.filter((a) => a.cycle_id === cycle.id).map((a) => a.reward_mint));
  assert.deepStrictEqual([...mints].sort(), [NVDAX, SI].sort());
});

test('a failing leg is isolated: cycle is partial, the other legs still run', async () => {
  const realBuy = pumpfun.buyToken;
  pumpfun.buyToken = async (mint, sol) => {
    if (mint === SI) throw new Error('simulated SI outage');
    return realBuy(mint, sol);
  };
  try {
    simvault.reset(1.5);
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'partial');
    const err = cycle.steps.find((s) => s.name === 'error');
    assert.strictEqual(err.detail.leg, 'si');
    assert.strictEqual(count(cycle, 'airdrop'), 1, 'NVDAx still airdropped');
    assert.strictEqual(count(cycle, 'burn'), 1, 'burn still ran');
    assert.strictEqual(count(cycle, 'marketing'), 1, 'marketing still ran');
  } finally {
    pumpfun.buyToken = realBuy;
  }
});

test('a tripped mint guard skips only that token and is not a failure', async () => {
  const realCheck = mintguard.checkRewardMint;
  mintguard.checkRewardMint = async (mint) => (mint === NVDAX ? { ok: false, reason: 'mint is paused' } : { ok: true });
  try {
    simvault.reset(1.5);
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    const guard = cycle.steps.find((s) => s.name === 'guard');
    assert.strictEqual(guard.status, 'skipped');
    assert.strictEqual(guard.detail.leg, 'nvdax');
    assert.strictEqual(count(cycle, 'buy'), 2, 'SI + buyback only');
    assert.strictEqual(count(cycle, 'airdrop'), 1);
  } finally {
    mintguard.checkRewardMint = realCheck;
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/jobs/cycle.test.js`
Expected: FAIL. The old cycle does one buy of `cupsyMint`, or throws because `CUPSY_MINT` is required.

- [ ] **Step 3: Update the repository**

In `src/db/repository.js`, replace the `insertOne` document in `createCycle` with:

```js
  await db.collection('cycles').insertOne({
    id,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    sol_claimed: null,
    marketing_sol: null,
    sn_burned: null,
    dry_run: dryRun ? 1 : 0,
    note: null,
    error: null,
  });
```

Replace the `allowed` array in `finishCycle` with:

```js
  const allowed = [
    'status',
    'mode',
    'sol_claimed',
    'eligible_holders',
    'total_holders',
    'marketing_sol',
    'sn_burned',
    'legs',
    'note',
    'error',
  ];
```

- [ ] **Step 4: Implement the cycle** by replacing `src/jobs/cycle.js` with:

```js
'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { connection } = require('../solana/connection');
const pumpfun = require('../solana/pumpfun');
const { snapshotEligibleHolders } = require('../solana/holders');
const { computeWeightedAllocations, minRawForUsd } = require('../services/distribution');
const airdrop = require('../solana/airdrop');
const { getMintInfo, getTokenSupplyRaw } = require('../solana/tokens');
const { buildExcludeSet } = require('../solana/exclude');
const mintguard = require('../solana/mintguard');
const burn = require('../solana/burn');
const marketing = require('../solana/marketing');
const { getFreshSolPriceUsd } = require('../solana/price');

// SOL for a leg: pct% of the claim, 6 dp (what the buy step records).
const share = (solClaimed, pct) => +(solClaimed * (pct / 100)).toFixed(6);

async function recordLegFailure(cycleId, leg, err) {
  const message = err && err.message ? err.message : String(err);
  console.log(`[cycle ${cycleId}] [${leg}] FAILED: ${message}`);
  await repo.addStep({ cycleId, name: 'error', status: 'failed', detail: { leg, message } });
}

// Rewards: snapshot $SN holders ONCE, then for each reward token buy it and
// airdrop it pro-rata. Distribution uses only what THIS cycle bought. Each token
// is isolated — a guard trip or failure skips only that token, and its SOL
// stays in the wallet.
async function runRewardsLeg(cycleId, solClaimed, solPriceUsd) {
  const log = (m) => console.log(`[cycle ${cycleId}] [rewards] ${m}`);
  const holderMint = config.tokenMint;

  const decimals = config.dryRun ? 6 : (await getMintInfo(connection, holderMint)).decimals;
  const minHoldRaw = BigInt(Math.trunc(config.minHold)) * 10n ** BigInt(decimals);
  const exclude = await buildExcludeSet(holderMint);
  const { holders, totalHolders } = await snapshotEligibleHolders({ mint: holderMint, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : await getTokenSupplyRaw(connection, holderMint);

  const rewards = [
    { leg: 'nvdax', mint: config.nvdaxMint, pct: config.nvdaxPct },
    { leg: 'si', mint: config.siMint, pct: config.siPct },
  ];
  const results = [];
  for (const r of rewards) {
    const solAmount = share(solClaimed, r.pct);
    if (!(solAmount > 0) || !r.mint) {
      results.push({ leg: r.leg, status: 'skipped', reason: 'disabled' });
      continue;
    }
    if (holders.length === 0) {
      results.push({ leg: r.leg, status: 'skipped', reason: 'no eligible holders' });
      continue;
    }
    try {
      const guard = await mintguard.checkRewardMint(r.mint);
      if (!guard.ok) {
        await repo.addStep({ cycleId, name: 'guard', status: 'skipped', detail: { leg: r.leg, mint: r.mint, reason: guard.reason } });
        log(`${r.leg} skipped: ${guard.reason}`);
        results.push({ leg: r.leg, status: 'skipped', reason: guard.reason });
        continue;
      }

      const buy = await pumpfun.buyToken(r.mint, solAmount);
      await repo.addStep({
        cycleId,
        name: 'buy',
        status: 'ok',
        signature: buy.signature,
        detail: { leg: r.leg, buyMint: r.mint, solSpent: solAmount, tokensBought: buy.tokensBought },
      });

      const boughtRaw = BigInt(buy.tokensBoughtRaw || '0');
      const minAmountRaw = minRawForUsd({
        minUsd: config.minAirdropUsd,
        solSpent: solAmount,
        solPriceUsd,
        tokensBoughtRaw: boughtRaw,
      });
      const allocations = computeWeightedAllocations(holders, boughtRaw.toString(), {
        capPct,
        supplyRaw,
        clusters: config.clusters,
        minAmountRaw,
      });
      const res = await airdrop.airdropToken({ rewardMint: r.mint, allocations, cycleId });
      await repo.addStep({
        cycleId,
        name: 'airdrop',
        status: res.failed ? 'failed' : 'ok',
        detail: { leg: r.leg, rewardMint: r.mint, recipients: allocations.length, sent: res.sent, failed: res.failed },
      });
      log(`${r.leg}: bought ${buy.tokensBought} with ${solAmount} SOL, sent=${res.sent} failed=${res.failed}`);
      results.push({ leg: r.leg, status: res.failed ? 'failed' : 'ok', sent: res.sent, failed: res.failed });
    } catch (err) {
      await recordLegFailure(cycleId, r.leg, err);
      results.push({ leg: r.leg, status: 'failed', reason: err.message });
    }
  }
  return { results, eligibleHolders: holders.length, totalHolders };
}

// Buyback & burn: buy $SN with BURN_PCT and burn exactly what was bought.
async function runBurnLeg(cycleId, solClaimed) {
  const solAmount = share(solClaimed, config.burnPct);
  if (!(solAmount > 0)) return { leg: 'burn', status: 'skipped', reason: 'disabled' };
  try {
    const buy = await pumpfun.buyToken(config.tokenMint, solAmount);
    await repo.addStep({
      cycleId,
      name: 'buy',
      status: 'ok',
      signature: buy.signature,
      detail: { leg: 'burn', buyMint: config.tokenMint, solSpent: solAmount, tokensBought: buy.tokensBought },
    });
    const b = await burn.burnBought(config.tokenMint, buy.tokensBoughtRaw || '0');
    await repo.addStep({
      cycleId,
      name: 'burn',
      status: 'ok',
      signature: b.signature,
      detail: { leg: 'burn', mint: config.tokenMint, burnedRaw: b.burnedRaw, tokensBurned: buy.tokensBought },
    });
    console.log(`[cycle ${cycleId}] [burn] bought + burned ${buy.tokensBought} $SN with ${solAmount} SOL`);
    return { leg: 'burn', status: 'ok', tokensBurned: buy.tokensBought };
  } catch (err) {
    await recordLegFailure(cycleId, 'burn', err);
    return { leg: 'burn', status: 'failed', reason: err.message };
  }
}

// Marketing — the reserve. Runs last so it can pay out net of the real cost of
// every other leg (see marketing.computeMarketingSend). DRY_RUN has no real
// balances, so it pays the full share.
async function runMarketingLeg(cycleId, solClaimed, balanceBeforeSol) {
  try {
    const cap = share(solClaimed, config.marketingPct);
    const balanceAfterSol = await marketing.getWalletSolBalance();
    const solMarketing =
      balanceBeforeSol == null || balanceAfterSol == null
        ? cap
        : marketing.computeMarketingSend({ solClaimed, marketingPct: config.marketingPct, balanceBeforeSol, balanceAfterSol });
    const m = await marketing.sendMarketing(solMarketing);
    await repo.addStep({
      cycleId,
      name: 'marketing',
      status: m.status,
      signature: m.signature,
      detail: { leg: 'marketing', solShare: cap, solMarketing, solSent: m.solSent, recipient: m.recipient },
    });
    console.log(`[cycle ${cycleId}] [marketing] ${m.status} ${solMarketing} SOL (share ${cap}) → ${m.recipient}`);
    return { leg: 'marketing', status: m.status, solMarketing };
  } catch (err) {
    await recordLegFailure(cycleId, 'marketing', err);
    return { leg: 'marketing', status: 'failed', reason: err.message };
  }
}

/**
 * One Super Neko cycle (fired by the scheduler once unclaimed creator fees are
 * worth MIN_CLAIM_USD):
 *   claim $SN creator fees
 *   rewards: buy NVDAx (NVDAX_PCT) + $SI (SI_PCT), airdrop each pro-rata to $SN holders
 *   buyback & burn: buy $SN (BURN_PCT) and burn it
 *   marketing (MARKETING_PCT, the reserve): send net of gas/rent to MARKETING_WALLET
 * Legs are isolated: one failing marks the cycle 'partial', the rest still run.
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (m) => console.log(`[cycle ${id}] ${m}`);
  try {
    if (!config.tokenMint) throw new Error('TOKEN_MINT ($SN) is required');

    const balanceBeforeSol = await marketing.getWalletSolBalance();
    const claim = await pumpfun.claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { solClaimed: claim.solClaimed } });
    log(`claimed ${claim.solClaimed} SOL`);
    if (!(claim.solClaimed > 0)) {
      await repo.finishCycle(id, { status: 'skipped', sol_claimed: claim.solClaimed, note: 'nothing claimed' });
      return repo.getCycleWithSteps(id);
    }

    const solPriceUsd = await getFreshSolPriceUsd();
    let rewards;
    try {
      rewards = await runRewardsLeg(id, claim.solClaimed, solPriceUsd);
    } catch (err) {
      // Snapshot/setup failure — both reward tokens are lost for this cycle.
      await recordLegFailure(id, 'rewards', err);
      rewards = { results: [{ leg: 'rewards', status: 'failed', reason: err.message }], eligibleHolders: null, totalHolders: null };
    }
    const burnRes = await runBurnLeg(id, claim.solClaimed);
    const mkt = await runMarketingLeg(id, claim.solClaimed, balanceBeforeSol);

    const legs = [...rewards.results, burnRes, mkt];
    const anyFailed = legs.some((l) => l.status === 'failed');
    await repo.finishCycle(id, {
      status: anyFailed ? 'partial' : 'complete',
      mode: 'rewards',
      sol_claimed: claim.solClaimed,
      eligible_holders: rewards.eligibleHolders,
      total_holders: rewards.totalHolders,
      marketing_sol: mkt.solMarketing ?? 0,
      sn_burned: burnRes.tokensBurned ?? 0,
      legs,
      note: legs.map((l) => `${l.leg}=${l.status}`).join(' '),
    });
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle };
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test src/jobs/cycle.test.js && npm test`
Expected: all PASS. `scheduler.test.js` still passes because it only asserts that a cycle ran.

Also check that nothing imports the removed `runRewardLeg`: `grep -rn "runRewardLeg" src scripts` should return no output.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/cycle.js src/jobs/cycle.test.js src/db/repository.js
git commit -m "feat(cycle): NVDAx + SI rewards, \$SN buyback & burn, marketing reserve, isolated legs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: API — stats, /summary, /burns, activity, /api/status

**Files:**
- Modify: `src/db/repository.js` (`getStats` L132-171; add `getBurns`; exports)
- Modify: `src/services/format.js` (TOKEN_SYMBOL, activity mappers, `toPublicSummary`)
- Modify: `src/routes/public.js` (`tokenToMint`, the `/airdrops` comment, `loadSummary`, new `/burns`)
- Modify: `src/routes/status.js` (TOKEN_SYMBOL, `token`, `config`, `totals`)
- Modify: `server.js` (add `'GET  /burns'` to the endpoints list after `'GET  /airdrops'`)
- Create: `src/db/burns.test.js`
- Test: `src/services/format.test.js` (update the summary tests; add an activity test)

**Interfaces:**
- Consumes: the cycle fields `marketing_sol` and `sn_burned`, and burn step `detail {mint, burnedRaw, tokensBurned}` (Task 9).
- Produces:
  - `repo.getStats() → {cycles, completed, partial, failed, skipped, total_sol_claimed, total_marketing_sol, total_sn_burned}`
  - `repo.getBurns(limit, offset) → {total, items: [{cycleId, mint, tokensBurned, burnedRaw, signature, at}]}`
  - `toPublicSummary({stats, byMint, eligibleHolders, totalHolders, price, nvdaxMint, siMint, marketCapUsd}) → {creatorFeesClaimedSol, creatorFeesClaimedUsd, marketCapUsd, nvdaxDistributed, siDistributed, snBurned, marketingSol, holders, totalHolders, distributions}`

- [ ] **Step 1: Write the failing tests**

`src/db/burns.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('getStats sums marketing + burned; getBurns lists ok burns newest first', async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_burns';
  const db = require('./index');
  const repo = require('./repository');
  await db.connect();
  try {
    const c1 = await repo.createCycle({ dryRun: true });
    await repo.finishCycle(c1, { status: 'complete', sol_claimed: 1, marketing_sol: 0.49, sn_burned: 1000, legs: [{ leg: 'burn', status: 'ok' }] });
    const c2 = await repo.createCycle({ dryRun: true });
    await repo.finishCycle(c2, { status: 'partial', sol_claimed: 2, marketing_sol: 0.99, sn_burned: 2500 });

    await repo.addStep({ cycleId: c1, name: 'burn', status: 'ok', signature: 'b1', detail: { mint: 'SN', burnedRaw: '1000000000', tokensBurned: 1000 } });
    await repo.addStep({ cycleId: c2, name: 'burn', status: 'failed', signature: null, detail: { mint: 'SN' } });
    await repo.addStep({ cycleId: c2, name: 'burn', status: 'ok', signature: 'b2', detail: { mint: 'SN', burnedRaw: '2500000000', tokensBurned: 2500 } });

    const stats = await repo.getStats();
    assert.strictEqual(stats.cycles, 2);
    assert.strictEqual(stats.completed, 1);
    assert.strictEqual(stats.partial, 1);
    assert.strictEqual(stats.total_sol_claimed, 3);
    assert.strictEqual(+stats.total_marketing_sol.toFixed(6), 1.48);
    assert.strictEqual(stats.total_sn_burned, 3500);

    const burns = await repo.getBurns(10, 0);
    assert.strictEqual(burns.total, 2, 'failed burn excluded');
    assert.deepStrictEqual(burns.items.map((b) => b.signature), ['b2', 'b1']);
    assert.strictEqual(burns.items[0].tokensBurned, 2500);

    const withLegs = await repo.getCycleWithSteps(c1);
    assert.deepStrictEqual(withLegs.legs, [{ leg: 'burn', status: 'ok' }]);
  } finally {
    await db.close();
    await mongod.stop();
  }
});
```

In `src/services/format.test.js`, replace the two `toPublicSummary` tests with the following, and append the activity test:

```js
test('toPublicSummary reports NVDAx + SI distributed, $SN burned and marketing', () => {
  const out = toPublicSummary({
    stats: { total_sol_claimed: 10, total_sn_burned: 5000, total_marketing_sol: 4.9 },
    byMint: { NVDAX: { sends: 5, totalUi: 2, holders: 5 }, SI: { sends: 4, totalUi: 900, holders: 4 } },
    eligibleHolders: 42,
    totalHolders: 1200,
    price: 150,
    nvdaxMint: 'NVDAX',
    siMint: 'SI',
    marketCapUsd: 55_620_000,
  });
  assert.strictEqual(out.creatorFeesClaimedSol, 10);
  assert.strictEqual(out.creatorFeesClaimedUsd, 1500);
  assert.strictEqual(out.nvdaxDistributed, 2);
  assert.strictEqual(out.siDistributed, 900);
  assert.strictEqual(out.snBurned, 5000);
  assert.strictEqual(out.marketingSol, 4.9);
  assert.strictEqual(out.holders, 42);
  assert.strictEqual(out.totalHolders, 1200);
  assert.strictEqual(out.distributions, 9);
  assert.strictEqual(out.marketCapUsd, 55_620_000);
  assert.ok(!('cupsyDistributed' in out), 'cupsyDistributed should be gone');
});

test('toPublicSummary defaults: zeros for no activity, null marketCap/totalHolders', () => {
  const out = toPublicSummary({ stats: {}, byMint: {}, price: 0, nvdaxMint: 'NVDAX', siMint: 'SI' });
  assert.strictEqual(out.marketCapUsd, null);
  assert.strictEqual(out.totalHolders, null);
  assert.strictEqual(out.nvdaxDistributed, 0);
  assert.strictEqual(out.snBurned, 0);
  assert.strictEqual(out.marketingSol, 0);
});

test('activity rows label burn and marketing steps', () => {
  const burn = toPublicActivityRow({ name: 'burn', status: 'ok', detail: { leg: 'burn' }, signature: 's', created_at: '2026-09-30T00:00:00Z' }, 150);
  assert.strictEqual(burn.type, 'burn');
  const mkt = toPublicActivityRow({ name: 'marketing', status: 'kept', detail: { solMarketing: 0.5 }, signature: null, created_at: '2026-09-30T00:00:00Z' }, 150);
  assert.strictEqual(mkt.type, 'marketing');
  assert.strictEqual(mkt.amountSol, 0.5);
  assert.strictEqual(mkt.usdtValue, 75);
  assert.strictEqual(mkt.status, 'kept');
  assert.strictEqual(toActivityRow({ name: 'burn', detail: {} }, 0).type, 'Buyback Burn');
  assert.strictEqual(toActivityRow({ name: 'marketing', status: 'kept', detail: { solMarketing: 0.5 } }, 0).type, 'Marketing');
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test src/db/burns.test.js src/services/format.test.js`
Expected: FAIL. `getBurns` is not a function, `stats.partial` is undefined, and `nvdaxDistributed` is undefined.

- [ ] **Step 3: Implement the repository**

In `src/db/repository.js`, replace `getStats` with:

```js
async function getStats() {
  const db = getDb();
  const [row] = await db
    .collection('cycles')
    .aggregate([
      {
        $group: {
          _id: null,
          cycles: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'complete'] }, 1, 0] } },
          partial: { $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
          total_sol_claimed: { $sum: { $ifNull: ['$sol_claimed', 0] } },
          total_marketing_sol: { $sum: { $ifNull: ['$marketing_sol', 0] } },
          total_sn_burned: { $sum: { $ifNull: ['$sn_burned', 0] } },
        },
      },
      { $project: { _id: 0 } },
    ])
    .toArray();

  return (
    row || {
      cycles: 0,
      completed: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      total_sol_claimed: 0,
      total_marketing_sol: 0,
      total_sn_burned: 0,
    }
  );
}

// Successful buyback burns, newest first (powers GET /burns).
async function getBurns(limit, offset) {
  const db = getDb();
  const filter = { name: 'burn', status: 'ok' };
  const total = await db.collection('steps').countDocuments(filter);
  const rows = await db.collection('steps').find(filter, NO_ID).sort({ id: -1 }).skip(offset).limit(limit).toArray();
  const items = rows.map((s) => ({
    cycleId: s.cycle_id,
    mint: (s.detail && s.detail.mint) ?? null,
    tokensBurned: (s.detail && s.detail.tokensBurned) ?? null,
    burnedRaw: (s.detail && s.detail.burnedRaw) ?? null,
    signature: s.signature,
    at: s.created_at,
  }));
  return { total, items };
}
```

Add `getBurns,` to `module.exports`. In the `getAirdropTotals` comment, change `— $CUPSY —` to `— NVDAx, $SI —`.

- [ ] **Step 4: Implement format, routes and status**

In `src/services/format.js`:
- Change `TOKEN_SYMBOL` to `process.env.TOKEN_SYMBOL || 'SN'`.
- Change the `toActivityRow` comment to `// The cycle emits these step types: claim, guard, buy, airdrop, burn, marketing (+ error). \`leg\` tags which leg a step belongs to.`
- Add these cases to the `toActivityRow` switch, before `default`:

```js
    case 'burn':
      type = 'Buyback Burn';
      break;
    case 'marketing':
      type = 'Marketing';
      amountSol = d.solMarketing ?? null;
      status = s.status === 'kept' ? 'Kept' : 'Completed';
      break;
    case 'guard':
      type = 'Skipped';
      status = 'Skipped';
      break;
```

- Change `PUBLIC_TYPE` to:

```js
const PUBLIC_TYPE = {
  claim: 'claim',
  buy: 'buy',
  airdrop: 'airdrop',
  burn: 'burn',
  marketing: 'marketing',
  guard: 'skipped',
};
```

- Add these cases to the `toPublicActivityRow` switch, before `default`:

```js
    case 'marketing':
      amountSol = d.solMarketing ?? null;
      status = s.status === 'kept' ? 'kept' : 'completed';
      break;
    case 'guard':
      status = 'skipped';
      break;
```

- Replace `toPublicSummary` and its comment with:

```js
// Headline numbers for the frontend: NVDAx + $SI distributed to $SN holders,
// $SN burned, SOL to marketing. byMint is keyed by reward_mint
// (repo.getAirdropTotals): { sends, totalUi, holders }.
function toPublicSummary({ stats, byMint, eligibleHolders = 0, totalHolders = null, price, nvdaxMint, siMint, marketCapUsd = null }) {
  const z = { totalUi: 0, holders: 0, sends: 0 };
  const nvdax = byMint[nvdaxMint] || z;
  const si = byMint[siMint] || z;
  const claimedSol = stats.total_sol_claimed || 0;
  return {
    creatorFeesClaimedSol: claimedSol,
    creatorFeesClaimedUsd: +(claimedSol * (price || 0)).toFixed(2),
    marketCapUsd: marketCapUsd ?? null,
    nvdaxDistributed: nvdax.totalUi,
    siDistributed: si.totalUi,
    snBurned: stats.total_sn_burned || 0,
    marketingSol: stats.total_marketing_sol || 0,
    // currently-eligible holders (latest cycle's snapshot) — NOT the all-time recipient union
    holders: eligibleHolders,
    // ALL wallets with any balance (Solscan-style), from the same snapshot; null until recorded
    totalHolders,
    distributions: nvdax.sends + si.sends,
  };
}
```

In `src/routes/public.js`:
- Replace `tokenToMint` and its comment:

```js
// Map a frontend token tab to its reward_mint. Unknown/unconfigured tokens map to
// a sentinel so the query returns empty (never an unfiltered dump).
function tokenToMint(token) {
  if (!token) return null;
  const map = {
    NVDAX: config.nvdaxMint,
    SI: config.siMint,
    SN: config.tokenMint,
  };
  return map[String(token).toUpperCase()] || '__none__';
}
```

- Change the `/airdrops` comment to `// GET /airdrops?limit=&offset=&token=NVDAX|SI — per-recipient send history,`.
- In `loadSummary`, replace `cupsyMint: config.cupsyMint,` with `nvdaxMint: config.nvdaxMint,` and `siMint: config.siMint,` on separate lines.
- Add this before `module.exports`:

```js
// GET /burns?limit=&offset= — $SN buyback burns, newest first.
router.get('/burns', async (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const { total, items } = await repo.getBurns(limit, offset);
    res.json({ total, limit, offset, items });
  } catch (err) {
    next(err);
  }
});
```

In `src/routes/status.js`:
- Change `TOKEN_SYMBOL` to `process.env.TOKEN_SYMBOL || 'SN'`.
- Replace the `token:` and `config:` objects:

```js
      token: {
        mint: config.tokenMint,
        nvdaxMint: config.nvdaxMint,
        siMint: config.siMint,
        pumpswapPoolId: config.pumpswapPoolId,
      },
      // Cycle parameters (trigger, fee split, eligibility).
      config: {
        pollSchedule: config.pollSchedule,
        minClaimUsd: config.minClaimUsd,
        marketingPct: config.marketingPct,
        burnPct: config.burnPct,
        nvdaxPct: config.nvdaxPct,
        siPct: config.siPct,
        marketingWallet: config.marketingWallet || walletPubkey(),
        rewardCapPct: config.rewardCapPct,
        minHold: config.minHold,
        minAirdropUsd: config.minAirdropUsd,
      },
```

- Add `partial: stats.partial,` to `totals` after `completed`.

In `server.js`, add `'GET  /burns',` after `'GET  /airdrops',` in the endpoints list.

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test src/db/burns.test.js src/services/format.test.js && npm test`
Expected: PASS. Also run `node -e "require('./src/routes/public'); require('./src/routes/status')"`. Expected: exit 0.

Also confirm no legacy fields remain. `grep -rn "sol_spent_buy\|lp_received\|lock_id\|dev_fee\|tokens_bought\|cupsyDistributed" src` should return no output.

- [ ] **Step 6: Commit**

```bash
git add src/db/repository.js src/db/burns.test.js src/services/format.js src/services/format.test.js src/routes/public.js src/routes/status.js server.js
git commit -m "feat(api): NVDAx/SI/burn/marketing totals, /burns, activity labels

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Rebrand and legacy cleanup

**Files:**
- Modify: `src/config.js`: remove legacy keys, rebrand the warning prefix, set the Mongo default, add the CORS default.
- Modify: `src/config.test.js`: assert that legacy keys are gone.
- Modify: `server.js` (name, log prefixes, remove the `/sse-test` route and the `path` import).
- Modify: `package.json` (name, description, scripts); remove the `@streamflow/stream` dependency.
- Delete: `src/solana/devfee.js`, `src/solana/streamflow.js`, `scripts/lock.js`, `scripts/create-pool.js`
- Modify: `scripts/buy.js`, `scripts/check.js`, `scripts/README.md`
- Modify: `.env.example` (full rewrite), `docs/DEPLOY.md`
- Modify: `src/db/airdrops.test.js` (rename the test DB and mints)

**Interfaces:**
- Consumes: everything above. After this task, nothing references `cupsy`, `CUPSY`, `babycupsy`, `minClaimSol`, `devWallet`, `lockYears` or `streamflow`.

- [ ] **Step 1: Write the failing test** by appending to `src/config.test.js`:

```js
test('legacy BABYCUPSY / LP / dev-fee config is gone; branding defaults are Super Neko', () => {
  delete require.cache[require.resolve('./config')];
  const config = require('./config');
  for (const k of ['cupsyMint', 'cupsyBuyPct', 'minClaimSol', 'solSplitBuy', 'solReserve', 'lockYears', 'lockCostSol', 'devFeePct', 'devWallet']) {
    assert.ok(!(k in config), `${k} should be gone`);
  }
  assert.strictEqual(config.mongoDb, 'superneko');
  assert.ok(config.corsOrigins.includes('https://superneko.meme'));
  assert.ok(config.corsOrigins.includes('https://www.superneko.meme'));
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/config.test.js`
Expected: FAIL with `cupsyMint should be gone`.

- [ ] **Step 3: Clean `src/config.js`**

Delete these entries along with their comments:
- the whole `// Economics` block (`solSplitBuy`, `solReserve`, `lockYears`)
- `lockCostSol` and its comment
- the legacy `devFeePct` / `devWallet` block and its comment
- `minClaimSol` and its comment block
- `cupsyMint` and `cupsyBuyPct`

Replace the `// Reward loop. TOKEN_MINT (above) is BABYCUPSY …` comment with:

```js
  // Eligibility + airdrop. TOKEN_MINT (above) is $SN: its creator fees fund each
  // cycle, and its holders receive the NVDAx and $SI rewards.
```

Change `console.warn('[babycupsy] CLUSTERS …` to `console.warn('[superneko] CLUSTERS …`.
Change the Mongo default to `mongoDb: process.env.MONGODB_DB || 'superneko',`.
Change the CORS default string to `'http://localhost:3000,http://localhost:5173,https://superneko.meme,https://www.superneko.meme'`.
Change the `dryRunFeePerPoll` comment's `minClaimSol` references to `the MIN_CLAIM_USD threshold`.

- [ ] **Step 4: Remove dead modules and scripts**

First edit `package.json`. Do this before the uninstall so npm rewrites `package-lock.json` with the new name:
- Set `"name": "superneko"`.
- Set `"description": "Super Neko ($SN) reward engine: pump.fun creator fees → marketing, $SN buyback & burn, and NVDAx + $SI airdrops to $SN holders (DRY_RUN first)."`.
- Delete the `"create-pool"` and `"lock"` script entries.

Then run:

```bash
git rm src/solana/devfee.js src/solana/streamflow.js scripts/lock.js scripts/create-pool.js
npm uninstall @streamflow/stream
```

- [ ] **Step 5: Rebrand `server.js`**

- `name: 'babycupsy'` → `name: 'superneko'`
- Every `[babycupsy]` log prefix → `[superneko]` (7 occurrences)
- Delete the 3-line `/sse-test` block (the comment plus `app.get('/sse-test', …)`) and the now-unused `const path = require('path');`.

- [ ] **Step 6: Fix and update the scripts**

In `scripts/buy.js`, change `: await buyOnCurve(amount);` to `: await buyOnCurve(require('../src/config').tokenMint, amount);`. `buyOnCurve` takes `(mint, solAmount)`.

In `scripts/check.js`, replace the `devFeePct` and `lockYears` lines with:

```js
  console.log('split      :', `marketing ${config.marketingPct}% · burn ${config.burnPct}% · NVDAx ${config.nvdaxPct}% · SI ${config.siPct}%`);
  console.log('marketing  :', config.marketingWallet || '(unset → stays in this wallet)');
  console.log('trigger    :', `$${config.minClaimUsd} of unclaimed fees`);
  console.log('rewards    :', `NVDAx ${config.nvdaxMint} · SI ${config.siMint}`);
```

Delete the `OUR PRE-BOND POOL` section from `scripts/check.js`: the `hr('OUR PRE-BOND POOL')` line through the `our LP mint` log.

Replace `scripts/README.md` with:

````markdown
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

## 5. Go live

Only after 1–4 pass: `npm start`. The scheduler checks every minute and fires a cycle
once unclaimed fees are worth `MIN_CLAIM_USD` ($100). Watch `GET /api/status` and
`GET /api/cycles`.

---

**Safety reminders**
- Start tiny. Confirm each step lands on a Solana explorer before the next.
- NVDAx is a tokenized security (issuer can pause/freeze/claw back; restricted for US
  persons). `NVDAX_PCT=0` disables that leg.
````

- [ ] **Step 7: Rewrite `.env.example`**

```bash
# ── Server ───────────────────────────────────────────────────────────────────
PORT=3000

# DRY_RUN=true simulates all on-chain calls (safe, no funds touched).
# Set to false ONLY after a funded wallet + RPC are configured and validated.
DRY_RUN=true

# ── Solana ───────────────────────────────────────────────────────────────────
# Paid RPC strongly recommended (holder snapshots enumerate every $SN account).
RPC_URL=

# Operating ("dev") wallet — the $SN creator wallet that claims pump.fun fees.
# base58 secret key OR a JSON byte array. Blank in DRY_RUN = ephemeral keypair.
WALLET_PRIVATE_KEY=

# $SN — the Super Neko token on pump.fun (blank until launch), and (optional) its PumpSwap pool.
TOKEN_MINT=
PUMPSWAP_POOL_ID=

# ── On-chain execution (live mode only) ──────────────────────────────────────
SLIPPAGE_PCT=5                    # PumpSwap AMM slippage, percent
CURVE_SLIPPAGE_PCT=5              # bonding-curve buy slippage tolerance, percent
PRIORITY_FEE_MICROLAMPORTS=50000  # compute-unit price for landing txs under load
COMPUTE_UNIT_LIMIT=200000         # compute-unit limit per transaction
# Jupiter buys NVDAx and $SI. The free lite-api needs no key.
JUPITER_API=https://lite-api.jup.ag/swap/v1
JUPITER_API_KEY=
JUPITER_PRIORITY_FEE_LAMPORTS=1000000

# DRY_RUN only: simulate a GRADUATED $SN (exercises the canonical-pool path).
SIMULATE_GRADUATED=false

# ── Trigger ──────────────────────────────────────────────────────────────────
# The creator-fee vault is CHECKED on this timer. A cycle fires once the unclaimed
# balance is worth MIN_CLAIM_USD at the current SOL price (no fresh price → skip).
# POST /api/run ignores the threshold.
POLL_SCHEDULE=* * * * *
MIN_CLAIM_USD=100
# DRY_RUN only: simulated SOL accrued per tick, and the fixed SOL/USD price.
DRY_RUN_FEE_PER_POLL=0.05
DRY_RUN_SOL_PRICE_USD=150

# ── Fee split (percent of each claim; must sum to <= 100) ────────────────────
# Marketing is the reserve: gas + new-account rent are deducted from it.
MARKETING_PCT=50
BURN_PCT=10                       # buy $SN and burn it
NVDAX_PCT=20                      # buy NVDAx, airdrop to $SN holders (0 = disabled)
SI_PCT=20                         # buy $SI, airdrop to $SN holders
# Blank = the marketing share stays in the operating (dev) wallet.
MARKETING_WALLET=

# ── Reward tokens (hard-coded — never look these up by name) ─────────────────
NVDAX_MINT=Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
SI_MINT=DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP
# Skip a leg when the token's transfer fee exceeds this ($SI is 100 today).
MAX_TRANSFER_FEE_BPS=100

# ── Eligibility + airdrop ────────────────────────────────────────────────────
MIN_HOLD=1                        # min $SN balance to qualify
MIN_AIRDROP_USD=0.5               # drop smaller shares (≈ new-account rent), redistribute
REWARD_CAP_PCT=0                  # per-wallet weight cap, % of supply (0 = pure pro-rata)
CLUSTERS=[]                       # JSON array of address-groups treated as one wallet
AIRDROP_BATCH_SIZE=5
# Extra owner addresses excluded from airdrops (the bonding curve, pool and
# marketing wallet are excluded automatically), comma-separated.
AIRDROP_EXCLUDE=
TOKEN_SYMBOL=SN

# ── Storage (MongoDB) ────────────────────────────────────────────────────────
# Local mongod, or a MongoDB Atlas SRV URI (mongodb+srv://user:pass@cluster/...).
MONGODB_URI=
MONGODB_DB=superneko

# ── Frontend / CORS ──────────────────────────────────────────────────────────
# Comma-separated allowlist of browser origins that may call the API.
CORS_ORIGINS=https://superneko.meme,https://www.superneko.meme

# Secret protecting POST /api/run|pause|resume. Blank = open (dev only).
# In production set a long random string; send it as header x-api-key: <key>.
API_KEY=
```

- [ ] **Step 8: Rebrand `docs/DEPLOY.md`**

```bash
sed -i \
  -e 's/api\.babycupsey\.com/api.superneko.meme/g' \
  -e 's/babycupsey\.com/superneko.meme/g' \
  -e 's#github.com/blockfile/cupsy#github.com/blockfile/SN#g' \
  -e 's#/var/www/cupsy#/var/www/sn#g' \
  -e 's/babycupsey/superneko/g' \
  -e 's/babycupsy/superneko/g' \
  docs/DEPLOY.md
```

Then edit by hand:
- Line 1 → `# Super Neko backend — Ubuntu deployment guide`
- Replace the `> **Current deployment:** …` blockquote (4 lines, which mention 165.22.241.154 and Netlify) with:

```markdown
> Point the `api.superneko.meme` A record at your server's IP. The frontend
> `superneko.meme` is hosted separately, so this server only needs the one api
> vhost + cert.
```

- In the "Set at minimum" env block, replace the trigger/mints lines. Replace:

```
# Trigger: check the fee vault every minute, claim once it holds >= 0.25 SOL.
POLL_SCHEDULE=* * * * *
MIN_CLAIM_SOL=0.25
```
with
```
# Trigger: check the fee vault every minute, fire once fees are worth >= $100.
POLL_SCHEDULE=* * * * *
MIN_CLAIM_USD=100
```
and replace
```
TOKEN_MINT=<your BABYCUPSY mint>
CUPSY_MINT=6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump
```
with
```
TOKEN_MINT=<your $SN mint>
# Blank = marketing share stays in the dev wallet
MARKETING_WALLET=
```

- In the go-live checklist, replace the "20% reserve" and mint lines with:

```markdown
- [ ] Funded `WALLET_PRIVATE_KEY` set (the $SN creator wallet; first cycles pay ~0.0016 SOL rent per new NVDAx/$SI recipient, deducted from marketing).
- [ ] `TOKEN_MINT` is the real $SN mint; `NVDAX_MINT` / `SI_MINT` left at their defaults.
```

- [ ] **Step 9: Rebrand the remaining test fixture**

In `src/db/airdrops.test.js`:
- `'babycupsy_test_airdrops'` → `'superneko_test_airdrops'`
- the mint string `'CUPSY'` → `'SI'` (4 occurrences, including the `getAirdrops(…, 'CUPSY')` filter and the `every` check)
- rename the local `cupsy` → `si`
- in the comment, `token=CUPSY|BABYCUPSY|OUR` → `token=NVDAX|SI`

In `src/solana/airdrop.test.js`, change `'our_test_air'` to `'superneko_test_air'`.

- [ ] **Step 10: Verify**

```bash
npm test
grep -rnE "[Cc]upsy|CUPSY|cupsey|minClaimSol|MIN_CLAIM_SOL|\bdevWallet\b|DEV_WALLET|lockYears|streamflow|sse-test" --exclude-dir=node_modules --exclude-dir=pumpsdk --exclude-dir=superpowers . ; echo "grep exit: $?"
node -e "require('./src/routes/public'); require('./src/routes/status'); require('./src/jobs/scheduler')"
```
Expected:
- `npm test` passes in full.
- grep prints nothing and `grep exit: 1`. Matches inside `package-lock.json` are acceptable only if they are unrelated package names. After the uninstall, `@streamflow` must not appear.
- The `node -e` check exits 0.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: rebrand to Super Neko, drop legacy LP/lock/dev-fee code

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review checklist (done while writing this plan)

Each spec requirement mapped to the task that implements it:

| Spec requirement | Task |
|---|---|
| Split 50/10/20/20, validation | 1 |
| $100 USD trigger, no-price skip, stale price | 2, 3 |
| /countdown and /accumulator in USD | 3 |
| Dust filter at the leg's own buy price | 4, 9 |
| Paused / fee-raise guards | 5, 9 |
| Burn exactly what was bought | 6, 9 |
| Marketing is the reserve, capped, kept when blank or dev wallet | 6, 9 |
| Per-recipient retry, transfer-hook-aware transfers | 7 |
| Bonding-curve, pool and marketing exclusions | 8 |
| Leg isolation, `partial` status, `finishCycle` fields | 9 |
| `/summary` fields, `/burns`, `/airdrops?token=NVDAX\|SI`, `/api/status`, activity labels | 10 |
| Rebrand, CORS, DEPLOY.md, legacy removal, `scripts/buy.js` fix | 11 |
