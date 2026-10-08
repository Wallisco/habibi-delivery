/**
 * Does the collection photo show everything on the order?
 *
 * The driver photographs the items at the store; Claude (image understanding)
 * compares the photo with the order's item list and answers complete, missing
 * or unclear. A trial, switched on per store (stores.js). It only ever warns:
 * a wrong answer must never stop a driver collecting.
 *
 * What it can do: count what is visible -- boxes, cups, bottles, cans, brand and
 * size on a label. What it cannot: see inside a closed bag, or tell one pizza
 * from another in a closed box. Those come back as "unclear", not as a guess.
 *
 * Every result records the model, effort, latency and tokens, so the trial
 * report can show accuracy, speed and cost per photo.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

/** The model whose answer the driver sees. */
export const PHOTO_CHECK_MODEL = 'claude-opus-5-5';

/**
 * Models the trial can run, with list prices (US$ per million tokens, for the
 * cost estimate) and what each request may set: Claude Haiku 4.5 takes no
 * effort setting and no server-side refusal fallback.
 */
export const MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', price: { input: 4, output: 20 }, effort: true, fallbacks: true },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', price: { input: 2, output: 10 }, effort: true, fallbacks: true },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', price: { input: 1, output: 5 }, effort: false, fallbacks: false },
};
/** Kept for callers of the first version: the driver-facing model's price. */
export const PRICE_PER_MTOK = MODELS[PHOTO_CHECK_MODEL].price;

/** Models run beside the main one for the trial (PHOTO_CHECK_COMPARE, comma-separated; "none" for none). */
export function compareModels(env = process.env.PHOTO_CHECK_COMPARE) {
  if (env === 'none') return [];
  const list = (env ?? 'claude-sonnet-5-5,claude-haiku-4-5').split(',').map((s) => s.trim()).filter(Boolean);
  return list.filter((m) => MODELS[m] && m !== PHOTO_CHECK_MODEL);
}

/*
 * The answer is written in this order on purpose: first everything visible,
 * counted without reference to the order; then one line per order line; the
 * verdict is worked out here, from those lines, not chosen by the model. An
 * earlier version asked for the verdict first, which let the model commit to
 * "complete" before it had counted -- and it missed a missing item.
 */
export const CheckAnswer = z.object({
  visible: z.array(z.object({ item: z.string(), qty: z.number().int() })),
  lines: z.array(z.object({
    name: z.string(),
    ordered: z.number().int(),
    seen: z.number().int(),
    status: z.enum(['present', 'short', 'different', 'cannot_tell']),
    // What is there instead, when "different" (e.g. "Joko Rooibos 80 bags"); else "".
    seen_as: z.string(),
  })),
  note: z.string(),
});

const SYSTEM = `You check a delivery driver's photo of a food or grocery order at the store, before they leave. Your job is to catch anything missing, so be strict.

Work in this order:
1. "visible": list every item you can actually see in the photo, with how many of each. Count them one by one. Do this before you look at the order list, and do not let the list change what you count.
2. "lines": for each line of the order, in order, give how many were ordered and how many you can see, and a status:
   - "present": you can see at least the ordered quantity.
   - "short": you can see the area where the order is laid out, and fewer than ordered are visible (including none). This is the important case: one drink or one box missing is "short".
   - "different": the item is there, but its size, pack size, flavour or brand plainly differs from the order (e.g. 80 tea bags instead of 100, 1L instead of 2L, Pepsi instead of Coca-Cola). Count it as seen, and say what it is in "seen_as". Only when the label clearly shows the difference.
   - "cannot_tell": the item could be hidden from view -- inside a closed bag, behind something, cut off at the edge, or the photo is too blurred or dark to count.
   An item is only present if you can see it. Never assume something is in the photo because it is on the order.
   "seen_as" is empty unless the status is "different".
3. "note": one short sentence for the driver in plain words, e.g. "1 Sprite 500ml is not in the photo."

A closed pizza box counts as one pizza; you need not know the topping. Match drinks by brand and size when the label is readable; if a drink of the right kind is there but the label can't be read, it counts as seen.
Never write out anything printed on receipts, labels with names, addresses or phone numbers, and never describe people.`;

const orderText = (items, bagCount) => [
  'The order should contain:',
  ...items.map((it) => `- ${it.qty} x ${it.name}${it.size ? ` (${it.size})` : ''}`),
  `Packed in ${bagCount ?? 1} bag${(bagCount ?? 1) === 1 ? '' : 's'}.`,
].join('\n');

/**
 * The verdict, worked out from the per-line counts rather than taken from the
 * model: anything short is missing; otherwise a different size or brand is
 * "different"; otherwise anything it couldn't see (or a line it didn't answer
 * for) makes it unclear; only then complete.
 *
 * Lines come back in the order's order; they are named with the order's own
 * names (the model's spelling of them varies), so the office can match them.
 */
