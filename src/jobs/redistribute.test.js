'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const SI = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP';

let mongod;
let db;
let repo;
let redistribute;

// One mongod per file: db/index captures the URI at module load.
before(async () => {
  Object.assign(process.env, {
    DRY_RUN: 'true',
    SIMULATE_GRADUATED: 'true',
    TOKEN_MINT: 'SNmint1111111111111111111111111111111111111',
    MARKETING_WALLET: '',
    MIN_HOLD: '1',
    MIN_AIRDROP_USD: '0.5',
    DRY_RUN_SOL_PRICE_USD: '150',
    REWARD_CAP_PCT: '0',
    NVDAX_MINT: NVDAX,
    SI_MINT: SI,
  });
  delete require.cache[require.resolve('../config')];
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'superneko_test_redistribute';
  db = require('../db/index');
  repo = require('../db/repository');
  ({ redistribute } = require('./redistribute'));
  await db.connect();
});

after(async () => {
  await db.close();
  await mongod.stop();
  delete require.cache[require.resolve('../config')];
});

const sum = (allocs) => allocs.reduce((s, a) => s + BigInt(a.amountRaw), 0n);

test('preview plans the airdrop of tokens already in the wallet and writes nothing', async () => {
  const plan = await redistribute({ token: 'nvdax', amountRaw: '4475413', valueSol: 0.086485, preview: true });
  assert.strictEqual(plan.mint, NVDAX);
  assert.strictEqual(plan.eligibleHolders, 2); // DRY_RUN snapshot: 2 eligible holders
  assert.strictEqual(plan.allocations.length, 2);
  assert.strictEqual(sum(plan.allocations), 4475413n, 'distributes exactly the amount given');
  assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'preview records nothing');
  assert.strictEqual((await repo.getAirdrops(10, 0)).total, 0);
});

test('airdrops tokens already in the wallet and records it as a redistribute cycle', async () => {
  const cycle = await redistribute({ token: 'nvdax', amountRaw: '4475413', valueSol: 0.086485 });
  assert.strictEqual(cycle.mode, 'redistribute');
  assert.strictEqual(cycle.status, 'complete');
  assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['airdrop']);
  const { items } = await repo.getAirdrops(50, 0, NVDAX);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items.reduce((s, a) => s + BigInt(a.amount_raw), 0n), 4475413n);
});

test('--buy-sol buys the reward token first, then airdrops exactly what arrived', async () => {
  const cycle = await redistribute({ token: 'si', buySol: 0.0865 });
  assert.strictEqual(cycle.status, 'complete');
  assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['buy', 'airdrop']);
  const buy = cycle.steps[0];
  assert.strictEqual(buy.detail.buyMint, SI);
  assert.strictEqual(buy.detail.solSpent, 0.0865);
  const { items } = await repo.getAirdrops(50, 0, SI);
  assert.ok(items.length > 0);
});

test('rejects an unknown token and a missing amount', async () => {
  await assert.rejects(redistribute({ token: 'pump', amountRaw: '1', valueSol: 1 }), /token must be nvdax or si/);
  await assert.rejects(redistribute({ token: 'nvdax' }), /amountRaw \+ valueSol, or buySol/);
});
