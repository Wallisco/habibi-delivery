/**
 * A customer, for counting monthly transacting users (MATU) without holding
 * anything that identifies them.
 *
 * Keychat sends its own customer id with each order. We keep only a keyed
 * fingerprint of it (HMAC-SHA256): the same customer gives the same
 * fingerprint, so distinct customers can be counted, but it can't be turned
 * back into the id, and without the key nobody can check a guess (a phone
 * number, say) against it. The key is random, made on first use, and lives
 * only in this server's database.
 */
import { createHmac, randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_secrets (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class CustomerRefs {
  constructor(db) {
    db.sql.exec(SCHEMA);
    const row = db.sql.prepare("SELECT value FROM app_secrets WHERE name = 'customer_ref_key'").get();
    this.key = row?.value ?? randomBytes(32).toString('hex');
    if (!row) db.sql.prepare("INSERT INTO app_secrets (name, value) VALUES ('customer_ref_key', ?)").run(this.key);
  }

  /** Keychat's customer id -> our fingerprint (null if none sent). */
  ref(customerId) {
    if (customerId == null || customerId === '') return null;
    return 'c_' + createHmac('sha256', this.key).update(String(customerId)).digest('hex').slice(0, 32);
  }
}
