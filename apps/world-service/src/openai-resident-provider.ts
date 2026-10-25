import { requestTypedDecision } from './invention-provider.js';
import type { PublicResidentContext } from '@meridian/world-schema';
import { LocalProviderError, OllamaResidentProvider } from "./local-resident-provider.js";

const RESPONSE_BYTE_LIMIT = 65_536;
const FORMAT_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

export interface HostedModelConfiguration { apiKey: string; model: string }

/**
 * Fixed-endpoint Responses transport that speaks the local chat envelope used by the
 * bounded providers: `messages` become `input`, the local JSON `format` becomes a strict
 * structured-output schema, and an optional `formatName` names that schema. The reply is
 * re-wrapped as a completed local chat envelope so the existing validators stay authoritative.
 * No configurable destination, tools or retries; the key never leaves this closure.
 */
export function createOpenAIResponsesTransport(configuration: HostedModelConfiguration, request: typeof fetch = fetch): typeof fetch {
  const apiKey = configuration.apiKey.trim();
  const model = configuration.model.trim();
  if (!apiKey || !model) throw new TypeError("Hosted AI requires a server API key and explicit model");
  return async (_localUrl, init) => {
    const local = JSON.parse(String(init?.body));
    const name = typeof local.formatName === "string" && FORMAT_NAME.test(local.formatName) ? local.formatName : "resident_choice";
    const response = await request("https://api.openai.com/v1/responses", {
      method: "POST", redirect: "error", ...(init?.signal === undefined ? {} : { signal: init.signal }),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, store: false, stream: false, max_output_tokens: 512,
        input: local.messages,
        text: { format: { type: "json_schema", name, strict: true, schema: local.format } },
      }),
    });
    if (!response.ok || response.redirected || !response.body) {
      // Status and OpenAI's error code only (never headers or the body text): a revoked key or
      // spent quota must be visible in the logs, not a silent "unavailable" for weeks.
      let code: unknown;
      if (!response.ok && !response.redirected) code = await response.json().then((b: { error?: { code?: unknown; type?: unknown } }) => b?.error?.code ?? b?.error?.type, () => undefined);
      else await response.body?.cancel().catch(() => {});
      process.stderr.write(`${JSON.stringify({ aiProviderFailed: response.status, ...(typeof code === "string" && /^[a-z0-9_.-]{1,64}$/u.test(code) ? { code } : {}) })}\n`);
      throw new LocalProviderError("unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > RESPONSE_BYTE_LIMIT) throw new LocalProviderError("invalid-response");
        chunks.push(chunk.value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = Array.isArray(result.output)
        ? result.output.filter((item: { type?: string }) => item?.type === "message") : [];
      const message = messages[0];
      if (result.status !== "completed" || messages.length !== 1 || message.role !== "assistant"
        || !Array.isArray(message.content) || message.content.length !== 1
        || message.content[0]?.type !== "output_text" || typeof message.content[0].text !== "string") {
        return new Response("invalid-response");
      }
      return Response.json({ done: true, message: { role: "assistant", content: message.content[0].text } });
    } catch {
      await reader.cancel().catch(() => {});
      return new Response("invalid-response");
    } finally {
      reader.releaseLock();
    }
  };
}

/** Adapts only transport: the existing bounded prompt and legal-choice validator remain authoritative. */
export class OpenAIResidentProvider extends OllamaResidentProvider {
  readonly supportsInvention = true;
  readonly #typedRequest: typeof fetch;
  override decidePublic(context: PublicResidentContext, signal: AbortSignal) { return requestTypedDecision(this.#typedRequest,context,signal); }
  constructor(configuration: HostedModelConfiguration, request: typeof fetch = fetch) {
    super(createOpenAIResponsesTransport(configuration, request));
    this.#typedRequest = createOpenAIResponsesTransport(configuration, request);
  }
}
