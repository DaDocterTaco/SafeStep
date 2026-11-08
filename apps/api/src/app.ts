import http from 'node:http';
import {
  Lookup,
  ProviderReply,
  ExplainHealth,
  ExplanationInput,
  ExplainReply,
  ShopAIInput,
  ShopAIReply,
  CompareAIInput,
  CompareAIReply,
  AssistHealth,
  AssistReply,
  IntentInput,
  StepInput,
  validAssistInput,
  MerchantRequest,
  MerchantReply,
  ThreatRequest,
  ThreatReply,
  ChatRouteInput,
  ChatRouteHealth,
  ChatRouteReply,
  CleanAdviceInput, CleanAdviceReply,
} from '@safestep/contracts';
import { GeminiService, newPairToken } from './gemini.js';
import { ProvidersService } from './providers.js';
import { MerchantService } from './merchant.js';
import { WebRiskService } from './web-risk.js';

export const apiPort = 4317;
export function makeApi(
  providers = new ProvidersService(process.env),
  gemini = new GeminiService({}, newPairToken()),
  merchants = new MerchantService(),
  threats: Pick<WebRiskService, 'check' | 'readiness'> & Partial<Pick<WebRiskService,'diagnostics'>> = new WebRiskService(),
) {
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
    if (
      req.headers.host !== '127.0.0.1:' + req.socket.localPort &&
      !(req.socket.localPort === 80 && req.headers.host === '127.0.0.1')
    )
      return reply(403, { error: 'blocked_by_policy' });
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
      return reply(403, { error: 'blocked_by_policy' });
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > 90) return reply(429, { error: 'rate_limited' });
    const explain = req.url === '/v1/explain';
    const merchant = req.url === '/v1/merchant/check';
    const threat = req.url === '/v1/threat/check';
    const chat = req.url === '/v1/chat/route';
    const cleanup = req.url === '/v1/cleanup/classify';
    if (origin && (cleanup || merchant || threat || chat || req.url === '/v1/chat/health' || req.url === '/v1/threat/health')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    const shopping = req.url === '/v1/shopping/explain';
    if (req.method === 'GET' && req.url === '/v1/chat/health')
      return reply(200, ChatRouteHealth.parse(gemini.chatHealth()));
    const compare = req.url === '/v1/compare/intent' || req.url === '/v1/compare/explain';
    if (req.method === 'GET' && req.url === '/v1/compare/health')
      return reply(200, gemini.comparisonHealth());
    if(req.method==='GET' && req.url==='/v1/threat/health')
      return reply(200, threats.diagnostics?.() ?? threats.readiness());
    const assist = req.url === '/v1/assist/intent' || req.url === '/v1/assist/step';
    if (req.url === '/v1/assist/health' && req.method === 'GET')
      return reply(200, AssistHealth.parse(gemini.assistHealth()));
    if (req.url === '/v1/explain/health' && req.method === 'GET')
      return reply(200, ExplainHealth.parse(gemini.health()));
    if (req.url === '/v1/explain/operations' && req.method === 'GET')
      return reply(200, gemini.explanationHealth());
    if (
      req.method === 'OPTIONS' &&
      origin &&
      (cleanup || chat || merchant || threat || explain || shopping || assist || compare || req.url === '/v1/explain/connect')
    ) {
      res
        .writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        })
        .end();
      return;
    }
    if (
      (cleanup || chat || merchant || threat || explain || shopping || assist || compare || req.url === '/v1/explain/connect') &&
      req.method === 'POST'
    ) {
      if (!gemini.pair(origin, req.headers.authorization, req.url === '/v1/explain/connect'))
        return reply(403, { error: 'unauthorized' });
      if (req.url === '/v1/explain/connect')
        return reply(200, ExplainHealth.parse(gemini.health(true)));
      req.socket.setTimeout(13000);
    }
    if (req.method === 'GET' && req.url === '/health') {
      const health = providers.readiness();
      health.providers = health.providers.map((row) => row.provider === 'url_threat' ? threats.readiness() : row);
      return reply(200, health);
    }
    if (
      req.method !== 'POST' ||
      (!cleanup && !chat && !merchant && !threat && !explain && !shopping && !assist && !compare && req.url !== '/v1/lookup')
    )
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
        if (size > (assist || compare ? 24576 : cleanup || chat || explain || shopping ? 8192 : 2048)) {
          reply(413, { error: 'invalid_message' });
          return;
        }
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if(cleanup){
        const input=CleanAdviceInput.safeParse(body);
        if(!input.success)return reply(400,{error:'invalid_message'});
        const result=await gemini.cleanup(input.data,controller.signal);
        if(!gemini.pair(origin,req.headers.authorization))return reply(403,{error:'unauthorized'});
        return reply(200,CleanAdviceReply.parse(result));
      }
      if (threat) {
        const input = ThreatRequest.safeParse(body);
        if (!input.success) return reply(400, { error: 'invalid_message' });
        if (!gemini.pair(origin, req.headers.authorization)) return reply(403, { error: 'unauthorized' });
        const result = await threats.check(input.data, controller.signal).catch(() => null);
        if (!gemini.pair(origin, req.headers.authorization)) return reply(403, { error: 'unauthorized' });
        const receipt = ThreatReply.safeParse(result);
        if (
          receipt.success && receipt.data.scope === input.data.scope && receipt.data.url === input.data.url && receipt.data.purpose === input.data.purpose &&
          Date.parse(receipt.data.checkedAt) <= Date.now() &&
          (receipt.data.expiresAt === null || Date.parse(receipt.data.expiresAt) > Date.now())
        ) {
          return reply(200, receipt.data);
        }
        return reply(200, ThreatReply.parse({ ...input.data, status: 'unavailable', reason: 'source',
          source: 'Google Web Risk Lookup', categories: [], checkedAt: new Date().toISOString(), expiresAt: null }));
      }
      if (chat) {
        const input = ChatRouteInput.safeParse(body);
        if (!input.success) return reply(400, { error: 'invalid_message' });
        const result = await gemini.route(input.data, controller.signal);
        if (!gemini.pair(origin, req.headers.authorization)) return reply(403, { error: 'unauthorized' });
        return reply(200, ChatRouteReply.parse(result));
      }
      if (merchant) {
        const input = MerchantRequest.safeParse(body);
        if (!input.success) return reply(400, { error: 'invalid_message' });
        const result = await merchants.check(input.data, controller.signal);
        if (!gemini.pair(origin, req.headers.authorization))
          return reply(403, { error: 'unauthorized' });
        return reply(200, MerchantReply.parse(result));
      }
      if (compare) {
        const input = CompareAIInput.safeParse(body);
        if (
          !input.success ||
          !req.url?.endsWith('/' + input.data.kind) ||
          (input.data.kind === 'intent' && input.data.goal !== input.data.settings.goal)
        )
          return reply(400, { error: 'invalid_message' });
        return reply(
          200,
          CompareAIReply.parse(await gemini.compare(input.data, controller.signal)),
        );
      }
      if (assist) {
        const input = (req.url === '/v1/assist/intent' ? IntentInput : StepInput).safeParse(body);
        if (!input.success || !validAssistInput(input.data))
          return reply(400, { error: 'invalid_message' });
        return reply(200, AssistReply.parse(await gemini.assist(input.data, controller.signal)));
      }
      if (shopping) {
        const input = ShopAIInput.safeParse(body);
        if (!input.success) return reply(400, { error: 'invalid_message' });
        return reply(200, ShopAIReply.parse(await gemini.shopping(input.data, controller.signal)));
      }
      if (explain) {
        const r = ExplanationInput.safeParse(body);
        if (!r.success) return reply(400, { error: 'invalid_message' });
        const result = ExplainReply.parse(await gemini.explain(r.data, controller.signal));
        return reply(200, result);
      }
      const request = Lookup.safeParse(body);
      if (!request.success) return reply(400, { error: 'invalid_message' });
      if (request.data.provider === 'url_threat') return reply(403, { error: 'blocked_by_policy' });
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
