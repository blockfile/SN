'use strict';

// Weighted distribution of `totalRaw` base units across holders.
//   holders : [{ owner, balanceRaw }]
//   totalRaw: amount to distribute (string|bigint)
//   opts.capPct  : number|null — cap each person's weight at capPct% of supplyRaw. null = no cap.
//   opts.supplyRaw: total supply (string|bigint) — required when capPct != null.
//   opts.clusters: array of address-groups; each group is ONE person for the cap,
//                  then its reward is split among members pro-rata by member balance.
// Integer math throughout (BigInt). Leftover units are assigned by the
// largest-remainder method so the amounts sum EXACTLY to totalRaw.
function allocateOnce(holders, totalRaw, opts = {}) {
  const total = BigInt(totalRaw.toString());
  if (total <= 0n || !holders || holders.length === 0) return [];

  const { capPct = null, supplyRaw = null, clusters = [] } = opts;

  // owner -> clusterId
  const clusterOf = new Map();
  clusters.forEach((group, i) => {
    for (const addr of group) clusterOf.set(addr, `c${i}`);
  });

  // Group holders; sum cluster balance, keep members for the internal split.
  const groups = new Map(); // id -> { balance, members: [{owner, balance}] }
  for (const h of holders) {
    const bal = BigInt(h.balanceRaw.toString());
    if (bal <= 0n) continue;
    const id = clusterOf.get(h.owner) || `solo:${h.owner}`;
    let g = groups.get(id);
    if (!g) { g = { balance: 0n, members: [] }; groups.set(id, g); }
    g.balance += bal;
    g.members.push({ owner: h.owner, balance: bal });
  }
  if (groups.size === 0) return [];

  const capRaw =
    capPct == null ? null : (BigInt(supplyRaw.toString()) * BigInt(Math.round(capPct * 100))) / 10000n;

  // weight per group (balance, clamped to cap)
  let totalWeight = 0n;
  const groupList = [];
  for (const [id, g] of groups) {
    const weight = capRaw == null ? g.balance : g.balance < capRaw ? g.balance : capRaw;
    if (weight <= 0n) continue;
    groupList.push({ id, weight, balance: g.balance, members: g.members });
    totalWeight += weight;
  }
  if (totalWeight === 0n) return [];

  // largest-remainder allocation of `amount` across `parts` weighted by part.w / wTotal
  function allocate(amount, parts, wTotal) {
    const res = parts.map((p) => {
      const numer = amount * p.w;
      return { key: p.key, amount: numer / wTotal, rem: numer % wTotal };
    });
    let leftover = amount - res.reduce((s, r) => s + r.amount, 0n);
    // stable sort: bigger remainder first, tie-break by key for determinism
    res.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.key < b.key ? -1 : 1));
    for (let i = 0; i < res.length && leftover > 0n; i++) {
      res[i].amount += 1n;
      leftover -= 1n;
    }
    return res;
  }

  // 1) total -> per group, by capped weight
  const groupReward = allocate(
    total,
    groupList.map((g) => ({ key: g.id, w: g.weight })),
    totalWeight
  );
  const rewardById = new Map(groupReward.map((r) => [r.key, r.amount]));

  // 2) each group's reward -> members, by member balance
  const out = [];
  for (const g of groupList) {
    const amount = rewardById.get(g.id) || 0n;
    if (amount <= 0n) continue;
    if (g.members.length === 1) {
      out.push({ owner: g.members[0].owner, amountRaw: amount.toString() });
      continue;
    }
    const memberReward = allocate(
      amount,
      g.members.map((m) => ({ key: m.owner, w: m.balance })),
      g.balance
    );
    for (const m of memberReward) {
      if (m.amount > 0n) out.push({ owner: m.key, amountRaw: m.amount.toString() });
    }
  }
  // deterministic output order
  out.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  return out;
}

// The largest holders (by balance) whose pro-rata shares of `total` all clear
// `min`. Among the top k, the smallest share is total·b_k / (b_1+…+b_k), which
// only shrinks as k grows — so take the longest prefix that still clears.
function largestClearingFloor(holders, total, min) {
  const sorted = holders
    .map((h) => ({ h, bal: BigInt(h.balanceRaw.toString()) }))
    .filter((x) => x.bal > 0n)
    .sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : a.h.owner < b.h.owner ? -1 : 1));
  let sum = 0n;
  let k = 0;
  for (const x of sorted) {
    if (total * x.bal < min * (sum + x.bal)) break;
    sum += x.bal;
    k += 1;
  }
  return sorted.slice(0, k).map((x) => x.h);
}

// Public entry point. opts.minAmountRaw (optional) is the dust floor: pay the
// longest run of largest holders whose pro-rata shares all clear it. Dropping
// every sub-floor share at once is wrong — it also drops holders who would clear
// the floor once the smaller ones are gone (the first live cycle paid one wallet
// the whole pot that way). Caps and clusters can still leave a share under the
// floor; then only the smallest recipient is dropped per pass, so no one who
// would clear is lost. Each pass shrinks the pool, so this terminates. The result
// sums exactly to totalRaw — or is [] when the whole pot is below the floor,
// leaving the tokens in the wallet.
function computeWeightedAllocations(holders, totalRaw, opts = {}) {
  const { minAmountRaw = null, ...rest } = opts;
  if (minAmountRaw == null) return allocateOnce(holders, totalRaw, rest);
  const min = BigInt(minAmountRaw.toString());
  let pool = largestClearingFloor(holders, BigInt(totalRaw.toString()), min);
  for (;;) {
    const out = allocateOnce(pool, totalRaw, rest);
    const dust = out.filter((a) => BigInt(a.amountRaw) < min);
    if (dust.length === 0) return out;
    const smallest = dust.reduce((m, a) => (BigInt(a.amountRaw) < BigInt(m.amountRaw) ? a : m));
    pool = pool.filter((h) => h.owner !== smallest.owner);
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

module.exports = { computeWeightedAllocations, minRawForUsd };
