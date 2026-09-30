'use strict';

const { Connection } = require('@solana/web3.js');
const config = require('../config');

// A single shared RPC connection. In DRY_RUN nothing here actually hits the
// network unless a balance read is explicitly requested.
const connection = new Connection(config.rpcUrl, 'confirmed');

const wallet = config.wallet;

function walletPubkey() {
  return wallet.publicKey.toBase58();
}

module.exports = { connection, wallet, walletPubkey };
