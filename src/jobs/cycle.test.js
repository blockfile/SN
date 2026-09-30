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