export function verdictFrom({ lines }, items) {
  const named = lines.map((l, i) => ({ ...l, name: lines.length === items.length ? items[i].name : l.name }));
  const short = named.filter((l) => l.status !== 'cannot_tell' && (l.status === 'short' || l.seen < l.ordered));
  const missing = short.map((l) => ({ name: l.name, qty: Math.max(1, l.ordered - Math.max(0, l.seen)) }));
  const different = named.filter((l) => l.status === 'different' && !short.includes(l))
    .map((l) => ({ name: l.name, seenAs: String(l.seen_as ?? '').slice(0, 80) }));
  const seen = named.map((l) => ({ name: l.name, qty: Math.max(0, l.seen) }));
  const base = { missing, different, seen };
  if (missing.length) return { status: 'missing', ...base };
  if (different.length) return { status: 'different', ...base };
  if (named.some((l) => l.status === 'cannot_tell') || lines.length < items.length) return { status: 'unclear', ...base };
  return { status: 'complete', ...base };
}

/** Estimated cost in US$ of one check, from its token counts and the model's list price. */
export const checkCost = (usage, model = PHOTO_CHECK_MODEL) => {
  const price = (MODELS[model] ?? MODELS[PHOTO_CHECK_MODEL]).price;
  return usage ? ((usage.input ?? 0) * price.input + (usage.output ?? 0) * price.output) / 1e6 : 0;
};

/**
 * @param apiKey  ANTHROPIC_API_KEY; without one, every check is "not_configured"
 * @param effort  PHOTO_CHECK_EFFORT, default "medium" (the model's own default).
 *                "low" was faster but missed a missing item in the first trial.
 * @param client  an Anthropic client (tests pass a fake one)
 */
export function createPhotoChecker({
  apiKey = process.env.ANTHROPIC_API_KEY,
  effort = process.env.PHOTO_CHECK_EFFORT || 'medium',
  client = null,
  log = null,
  compare = compareModels(),
} = {}) {
  const sdk = client ?? (apiKey ? new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 }) : null);

  /** @param model  which model looks (default: the one the driver sees) */
  async function check({ jpeg, items, bagCount, model = PHOTO_CHECK_MODEL }) {
    const at = Date.now();
    if (!sdk) return { status: 'not_configured', at, model };
    const can = MODELS[model] ?? MODELS[PHOTO_CHECK_MODEL];
    try {
      const res = await sdk.beta.messages.parse({
        model,
        max_tokens: 1000,
        // If the model declines, the API re-runs the request on a fallback
        // model instead of failing the check (where the model supports it).
        ...(can.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        system: SYSTEM,
        output_config: { ...(can.effort ? { effort } : {}), format: betaZodOutputFormat(CheckAnswer) },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
            { type: 'text', text: orderText(items, bagCount) },
          ],
        }],
      });
      const base = {
        // `model` is the one asked; `servedBy` says if a fallback answered instead.
        at, ms: Date.now() - at, model, servedBy: res.model ?? model, effort: can.effort ? effort : null,
        usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
      };
      const out = res.stop_reason === 'refusal' ? null : res.parsed_output;
      if (!out) return { ...base, status: 'error', reason: res.stop_reason === 'refusal' ? 'declined' : 'no answer' };
      return { ...base, ...verdictFrom(out, items), visible: out.visible, note: out.note.slice(0, 300) };
    } catch (err) {
      log?.warn?.({ status: err?.status, err: err?.message }, 'photo check failed');
      // The API's own message says why (bad key, no access, a bad setting);
      // it never contains the key or the photo.
      return { at, ms: Date.now() - at, model, status: 'error', reason: String(err?.status ?? err?.name ?? 'error'),
        detail: String(err?.message ?? '').slice(0, 300) };
    }
  }

  return { configured: Boolean(sdk), check, compare };
}

/* ------------------------------------------------------- which orders */

/** Defaults for selective checking (settable per server). */
export const SELECTIVE = {
  minItems: Number(process.env.PHOTO_CHECK_MIN_ITEMS ?? 4),        // this many items or more
  newDriverTrips: Number(process.env.PHOTO_CHECK_NEW_DRIVER_TRIPS ?? 20), // driver's first trips
  samplePct: Number(process.env.PHOTO_CHECK_SAMPLE_PCT ?? 30),     // and this share of the rest
};

/** A stable 0-99 number per order, so the random sample doesn't change on a re-ask. */
const bucket = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 100;

/**
 * Is this order checked, and why? `mode` is the store's setting: off, all, or
 * selective (bigger orders, a driver's first trips, and a random share).
 */
export function selectForCheck({ mode, job, driverTrips, rules = SELECTIVE }) {
  if (!job?.items?.length || !mode || mode === 'off') return { selected: false, reason: null };
  if (mode === 'all') return { selected: true, reason: 'every order' };
  const items = job.items.reduce((a, it) => a + (it.qty ?? 1), 0);
  if (items >= rules.minItems) return { selected: true, reason: `${items} items` };
  if (driverTrips != null && driverTrips < rules.newDriverTrips) return { selected: true, reason: `driver's trip ${driverTrips + 1}` };
  if (bucket(job.id) < rules.samplePct) return { selected: true, reason: `random ${rules.samplePct}%` };
  return { selected: false, reason: null };
}
