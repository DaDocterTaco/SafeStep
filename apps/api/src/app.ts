import http from 'node:http';
import { Lookup, ProviderReply } from '@safestep/contracts';
import { ProvidersService } from './providers.js';

export const apiPort = 4317;
export function makeApi(providers = new ProvidersService(process.env)) {
  // One loopback-only service and a fixed body type. No proxying, redirects, arbitrary origins or remote URL parameters.
  let windowStart = Date.now(),
    count = 0;
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      if (!res.destroyed)
        res
          .writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          .end(JSON.stringify(body));
    };
    if (!/^127\.0\.0\.1(?::[0-9]+)?$/.test(req.headers.host ?? ''))
      return reply(403, { error: 'blocked_by_policy' });
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
      return reply(403, { error: 'blocked_by_policy' });
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > 90) return reply(429, { error: 'rate_limited' });
    if (req.method === 'GET' && req.url === '/health') return reply(200, providers.readiness());
    if (req.method !== 'POST' || req.url !== '/v1/lookup')
      return reply(404, { error: 'not_found' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      return reply(415, { error: 'invalid_message' });
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) {
          reply(413, { error: 'invalid_message' });
          return;
        }
        chunks.push(chunk);
      }
      const request = Lookup.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!request.success) return reply(400, { error: 'invalid_message' });
      const result = ProviderReply.parse(await providers.lookup(request.data, controller.signal));
      reply(result.code ? 503 : 200, result);
    } catch {
      return reply(400, { error: 'invalid_message' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 7000;
  return server;
}
