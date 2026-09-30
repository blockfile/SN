'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Keypair } = require('@solana/web3.js');

// Boot server.js in a child process. The Mongo URI is invalid on purpose, so a
// boot that gets past the startup checks dies at db.connect() without touching
// the network.
function boot(env) {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      WALLET_PRIVATE_KEY: JSON.stringify(Array.from(Keypair.generate().secretKey)),
      MONGODB_URI: 'invalid://nowhere',
      PORT: '0',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stderr: res.stderr };
}

test('server refuses to start live with no API_KEY (open control endpoints)', () => {
  const { status, stderr } = boot({ DRY_RUN: 'false', API_KEY: '' });
  assert.strictEqual(status, 1);
  assert.match(stderr, /API_KEY is required when DRY_RUN=false/);
});

test('the API_KEY check only applies live, and only when the key is blank', () => {
  for (const env of [{ DRY_RUN: 'true', API_KEY: '' }, { DRY_RUN: 'false', API_KEY: 'k'.repeat(32) }]) {
    const { status, stderr } = boot(env);
    assert.strictEqual(status, 1, 'still dies at the (invalid) Mongo URI');
    assert.doesNotMatch(stderr, /API_KEY is required/);
  }
});
