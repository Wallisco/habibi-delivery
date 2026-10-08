/**
 * What is in an order, as the driver sees it at the store: "3 × Pizza,
 * 1 × Coke 500ml". Sent by Keychat on job creation (KEYCHAT_API.md, v1.2).
 *
 *   items: [{ name: "Pizza Margherita", qty: 3 }, { name: "Coke", qty: 1, size: "500ml" }]
 *
 * Optional. Product names only: nothing about the customer belongs here, and
 * anything that does not look like a product line is refused rather than
 * shown to a driver.
 */
export const MAX_ITEMS = 50;
export const MAX_NAME = 60;
export const MAX_SIZE = 20;
export const MAX_QTY = 99;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @returns {{ items: Array<{name, qty, size?}> | null }} or {{ error: string }}
 */
export function parseItems(raw) {
  if (raw == null) return { items: null };
  if (!Array.isArray(raw)) return { error: 'items must be a list' };
  if (raw.length > MAX_ITEMS) return { error: `at most ${MAX_ITEMS} items` };
  const items = [];
  for (const [i, it] of raw.entries()) {
    const where = `items[${i}]`;
    if (!it || typeof it !== 'object') return { error: `${where} must be an object` };
    const name = clean(it.name);
    if (!name) return { error: `${where}.name is required` };
    if (name.length > MAX_NAME) return { error: `${where}.name is longer than ${MAX_NAME} characters` };
    const qty = it.qty == null ? 1 : Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: `${where}.qty must be a whole number from 1 to ${MAX_QTY}` };
    const size = clean(it.size);
    if (size.length > MAX_SIZE) return { error: `${where}.size is longer than ${MAX_SIZE} characters` };
    items.push(size ? { name, qty, size } : { name, qty });
  }
  return { items: items.length ? items : null };
}

/** "3 × Pizza Margherita" / "1 × Coke 500ml" */
export const itemLine = (it) => `${it.qty} × ${it.name}${it.size ? ` ${it.size}` : ''}`;
