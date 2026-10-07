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

export const PHOTO_CHECK_MODEL = 'claude-opus-5-5';
/** US$ per million tokens for PHOTO_CHECK_MODEL, for the trial's cost estimate. */
export const PRICE_PER_MTOK = { input: 4, output: 20 };

const Line = z.object({ name: z.string(), qty: z.number().int() });
export const CheckAnswer = z.object({
  verdict: z.enum(['complete', 'missing', 'unclear']),
  seen: z.array(Line),
  missing: z.array(Line),
  note: z.string(),
});

const SYSTEM = `You check a delivery driver's photo of a food or grocery order at the store, before they leave.
You get the photo and the list of what the order should contain. Compare them.

- "complete": every line on the list is visible in the photo, in the right quantity.
- "missing": you can clearly see the order and at least one listed item is not there, or there are fewer than listed. List exactly what is missing in "missing".
- "unclear": you cannot tell -- bags or boxes are closed and hide the contents, the photo is blurred or dark, items are covered, or it is not a photo of the order. Do not guess.

Count only what you can see. A closed pizza box counts as one pizza; you need not know the topping. Match drinks by brand and size when the label is readable.
In "seen", list what you can see, using the names from the order list where they match.
"note" is one short sentence for the driver, in plain words.
Never write out anything printed on receipts, labels with names, addresses or phone numbers, and never describe people.`;

const orderText = (items, bagCount) => [
  'The order should contain:',
  ...items.map((it) => `- ${it.qty} x ${it.name}${it.size ? ` (${it.size})` : ''}`),
  `Packed in ${bagCount ?? 1} bag${(bagCount ?? 1) === 1 ? '' : 's'}.`,
].join('\n');

/** Estimated cost in US$ of one check, from its token counts. */
export const checkCost = (usage) => usage
  ? ((usage.input ?? 0) * PRICE_PER_MTOK.input + (usage.output ?? 0) * PRICE_PER_MTOK.output) / 1e6
  : 0;

/**
 * @param apiKey  ANTHROPIC_API_KEY; without one, every check is "not_configured"
 * @param effort  PHOTO_CHECK_EFFORT, default "low": the driver is waiting at the
 *                counter. The trial measures whether that is accurate enough.
 * @param client  an Anthropic client (tests pass a fake one)
 */
export function createPhotoChecker({
  apiKey = process.env.ANTHROPIC_API_KEY,
  effort = process.env.PHOTO_CHECK_EFFORT || 'low',
  client = null,
  log = null,
} = {}) {
  const sdk = client ?? (apiKey ? new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 }) : null);

  async function check({ jpeg, items, bagCount }) {
    const at = Date.now();
    if (!sdk) return { status: 'not_configured', at };
    try {
      const res = await sdk.beta.messages.parse({
        model: PHOTO_CHECK_MODEL,
        max_tokens: 1000,
        // If the model declines, the API re-runs the request on a fallback
        // model instead of failing the check.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        output_config: { effort, format: betaZodOutputFormat(CheckAnswer) },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
            { type: 'text', text: orderText(items, bagCount) },
          ],
        }],
      });
      const base = {
        at, ms: Date.now() - at, model: res.model ?? PHOTO_CHECK_MODEL, effort,
        usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
      };
      const out = res.stop_reason === 'refusal' ? null : res.parsed_output;
      if (!out) return { ...base, status: 'error', reason: res.stop_reason === 'refusal' ? 'declined' : 'no answer' };
      // Keep the verdict consistent with its own lists.
      let status = out.verdict;
      if (status === 'complete' && out.missing.length) status = 'missing';
      if (status === 'missing' && !out.missing.length) status = 'unclear';
      return { ...base, status, seen: out.seen, missing: out.missing, note: out.note.slice(0, 300) };
    } catch (err) {
      log?.warn?.({ status: err?.status, err: err?.message }, 'photo check failed');
      return { at, ms: Date.now() - at, status: 'error', reason: String(err?.status ?? err?.name ?? 'error') };
    }
  }

  return { configured: Boolean(sdk), check };
}
