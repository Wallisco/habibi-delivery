/**
 * Partner API keys.
 *
 * Every /v1/keychat/* request must carry `x-api-key`. The server never stores
 * the key itself, only its SHA-256, so a leaked .env or backup does not hand
 * anyone a working key.
 *
 *   PARTNER_API_KEYS=keychat-test:<sha256>,keychat-live:<sha256>
 *
 * Several keys may be live at once. That is how you rotate: add the new one,
 * let the partner switch, remove the old one. Generate with
 * `node scripts/new-partner-key.js <name>`.
 *
 * Fails closed. With no keys configured the partner API refuses everything,
 * so a missing env line can never quietly open the door.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const PARTNER_PREFIX = '/v1/keychat/';

export const hashKey = (key) => createHash('sha256').update(String(key)).digest();

export function parsePartnerKeys(raw = '') {
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const i = entry.lastIndexOf(':');
    const name = entry.slice(0, i).trim();
    const hex = entry.slice(i + 1).trim().toLowerCase();
    if (i < 1 || !/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error(`PARTNER_API_KEYS entry "${entry.slice(0, 20)}..." must be name:<64 hex chars>`);
    }
    return { name, hash: Buffer.from(hex, 'hex') };
  });
}

export function findPartner(keys, presented) {
  if (!presented) return null;
  const h = hashKey(presented);
  let match = null;
  // Check every key so timing does not reveal which one was close.
  for (const k of keys) if (timingSafeEqual(k.hash, h)) match = k;
  return match;
}

/**
 * @param app      Fastify instance
 * @param enabled  false only in unit tests that exercise business logic
 * @param keys     parsed keys (defaults to PARTNER_API_KEYS)
 */
export function registerPartnerAuth(app, { enabled = true, keys = null } = {}) {
  if (!enabled) return;
  const configured = keys ?? parsePartnerKeys(process.env.PARTNER_API_KEYS ?? '');
  if (!configured.length) {
    app.log?.warn?.('PARTNER_API_KEYS is empty: every /v1/keychat/* request will be refused');
  }

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith(PARTNER_PREFIX)) return;
    const partner = findPartner(configured, req.headers['x-api-key']);
    if (!partner) {
      return reply.code(401)
        .header('www-authenticate', 'ApiKey header="x-api-key"')
        .send({ error: 'Missing or invalid API key' });
    }
    req.partner = partner.name;
    req.log?.info?.({ partner: partner.name }, 'partner request');
  });
}
