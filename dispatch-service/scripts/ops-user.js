#!/usr/bin/env node
/**
 * Back-office logins, from the server's shell. Use it for the first admin;
 * after that admins manage logins on the Staff tab.
 *
 *   node scripts/ops-user.js add --email you@feest.co.za --name "Your Name" --role admin
 *   node scripts/ops-user.js password --email you@feest.co.za
 *   node scripts/ops-user.js list
 *
 * Reads DB_PATH like the service (load .env first:  set -a; . ./.env; set +a).
 * Without --password a strong one is generated and printed once.
 */
import { randomBytes } from 'node:crypto';
import { Db } from '../src/db.js';
import { OpsUsers, ROLES } from '../src/opsAuth.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
const usage = () => {
  console.error(`Usage:
  node scripts/ops-user.js add --email <email> --name "<name>" --role <${ROLES.join('|')}> [--password <pw>]
  node scripts/ops-user.js password --email <email> [--password <pw>]
  node scripts/ops-user.js list`);
  process.exit(1);
};

const db = new Db(process.env.DB_PATH ?? './data/dispatch.db');
const users = new OpsUsers(db);
const generated = () => randomBytes(12).toString('base64url');

try {
  if (cmd === 'add') {
    const password = arg('password') ?? generated();
    users.add({ email: arg('email'), name: arg('name'), role: arg('role'), password });
    console.log(`Added ${arg('email')} as ${arg('role')}.`);
    if (!arg('password')) console.log(`Password (shown once): ${password}`);
  } else if (cmd === 'password') {
    const u = users.byEmail(arg('email'));
    if (!u) throw new Error('No login with that email.');
    const password = arg('password') ?? generated();
    users.update(u.id, { password });
    console.log('Password changed; their open sessions were ended.');
    if (!arg('password')) console.log(`New password (shown once): ${password}`);
  } else if (cmd === 'list') {
    for (const u of users.list()) console.log(`${u.active ? ' ' : 'x'} ${u.role.padEnd(8)} ${u.email}  ${u.name}`);
  } else usage();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
