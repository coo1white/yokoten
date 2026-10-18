// A chat completion from Meta's model API (the Llama API), or any OpenAI-compatible
// endpoint. Node's own fetch, no SDK: yokoten has no runtime dependencies.
//
// Checked on 2026-10-18 in Meta's docs (llama.developer.meta.com now redirects to
// dev.meta.ai; the pages read were dev.meta.ai/docs/api-reference.md,
// dev.meta.ai/docs/authentication.md, dev.meta.ai/docs/models.md and
// dev.meta.ai/docs/structured-output.md):
// - The base URL is https://api.meta.ai/v1, and the endpoint is POST /chat/completions,
//   OpenAI-compatible.
// - Auth is `Authorization: Bearer <key>`. Meta's docs name the variable MODEL_API_KEY.
// - `muse-spark-1.3` is the model "recommended for new work"; no Llama model is listed.
// - `response_format` with `type: "json_schema"` constrains the output to a schema.
// The old https://api.llama.com/compat/v1 still answers (401 with no key).
//
// LLAMA_API_BASE and LLAMA_MODEL point this at any other OpenAI-compatible endpoint.
// The key is read from LLAMA_API_KEY, or MODEL_API_KEY. It goes into one header and
// nowhere else: never into a message, an error or a log.

import type { Env } from '../rules/config.ts';

export const DEFAULT_BASE = 'https://api.meta.ai/v1';
export const DEFAULT_MODEL = 'muse-spark-1.3';

/** How to set the key, said when none is set. */
export const KEY_HINT = 'set MODEL_API_KEY (or LLAMA_API_KEY), a Meta model API key from dev.meta.ai, to have a model draft the decisions';

export interface LlamaConfig {
  base: string;
  model: string;
  key: string;
}

export interface Message {
  role: 'system' | 'user';
  content: string;
}

/** The endpoint, the model and the key; null when no key is set. */
export function llamaConfig(env: Env): LlamaConfig | null {
  const key = env.LLAMA_API_KEY || env.MODEL_API_KEY;
  if (!key) return null;
  return { base: (env.LLAMA_API_BASE || DEFAULT_BASE).replace(/\/+$/, ''), model: env.LLAMA_MODEL || DEFAULT_MODEL, key };
}

/**
 * The model's answer to `messages`, as text. With `schema`, the answer is asked for as
 * JSON in that shape. Throws on a failed call; the error names the status, never the key.
 */
export async function chat(config: LlamaConfig, messages: Message[], { schema, timeoutMs = 60_000 }: { schema?: object; timeoutMs?: number } = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${config.base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0,
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'draft', strict: true, schema } } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    throw new Error(name === 'TimeoutError' ? `the model did not answer in ${Math.round(timeoutMs / 1000)} s` : 'the model endpoint could not be reached');
  }
  if (!res.ok) throw new Error(`the model endpoint answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('the model endpoint did not answer with JSON');
  }
  const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('the answer has no message content');
  return content;
}
