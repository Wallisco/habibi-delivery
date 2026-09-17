#!/usr/bin/env node
/**
 * Generate a partner API key.
 *
 *   node scripts/new-partner-key.js keychat-test
 *
 * Prints the key ONCE (give it to the partner through a secure channel) and
 * the line to add to PARTNER_API_KEYS in .env (hash only).
 */
import { randomBytes, createHash } from 'node:crypto';

const name = process.argv[2];
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('Usage: node scripts/new-partner-key.js <name>   e.g. keychat-test');
  process.exit(1);
}
const env = name.includes('live') ? 'live' : 'test';
const key = `hbk_${env}_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(key).digest('hex');

console.log(`
Partner:  ${name}

API key (give to the partner, shown once, not stored anywhere):
  ${key}

Add to PARTNER_API_KEYS in .env (comma-separate multiple keys):
  ${name}:${hash}
`);
