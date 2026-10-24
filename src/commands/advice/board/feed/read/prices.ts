// The price table the board's usage view reads (#611). An estimate only: each row is
// the vendor's list price per million tokens on the day it was checked. A model with no
// row is unknown, and the usage view says "partial" for it instead of guessing.
//
// Edit a row when a vendor changes its prices, and move `PRICES_CHECKED` to that day.
// The usage view shows the date and each vendor's own price page, so a reader can check.

/** The day every row below was checked against the vendor's page, in UTC. */
export const PRICES_CHECKED = '2026-10-23';

/** One model's list prices: US dollars per million tokens, and where the vendor lists them. */
export interface ModelPrice {
  /** Text in the model's name, matched without case or punctuation. */
  match: string;
  /** The name the page shows for the model. */
  name: string;
  /** The vendor's price page. */
  url: string;
  /** USD per million tokens: input, input served from the cache, and output. */
  input: number;
  cached: number;
  output: number;
  /** A model that runs on a machine here: no API bill, only power. */
  isLocal?: boolean;
}

/**
 * The table, most specific first. A log names a model with a version suffix, so each row
 * matches the family in the name: "claude-opus-5-5-20261001" is the Opus row.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  { match: 'opus', name: 'Claude Opus 5.5', url: 'https://claude.com/pricing', input: 15, cached: 1.5, output: 75 },
  { match: 'sonnet', name: 'Claude Sonnet 5.5', url: 'https://claude.com/pricing', input: 3, cached: 0.3, output: 15 },
  { match: 'haiku', name: 'Claude Haiku 4.5', url: 'https://claude.com/pricing', input: 1, cached: 0.1, output: 5 },
  { match: 'deepseek', name: 'DeepSeek V4.1 Flash', url: 'https://api-docs.deepseek.com/quick_start/pricing', input: 0.14, cached: 0.014, output: 0.28 },
  { match: 'grok', name: 'Grok 4.7', url: 'https://docs.x.ai/docs/models', input: 3, cached: 0.75, output: 15 },
  { match: 'muse', name: 'Muse Spark', url: 'https://dev.meta.ai/docs/muse-code/pricing', input: 0.5, cached: 0.05, output: 1.5 },
  { match: 'qwen', name: 'Qwen 3.5 9B', url: 'https://ollama.com/library/qwen3', input: 0, cached: 0, output: 0, isLocal: true },
];

/** A model name as the table compares it: letters and digits only, in lower case. */
export function priceKey(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The price row for a model name, or null when the table has none. */
export function modelPrice(model: string): ModelPrice | null {
  const key = priceKey(model);
  if (!key) return null;
  return MODEL_PRICES.find((row) => key.includes(row.match)) ?? null;
}

/** What one use would cost on the vendor's API, in USD, or null when a price is unknown. */
export function costOf(model: string, input: number, cached: number, output: number): number | null {
  const price = modelPrice(model);
  if (!price) return null;
  return (input * price.input + cached * price.cached + output * price.output) / 1_000_000;
}

/** Each vendor's price page, one row per vendor, for the note under the view. */
export function priceSources(): { vendor: string; url: string }[] {
  const sources = new Map<string, string>();
  for (const row of MODEL_PRICES) {
    const vendor = row.name.split(' ')[0] ?? row.name;
    if (!sources.has(vendor)) sources.set(vendor, row.url);
  }
  return [...sources].map(([vendor, url]) => ({ vendor, url }));
}
