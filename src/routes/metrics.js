'use strict';

const express = require('express');
const { getUnclaimedSol } = require('../services/metrics');
const { getSolPriceUsd } = require('../solana/price');
const { buildUnclaimedPayload } = require('../services/format');

const router = express.Router();

// GET /api/unclaimed — live unclaimed creator fees (cached ~20s), with USD.
// Poll this for the "UNCLAIMED FEES" card, or get it pushed via GET /api/stream.
router.get('/unclaimed', async (req, res, next) => {
  try {
    const [{ sol, at }, price] = await Promise.all([getUnclaimedSol(), getSolPriceUsd()]);
    res.json({
      ...buildUnclaimedPayload(sol, price),
      updatedAt: new Date(at).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
