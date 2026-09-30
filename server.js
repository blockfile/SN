'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const db = require('./src/db');
const { walletPubkey } = require('./src/solana/connection');
const scheduler = require('./src/jobs/scheduler');
const { getSolPriceUsd } = require('./src/solana/price');

const statusRoutes = require('./src/routes/status');
const cycleRoutes = require('./src/routes/cycles');
const controlRoutes = require('./src/routes/control');
const metricsRoutes = require('./src/routes/metrics');
const streamRoutes = require('./src/routes/stream');
const publicRoutes = require('./src/routes/public');

const app = express();

// CORS allowlist — non-browser requests (no Origin) always pass; browsers are
// restricted to config.corsOrigins (or any origin if it contains "*").
const allowAll = config.corsOrigins.includes('*');
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowAll || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`origin ${origin} not allowed by CORS`));
    },
  })
);
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'superneko',
    description:
      `pump.fun creator fees → $SN buyback & burn + NVDAx and $SI rewards for $SN holders (claims once unclaimed fees reach $${config.minClaimUsd})`,
    dryRun: config.dryRun,
    wallet: walletPubkey(),
    endpoints: [
      'GET  /activity',
      'GET  /stats',
      'GET  /summary',
      'GET  /airdrops',
      'GET  /burns',
      'GET  /accumulator',
      'GET  /countdown',
      'GET  /api/status',
      'GET  /api/unclaimed',
      'GET  /api/stream (SSE live push)',
      'GET  /api/cycles',
      'GET  /api/cycles/:id',
      'GET  /api/transactions',
      'POST /api/run',
      'POST /api/pause',
      'POST /api/resume',
    ],
  });
});

app.use('/api', statusRoutes);
app.use('/api', cycleRoutes);
app.use('/api', controlRoutes);
app.use('/api', metricsRoutes);
app.use('/api', streamRoutes);

// Public, frontend-shaped endpoints (GET /activity, GET /stats) for the site.
app.use('/', publicRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[superneko] request error:', err);
  res.status(500).json({ error: err.message });
});

let server;

async function main() {
  // A blank API_KEY leaves POST /api/run open: live, anyone could force fee-paying cycles.
  if (!config.dryRun && !config.apiKey) throw new Error('API_KEY is required when DRY_RUN=false');
  await db.connect();
  console.log(`[superneko] MongoDB connected (${config.mongoDb})`);

  getSolPriceUsd().catch(() => {}); // warm the price cache for USD values

  server = app.listen(config.port, () => {
    console.log(`[superneko] listening on http://localhost:${config.port}`);
    console.log(`[superneko] dryRun=${config.dryRun} wallet=${walletPubkey()}`);
    if (config.walletIsEphemeral) {
      console.log('[superneko] WARNING: using an ephemeral wallet (no WALLET_PRIVATE_KEY set) — dry run only');
    }
    scheduler.start();
  });
}

async function shutdown(signal) {
  console.log(`\n[superneko] ${signal} received, shutting down`);
  if (server) server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[superneko] failed to start:', err);
  process.exit(1);
});

module.exports = app;
