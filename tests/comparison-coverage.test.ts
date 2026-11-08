import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCompareSettings, evaluateComparison, type Offer } from '@safestep/contracts';
import { ComparisonSource } from '../apps/extension/sites/comparison';

test('Comparison discovery fails closed on HTTP, redirect, timeout, oversized and malformed source responses', async (t) => {
  const start = new URL('http://localhost:4174/comparison-lab/original');
  const settings = { ...defaultCompareSettings(), query: 'fountain pen' };
  for (const kind of ['403', '404', '429', 'redirect', 'size', 'json', 'schema', 'timeout']) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
      calls++;
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      if (kind === 'timeout') {
        return new Promise((_ok, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
        );
      }
      if (kind === 'redirect') throw new TypeError('Redirect rejected by fetch');
      if (kind === 'size')
        return new Response(' '.repeat(262145), {
          headers: { 'Content-Type': 'application/json' },
        });
      if (kind === 'json')
        return new Response('{', { headers: { 'Content-Type': 'application/json' } });
      if (kind === 'schema') return Response.json({ items: [{ href: 'https://another.test/' }] });
      return Response.json(
        { error: 'Practice source response' },
        { status: Number(kind), headers: { 'Retry-After': '5' } },
      );
    });
    const source = new ComparisonSource(start, new AbortController().signal);
    const hold = kind === 'timeout' ? setTimeout(() => {}, 9500) : null;
    try {
      await assert.rejects(() => source.search(settings, 0));
      assert.equal(calls, 1);
      assert.equal(source.requests, 1);
    } finally {
      if (hold) clearTimeout(hold);
      t.mock.restoreAll();
    }
  }
});
test('A different-model price benefit and a different-model preferred feature remain independent tradeoffs', () => {
  const now = Date.parse('2026-11-07T01:00:00Z'),
    at = new Date(now).toISOString(),
    url = 'http://localhost:4174/comparison-lab/';
  const base: Offer = {
    market: 'practice',
    id: 'base',
    title: 'Original practice reader',
    url: url + 'base',
    family: 'reader',
    catalog: 'model-one',
    seller: 'original.shop',
    sellerName: 'Shared alias',
    attributes: {
      purpose: 'reading',
      model: 'one',
      condition: 'new',
      offline: 'no',
      accessories: 'cover',
    },
    quantity: 1,
    availability: 'available',
    captured: at,
    cost: {
      text: 'USD 100',
      amount: '100',
      currency: 'USD',
      currencySource: 'Practice fixture',
      shipping: '0',
      shippingScope: 'same region',
      fees: '0',
      tax: null,
      basis: 'exact',
    },
    sellerEvidence: null,
    productEvidence: null,
  };
  const alt = (id: string, amount: string, offline: string): Offer => ({
    ...base,
    id,
    title: 'Practice ' + id,
    url: url + id,
    catalog: 'model-' + id,
    seller: 'second.shop',
    attributes: { ...base.attributes, model: id, offline },
    cost: { ...base.cost, text: 'USD ' + amount, amount },
  });
  const low = alt('lower', '80', 'no'),
    extra = alt('feature', '110', 'yes');
  const settings = {
    ...defaultCompareSettings(base),
    mode: 'similar_products' as const,
    allowedDifferences: ['model'],
    preferred: [{ field: 'offline', value: 'yes' }],
  };
  for (const [priority, first] of [
    ['cost', 'lower'],
    ['feature', 'feature'],
  ] as const) {
    const result = evaluateComparison(
      base,
      [extra, low],
      { ...settings, priorities: [priority] },
      now,
    );
    assert.equal(result[0]!.offer.id, first);
    assert(result[0]!.recommended);
    assert(
      result.every(
        (r) =>
          r.fit === 'confirmed' && r.reasons.some((s) => s.includes('Different product/model')),
      ),
    );
    assert.equal(result.find((r) => r.offer.id === 'lower')!.savings, '20');
    assert.equal(result.find((r) => r.offer.id === 'feature')!.savings, null);
    assert(
      result.find((r) => r.offer.id === 'feature')!.reasons.some((x) => x.includes('offline: yes')),
    );
    assert(
      result.every(
        (r) => r.tradeoffs.length > 0 && !r.offer.productEvidence && !r.offer.sellerEvidence,
      ),
    );
  }
  const [excluded] = evaluateComparison(base, [low], {
    ...settings, hard: [{field: 'offline', value: 'yes', exclude: false}],
  }, now);
  assert.equal(excluded!.fit, 'incompatible');
  assert.match(excluded!.fitReason!, /offline.*yes/);
  assert(excluded!.tradeoffs.some(t => t.includes('model differs')));
});
