import { composePublicRequest } from './resident-request-composer.js';
import type { PublicResidentContext } from '@meridian/world-schema';
import { PublicResidentContextSchema } from '@meridian/world-schema';
import { LocalProviderError, PROMPT_BUDGET } from './local-resident-provider.js';
export interface CompactDesign {
  p: number[][];
  c: number[];
}
export interface PublicTypedReply {
  t: string;
  d: CompactDesign[];
}
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
export function validateTypedReply(raw: unknown, context: PublicResidentContext): PublicTypedReply {
  if (!keys(raw, ['t', 'd']) || typeof raw.t !== 'string' || !Array.isArray(raw.d)) throw new LocalProviderError('invalid-response');
  const choice = context.choices.find(x => x.token === raw.t);
  const candidate = choice?.action.code === 'invention' && choice.action.intent === 'candidate';
  if (!choice || raw.d.length !== (candidate ? 1 : 0)) throw new LocalProviderError('invalid-response');
  for (const d of raw.d) {
    if (!keys(d, ['p', 'c']) || !Array.isArray(d.p) || d.p.length < 2 || d.p.length > 6 || !Array.isArray(d.c) || d.c.length !== 3) throw new LocalProviderError('invalid-response');
    for (let index = 0; index < d.p.length; index++) {
      const p = d.p[index];
      if (!Array.isArray(p) || p.length !== 5 || !p.every(Number.isSafeInteger) || p[0] < 0 || p[0] > 4 || p[1] < 0 || p[1] > 5 || p[2] < 0 || p[2] > 5 || p[3] < 0 || p[3] > 1 || (index === 0 ? p[4] !== 0 : p[4] < 1 || p[4] > index)) throw new LocalProviderError('invalid-response');
    }
    if (!d.c.every(Number.isSafeInteger) || d.c[0] < 0 || d.c[0] > 1 || d.c[1] < 0 || d.c[1] > 1 || d.c[2] < 1 || d.c[2] > 100) throw new LocalProviderError('invalid-response');
  }
  return raw as unknown as PublicTypedReply;
}
export async function requestTypedDecision(request: typeof fetch, input: PublicResidentContext, signal: AbortSignal): Promise<PublicTypedReply> {
  let context: PublicResidentContext;
  try {
    context = PublicResidentContextSchema.parse(input);
  } catch {
    throw new LocalProviderError('invalid-response');
  }
  if (!context.choices.length) throw new LocalProviderError('invalid-response');
  const body = JSON.stringify({
    stream: false,
    formatName: 'resident_invention',
    options: {
      num_predict: 96
    },
    format: {
      type: 'object',
      properties: {
        t: {
          type: 'string',
          enum: context.choices.map(x => x.token)
        },
        d: {
          type: 'array',
          minItems: 0,
          maxItems: 1,
          items: {
            type: 'object',
            properties: {
              p: {
                type: 'array',
                minItems: 2,
                maxItems: 6,
                items: {
                  type: 'array',
                  minItems: 5,
                  maxItems: 5,
                  items: {
                    type: 'integer',
                    enum: [0, 1, 2, 3, 4, 5]
                  }
                }
              },
              c: {
                type: 'array',
                minItems: 3,
                maxItems: 3,
                items: {
                  type: 'integer',
                  minimum: 0,
                  maximum: 100
                }
              }
            },
            required: ['p', 'c'],
            additionalProperties: false
          }
        }
      },
      required: ['t', 'd'],
      additionalProperties: false
    },
    messages: composePublicRequest(context, 'Choose one offered action token t. Author-method and adopt-version are explicit requests for private executable work and exact tested adoption; they always return d=[] and never graph bytes. Return d=[] except candidate: d contains exactly ONE original design. Grammar p rows [kind,x,y,rotation,parentPlusOne]; kind 0 base,1 support,2 guide,3 clamp,4 tray; coordinates0..5; rotation0 x or1 y; root base first,parent0; later parent is earlier row index+1. Orthogonal connected unique cells; base load8,support6,other2; stone mass4,timber1. c=[metric0 duration or1 quality,relation0 at-most or1 at-least,value1..100]. Designs cost actual materials/time; no guaranteed benefit. Use own and explicitly shared measured evidence. Availability is not observation. Answer independently; no prose.').messages
  });
  if (Buffer.byteLength(body) > PROMPT_BUDGET.requestBytes) throw new LocalProviderError('invalid-response');
  let response: Response;
  try {
    response = await request('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json'
      },
      body
    });
  } catch {
    throw new LocalProviderError('unavailable');
  }
  const reader = response.body?.getReader();
  if (!response.ok || response.redirected || !reader) {
    await response.body?.cancel().catch(() => {});
    throw new LocalProviderError('unavailable');
  }
  try {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16384) throw new Error('response cap');
      chunks.push(chunk.value);
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (envelope.done !== true || envelope.message?.role !== 'assistant' || typeof envelope.message.content !== 'string') throw new Error('invalid envelope');
    return validateTypedReply(JSON.parse(envelope.message.content), context);
  } catch {
    await reader.cancel().catch(() => {});
    throw new LocalProviderError('invalid-response');
  } finally {
    reader.releaseLock();
  }
}
