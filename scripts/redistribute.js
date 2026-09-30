'use strict';

// Airdrop NVDAx or $SI to $SN holders outside a cycle — for rewards a cycle
// couldn't deliver (tokens left in the wallet, or SOL left over from a failed
// buy). Same holder snapshot, exclusions, cap and MIN_AIRDROP_USD floor as a
// cycle; recorded as a 'redistribute' cycle so the site's totals include it.
// Pause the scheduler first (POST /api/pause) so no cycle runs alongside.
//   node scripts/redistribute.js nvdax --amount-raw 4475413 --value-sol 0.086485 [--confirm]
//   node scripts/redistribute.js si --buy-sol 0.0865 [--confirm]
const { requireConfirm, hr, arg, flagValue } = require('./_util');
const db = require('../src/db');
const { redistribute } = require('../src/jobs/redistribute');

(async () => {
  const token = String(arg(0) || '').toLowerCase();
  const opts = {
    token,
    amountRaw: flagValue('--amount-raw'),
    valueSol: Number(flagValue('--value-sol')),
    buySol: Number(flagValue('--buy-sol')),
  };
  hr(`REDISTRIBUTE ${token.toUpperCase()}`);
  await db.connect();

  const plan = await redistribute({ ...opts, preview: true });
  console.log(`eligible holders: ${plan.eligibleHolders} (of ${plan.totalHolders} total)`);
  if (plan.allocations) {
    console.log(`recipients: ${plan.allocations.length}${plan.allocations.length ? ' — largest:' : ' (every share below MIN_AIRDROP_USD)'}`);
    const largest = [...plan.allocations].sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : -1)).slice(0, 10);
    for (const a of largest) console.log(`  ${a.owner}  ${a.amountRaw} raw`);
  }

  const what = opts.buySol > 0
    ? `buy ${token} with ${opts.buySol} SOL and airdrop it to $SN holders`
    : `airdrop ${opts.amountRaw} raw ${token} from the wallet to $SN holders`;
  if (!(await requireConfirm(what))) {
    await db.close();
    process.exit(0);
  }

  const cycle = await redistribute(opts);
  console.log(`\nresult: ${cycle.status} — ${cycle.note || cycle.error}`);
  for (const s of cycle.steps) console.log(`  ${s.name} ${s.status} ${s.signature || ''}`);
  await db.close();
  process.exit(cycle.status === 'failed' ? 1 : 0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
