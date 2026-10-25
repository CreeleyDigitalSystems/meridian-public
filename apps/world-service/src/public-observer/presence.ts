import type { IncomingMessage, ServerResponse } from 'node:http';

/** Anonymous viewing sessions only. No IP, user agent, cookie, resident or persistent identity. */
export class PresenceRegistry {
  readonly #sessions = new Map<string, number>();
  readonly #now: () => number;
  #last = 0;
  #refilled = 0;
  #tokens = 40;
  #closed = false;
  constructor(now = () => performance.now()) { this.#now = now; }
  #time(): number {
    if (this.#closed) throw new PresenceRefusal(503);
    const now = this.#now();
    if (!Number.isFinite(now) || now < this.#last) throw new PresenceRefusal(503);
    this.#last = now;
    for (const [id, seen] of this.#sessions) if (now - seen >= 45_000) this.#sessions.delete(id);
    return now;
  }
  admitRequest(): void {
    const now = this.#time();
    this.#tokens = Math.min(40, this.#tokens + (now - this.#refilled) / 50);
    this.#refilled = now;
    if (this.#tokens < 1) throw new PresenceRefusal(429);
    this.#tokens--;
  }
  heartbeat(id: string, active: boolean): number {
    const now = this.#time();
    if (!/^[a-f0-9]{32}$/.test(id)) throw new PresenceRefusal(400);
    if (!active) this.#sessions.delete(id);
    else {
      const prior = this.#sessions.get(id);
      if (prior !== undefined && now - prior < 10_000) throw new PresenceRefusal(429);
      if (prior === undefined && this.#sessions.size >= 2_000) throw new PresenceRefusal(503);
      this.#sessions.set(id, now);
    }
    return this.#sessions.size;
  }
  count(): number { this.#time(); return this.#sessions.size; }
  close(): void { this.#closed = true; this.#sessions.clear(); }
}
class PresenceRefusal extends Error {
  readonly status: number;
  constructor(status: number) { super('presence unavailable'); this.status = status; }
}

export function presenceOrigin(value: string): URL {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new TypeError('invalid presence origin');
  return url;
}

function reply(response: ServerResponse, status: number, count?: number): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(count === undefined ? { error: 'viewing sessions unavailable' } : { activeSessions: count });
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...(status === 429 ? { 'retry-after': '15' } : {}) });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '', size = 0;
    const fail = (status = 400) => { cleanup(); reject(new PresenceRefusal(status)); };
    const timer = setTimeout(() => fail(408), 1_000);
    timer.unref?.();
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128) return fail(413);
      raw += chunk.toString('utf8');
    };
    const end = () => { cleanup(); resolve(raw); };
    const error = () => fail();
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', error);
    };
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', error);
  });
}

/** Only this exact non-world route may accept a body; every world route remains read-only. */
export async function servePresence(request: IncomingMessage, response: ServerResponse, registry: PresenceRegistry, origin: URL): Promise<void> {
  try {
    registry.admitRequest();
    if (request.headers.host !== origin.host || request.headers.origin !== origin.origin || (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin')) throw new PresenceRefusal(403);
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); throw new PresenceRefusal(405); }
    const length = request.headers['content-length'];
    if (request.headers['transfer-encoding'] !== undefined || typeof length !== 'string' || !/^[1-9][0-9]{0,2}$/.test(length)) throw new PresenceRefusal(400);
    if (Number(length) > 128) throw new PresenceRefusal(413);
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'] !== undefined) throw new PresenceRefusal(400);
    const raw = await body(request);
    // A deliberately closed frame: no duplicate keys, extra fields, prose or ambiguous JSON numbers.
    const frame = /^\{"session":"([a-f0-9]{32})","active":(true|false)\}$/.exec(raw);
    if (!frame || Buffer.byteLength(raw) !== Number(length)) throw new PresenceRefusal(400);
    reply(response, 200, registry.heartbeat(frame[1]!, frame[2] === 'true'));
  } catch (error) {
    response.setHeader('connection', 'close');
    reply(response, error instanceof PresenceRefusal ? error.status : 503);
    // Early framing/origin/timeout refusal must not retain an unfinished request stream.
    if (!request.complete) response.once('finish', () => request.destroy());
  }
}
