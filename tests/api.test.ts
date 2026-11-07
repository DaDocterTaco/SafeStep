import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeApi } from '../apps/api/src/app';
import { ProvidersService } from '../apps/api/src/providers';
import { Health, ProviderReply, type FeatureResult, type Lookup } from '@safestep/contracts';

const input: Lookup = {
  provider: 'seller_feedback',
  subject: { kind: 'seller_reputation', market: 'example.com', publicId: 'fixture-seller' },
};
test('loopback health, not-configured and no-connector HTTP paths never expose credential values', async (t) => {
  const api = makeApi(new ProvidersService({ GEMINI_API_KEY: 'TEST_SECRET_FOR_BOUNDARY_ONLY' }));
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const addr = api.address();
  assert(addr && typeof addr === 'object');
  const origin = 'http://127.0.0.1:' + addr.port;
  const health = await fetch(origin + '/health');
  assert.equal(health.status, 200);
  const raw = await health.text();
  assert(!raw.includes('TEST_SECRET'));
  assert(!raw.includes('GEMINI_API_KEY'));
  const h = Health.parse(JSON.parse(raw));
  assert.equal(h.providers.filter((p) => p.status === 'connector_unavailable').length, 1);
  const post = (body: unknown, headers = {}) =>
    fetch(origin + '/v1/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const r = await post(input);
  assert.equal(r.status, 503);
  const v = ProviderReply.parse(await r.json());
  assert.equal(v.code, 'provider_not_configured');
  assert.equal(v.result.availability, 'unavailable');
  assert.equal(v.result.evidence.length, 0);
  const configured = await post({
    provider: 'intent',
    subject: { kind: 'intent', workflow: 'fixture' },
  });
  assert.equal(ProviderReply.parse(await configured.json()).code, 'provider_unavailable');
  assert.equal((await post(input, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ ...input, fetch: 'http://other' })).status, 400);
  assert.equal((await post({ extra: 'x'.repeat(3000) })).status, 413);
  assert.equal((await fetch(origin + '/v1/lookup?url=http://localhost')).status, 404);
});
test('HTTP rate limits do not allow an unbounded local request stream', async (t) => {
  const api = makeApi(new ProvidersService({}));
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const a = api.address();
  assert(a && typeof a === 'object');
  const url = 'http://127.0.0.1:' + a.port + '/health';
  let status = 0;
  for (let i = 0; i < 91; i++) {
    const r = await fetch(url);
    await r.text();
    status = r.status;
  }
  assert.equal(status, 429);
});
test('a labelled test connector cannot return stale or mismatched evidence; valid evidence is cached within its expiry', async () => {
  let mode = 'wrong',
    calls = 0;
  const provider = new ProvidersService({ MARKETPLACE_SELLER_TOKEN: 'fixture' }, [
    {
      id: 'seller_feedback',
      async lookup(subject) {
        calls++;
        const data: FeatureResult = {
          featureId: 'seller_assessment',
          subject,
          availability: 'partial',
          finding: 'Synthetic fixture only',
          explanation: 'Boundary test',
          limitations: [],
          nextStep: '',
          evidence: [
            {
              id: 'row',
              source: 'Test fixture',
              sourceUrl: null,
              retrievedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + (mode === 'old' ? -1000 : 10000)).toISOString(),
              freshness: 'Test only',
              subject,
              availability: 'partial',
              coverage: 'Labelled synthetic row',
              finding: 'Test',
            },
          ],
        };
        if (mode === 'wrong')
          return {
            ...data,
            subject: {
              kind: 'product_feedback',
              market: 'example.com',
              publicId: 'fixture-product',
            },
          };
        return data;
      },
    },
  ]);
  const ac = new AbortController();
  assert.equal((await provider.lookup(input, ac.signal)).code, 'provider_unavailable');
  mode = 'old';
  assert.equal((await provider.lookup(input, ac.signal)).code, 'provider_unavailable');
  mode = 'ok';
  assert.equal((await provider.lookup(input, ac.signal)).code, null);
  assert.equal((await provider.lookup(input, ac.signal)).code, null);
  assert.equal(calls, 3);
});
test('aborting an unresponsive connector never yields a positive finding', async () => {
  const provider = new ProvidersService({ MARKETPLACE_SELLER_TOKEN: 'fixture' }, [
    { id: 'seller_feedback', lookup: () => new Promise(() => {}) },
  ]);
  const ac = new AbortController();
  const pending = provider.lookup(input, ac.signal);
  ac.abort();
  const r = await pending;
  assert.equal(r.code, 'timeout');
  assert.equal(r.result.availability, 'unavailable');
});
test('HTTP provider failure and the real provider deadline return redacted unavailable reports', async (t) => {
  let hang = false;
  const service = new ProvidersService({ MARKETPLACE_SELLER_TOKEN: 'test-only' }, [
    {
      id: 'seller_feedback',
      async lookup() {
        if (hang) return new Promise<never>(() => {});
        throw Error('PRIVATE_UPSTREAM_DIAGNOSTIC');
      },
    },
  ]);
  const api = makeApi(service);
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const a = api.address();
  assert(a && typeof a === 'object');
  const url = 'http://127.0.0.1:' + a.port + '/v1/lookup';
  for (const code of ['provider_unavailable', 'timeout']) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(r.status, 503);
    const raw = await r.text();
    assert(!raw.includes('PRIVATE_UPSTREAM_DIAGNOSTIC'));
    const result = ProviderReply.parse(JSON.parse(raw));
    assert.equal(result.code, code);
    assert.equal(result.result.availability, 'unavailable');
    hang = true;
  }
});
