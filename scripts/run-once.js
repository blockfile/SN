'use strict';

// Run ONE full Super Neko cycle and record it: claim $SN creator fees → buy NVDAx
// + $SI and airdrop them pro-rata to $SN holders → buy back & burn $SN → send the
// marketing share (net of gas/rent). Ignores the MIN_CLAIM_USD threshold; amounts
// are driven by the actual claimed fees. Stop the server first (`pm2 stop
// superneko`): this process doesn't share its in-memory cycle lock.
//   node scripts/run-once.js [--confirm]
const { requireConfirm, hr } = require('./_util');
const db = require('../src/db');
const { runCycle } = require('../src/jobs/cycle');

(async () => {
  hr('RUN ONE FULL CYCLE');
  if (!(await requireConfirm('run one full cycle (claim → rewards airdrop → buyback & burn → marketing)'))) {
    process.exit(0);
  }
  await db.connect();
  const cycle = await runCycle();
  console.log('\ncycle result:');
  console.log(JSON.stringify(cycle, null, 2));
  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
