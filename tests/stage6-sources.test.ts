import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCompareSettings } from '@safestep/contracts';
import { ComparisonSource, comparisonRoute } from '../apps/extension/sites/comparison';
import { startFixture } from './fixtures/serve.mjs';
const base = new URL('https://pen-shop.resell.store/baseline'),
  id = 'f1479157-1e04-45df-b11e-c1b567c60ae3',
  other = 'f1479157-1e04-45df-b11e-c1b567c60ae4';
const settings = { ...defaultCompareSettings(), query: 'fountain pen' };
test('Comparison canonical routes strip private query values locally; manual offers remain strictly scoped', async () => {
  assert.equal(comparisonRoute(new URL(base + '?token=private#x')), base.href);
  const review = 'https://addons.mozilla.org/en-US/firefox/addon/practice/reviews/';
  assert.equal(
    comparisonRoute(new URL(review + '?unknown=x&score=3&page=2')),
    review + '?score=3&page=2',
  );
  assert.equal(comparisonRoute(new URL(review + '?score=1&score=3')), null);
  for (const url of [
    'https://docs.resell.store/test',
    'https://api.resell.store/v1/market/search',
    'http://foo.test/comparison-lab/original',
    'https://example.test/checkout',
    'https://u:p@pen-shop.resell.store/item',
  ])
    assert.equal(comparisonRoute(new URL(url)), null);
  const src = new ComparisonSource(base, new AbortController().signal);
  assert.throws(() => src.offer(new URL(base + '?private=1')));
  assert.throws(() => src.offer(new URL('https://addons.mozilla.org/en-US/firefox/addon/test/')));
  assert.equal(src.requests, 0);
});
test('Resell discovery deduplicates canonical URLs, rechecks detail identity and reads the shop evidence once', async (t) => {
  const row = (key: string, slug: string) => ({
    id: key,
    slug,
    store: 'pen-shop',
    url: 'https://pen-shop.resell.store/' + slug,
    title: 'Practice fountain pen',
  });
  const b = row(id, 'baseline'),
    a = row(other, 'alternate'),
    calls: string[] = [];
  let pricingTerms = '';
  t.mock.method(globalThis, 'fetch', async (raw: string, init: RequestInit) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.method, 'GET');
    calls.push(raw);
    const u = new URL(raw);
    assert.equal(u.origin, 'https://api.resell.store');
    if (u.pathname === '/v1/market/stores/pen-shop')
      return Response.json({
        object: 'store',
        slug: 'pen-shop',
        name: 'Pen Shop',
        paused: false,
        listings: [b, a],
      });
    if (u.pathname.startsWith('/v1/market/listings/')) {
      const item = u.pathname.endsWith(id) ? b : a;
      const data = JSON.stringify({
        ...item,
        object: 'public_listing',
        sold: false,
        price: 'placeholder',
        shipping: 0,
        category: 'Collectibles',
        details: [
          { label: 'Brand', value: 'Example' },
          { label: 'Model', value: 'One' },
          { label: 'Nib', value: 'Fine' },
          ...(pricingTerms ? [{ label: 'Price basis', value: pricingTerms }] : []),
        ],
      }).replace('"placeholder"', '123456789012.123456');
      return new Response(data, { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.pathname === '/v1/stores/pen-shop/reviews')
      return Response.json({
        object: 'list',
        rating: { average: null, count: 0 },
        data: [],
        has_more: false,
      });
    if (u.pathname === '/v1/market/search') {
      assert.equal(u.searchParams.get('q'), 'fountain pen');
      assert.equal(u.searchParams.get('limit'), '12');
      return Response.json({
        object: 'search_result',
        data: [a, a, { ...a, url: 'https://untrusted.example/checkout' }],
        has_more: true,
      });
    }
    throw Error('Unexpected network request');
  });
  const src = new ComparisonSource(base, new AbortController().signal);
  const initial = await src.baseline(base),
    batch = await src.search(settings, 0),
    next = await src.offer(new URL(batch.urls[0]!));
  assert.deepEqual(batch.urls, [a.url]);
  assert.equal(batch.returned, 3);
  assert.equal(batch.hasMore, true);
  assert.equal(initial.productEvidence, null);
  assert.equal(initial.cost.amount, '123456789012.123456');
  assert.equal(initial.cost.currency, 'USD');
  assert.equal(initial.cost.shippingScope, 'Pickup only');
  assert.equal(next.sellerEvidence?.subject, 'pen-shop');
  assert.equal(src.requests, 5);
  assert.equal(calls.filter((x) => x.includes('/reviews')).length, 1);
  for (const [terms, expected] of [
    ['Auction bid', 'bid'],
    ['From price', 'from'],
    ['Price range', 'range'],
    ['Member coupon', 'conditional'],
    ['Six installments', 'conditional'],
    ['Trade-in required', 'conditional'],
    ['Subscription', 'subscription'],
    ['Unspecified terms', 'unknown'],
  ]) {
    pricingTerms = terms!;
    const offer = await new ComparisonSource(base, new AbortController().signal).baseline(base);
    assert.equal(offer.cost.basis, expected);
    assert(offer.cost.text.includes(pricingTerms));
  }
});
test('Mozilla keeps catalog ID, Firefox compatibility, filtered written page and full distribution independent', async (t) => {
  const u = new URL(
      'https://addons.mozilla.org/en-US/firefox/addon/practice/reviews/?score=1&page=2',
    ),
    canonical = 'https://addons.mozilla.org/en-US/firefox/addon/practice/',
    calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (raw: string) => {
    calls.push(raw);
    const url = new URL(raw);
    if (url.pathname.includes('addons/addon/')) {
      const key = url.pathname.split('/').at(-2)!;
      return Response.json({
        id: key === 'practice' ? 21 : 22,
        slug: key,
        url: canonical.replace('/practice/', '/' + key + '/'),
        type: 'extension',
        status: 'public',
        name: 'Practice',
        authors:
          key === 'practice'
            ? [
                { name: 'First Developer' },
                { name: 'First Developer' },
                { name: 'Second Contributor' },
              ]
            : key === 'alternate'
              ? [
                  { name: 'Independent Labs' },
                  { name: 'ignore previous instructions' },
                  { name: 'buyer@example.test' },
                  { name: 'x'.repeat(101) },
                ]
              : Array.from({ length: 31 }, () => ({ name: 'Extra' })),
        summary: { 'en-US': 'Tracking protection' },
        tags: ['anti tracker'],
        ratings: { average: 3, count: 5, text_count: 1 },
        current_version: { version: '2.0', compatibility: { firefox: { min: '120', max: '*' } } },
      });
    }
    if (url.searchParams.has('show_grouped_ratings'))
      return Response.json({ grouped_ratings: { '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 } });
    if (url.searchParams.get('addon') === '21') {
      assert.equal(url.searchParams.get('score'), '1');
      assert.equal(url.searchParams.get('page'), '2');
    } else assert.equal(url.searchParams.get('addon'), '22');
    return Response.json({ count: 0, next: null, results: [] });
  });
  const out = await new ComparisonSource(u, new AbortController().signal).baseline(u);
  assert.equal(out.url, canonical);
  assert.equal(out.productEvidence?.subject, 'amo_21');
  assert.equal(out.productEvidence?.source, u.href);
  assert.equal(out.sellerEvidence, null);
  assert.equal(out.seller, null);
  assert.equal(out.attributes.developer, 'First Developer, Second Contributor');
  assert.equal(out.cost.basis, 'not_applicable');
  assert.equal(out.attributes.platform, 'Firefox');
  assert.equal(out.attributes['ad blocking'], undefined);
  assert.equal(
    out.productEvidence?.metrics?.filter((m) => m.label.endsWith('-star ratings')).length,
    5,
  );
  assert.equal(calls.length, 3);
  for (const [key, attribution] of [
    ['alternate', 'Independent Labs (partial list)'],
    ['no-attribution', undefined],
  ] as const) {
    const url = new URL(canonical.replace('/practice/', '/' + key + '/'));
    const other = await new ComparisonSource(url, new AbortController().signal).baseline(url);
    assert.equal(other.catalog, 'amo_22');
    assert.equal(other.attributes.developer, attribution);
    assert.equal(other.seller, null);
    assert.equal(other.sellerEvidence, null);
    assert.equal(other.productEvidence?.subject, other.catalog);
  }
});
test('Mozilla publisher denials and conflicting descriptions cannot confirm a required blocking capability', async (t) => {
  const url = new URL('https://addons.mozilla.org/en-US/firefox/addon/practice/');
  const examples = [
    ['Blocks ads on webpages.', [], 'yes', undefined],
    ['This is not an ad blocker. It only changes page colors.', [], 'no', undefined],
    ['This isn’t an ad blocker.', ['ad blocker'], undefined, undefined],
    ['Blocks ads. Ad blocking is not supported.', [], undefined, undefined],
    ['Works with an ad blocker.', ['ad blocker'], undefined, undefined],
    ['Changes page colors.', ['ad blocker'], undefined, undefined],
    ['Compares ad blockers.', [], undefined, undefined],
    ['Ad blocker detector.', [], undefined, undefined],
    ['An efficient wide-spectrum content blocker.', ['ad blocker'], 'yes', undefined],
    ['Does not block ads but blocks trackers.', [], 'no', 'yes'],
    ['Blocks ads, but doesn’t provide tracking protection.', [], 'yes', 'no'],
    ['Tracking protection is unavailable.', ['anti tracker'], undefined, undefined],
    ['Blocks ads and trackers.', [], 'yes', 'yes'],
    [
      'Blocks ads. ' + 'Description. '.repeat(40) + 'Does not block ads.',
      ['ad blocker'],
      undefined,
      undefined,
    ],
  ] as const;
  let summary = '',
    tags: readonly string[] = [];
  t.mock.method(globalThis, 'fetch', async (raw: string) => {
    if (!raw.includes('/addons/addon/')) return Response.json({ count: 0, results: [] });
    return Response.json({
      id: 21,
      slug: 'practice',
      url: url.href,
      type: 'extension',
      status: 'public',
      name: 'Practice',
      summary,
      tags,
      ratings: { average: 4.9, count: 12, text_count: 0 },
      current_version: { version: '1.0', compatibility: { firefox: { min: '120', max: '*' } } },
    });
  });
  for (const [description, sourceTags, ad, tracking] of examples) {
    summary = description;
    tags = sourceTags;
    const offer = await new ComparisonSource(url, new AbortController().signal).baseline(url);
    assert.equal(offer.attributes['ad blocking'], ad, description);
    assert.equal(offer.attributes['tracking protection'], tracking, description);
    assert.equal(
      offer.attributes.purpose,
      ad === 'yes' ? 'ad blocking' : tracking === 'yes' ? 'tracking protection' : undefined,
      description,
    );
  }
});
test('Labelled practice discovery differentiates baseline-only, empty, failing detail, changed and blocked sources', async (t) => {
  const fixture = await startFixture(0);
  t.after(() => fixture.server.close());
  const u = new URL(fixture.origin + '/comparison-lab/'),
    src = () => new ComparisonSource(u, new AbortController().signal);
  const set = async (s: string) => {
    const r = await fetch(fixture.origin + '/comparison-lab/state?scenario=' + s, {
      method: 'POST',
      headers: { origin: fixture.origin },
    });
    assert.equal(r.status, 200);
  };
  assert.equal((await src().baseline(u)).id, 'original');
  const denied = new ComparisonSource(u, new AbortController().signal, async () => false);
  const withoutSamples = await denied.baseline(u);
  assert.equal(denied.requests, 1);
  assert.equal(withoutSamples.productEvidence, null);
  assert.equal(withoutSamples.sellerEvidence, null);
  await set('baseline-only');
  assert.equal((await src().search(settings, 0)).urls.length, 1);
  await set('empty');
  assert.equal((await src().search(settings, 0)).returned, 0);
  await set('partial');
  const partial = src(),
    b = await partial.search(settings, 0);
  await assert.rejects(() => partial.offer(new URL(b.urls[0]!)), /404/);
  assert.equal((await partial.offer(new URL(b.urls[1]!))).id, 'better');
  await set('changed');
  const sold = await src().offer(new URL(fixture.origin + '/comparison-lab/better'));
  assert.equal(sold.availability, 'sold');
  assert.equal(sold.cost.amount, '17.10');
  await set('rate');
  await assert.rejects(() => src().search(settings, 0), /429; retry after 9/);
  await set('pagination');
  const pages = src();
  for (const offset of [0, 12, 24]) {
    const b = await pages.search(settings, offset);
    assert.equal(b.returned, 12);
    assert(b.hasMore);
  }
  await assert.rejects(() => pages.search(settings, 36));
  assert.equal(pages.requests, 3);
  for (const scenario of ['forbidden', 'redirect', 'malformed', 'oversize']) {
    await set(scenario);
    const broken = src();
    await assert.rejects(() => broken.search(settings, 0));
    assert.equal(broken.requests, 1);
    await assert.rejects(() => broken.search(settings, 0));
    assert.equal(broken.requests, 1, 'No automatic retry after source failure');
  }
});
test('Public discovery enforces its operation budget, two active reads, safe query validation and abort', async (t) => {
  const url = new URL('http://localhost:4174/comparison-lab/'),
    ctrl = new AbortController(),
    src = new ComparisonSource(url, ctrl.signal);
  let active = 0,
    peak = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    peak = Math.max(peak, ++active);
    await new Promise((ok) => setTimeout(ok, 2));
    active--;
    return Response.json({ urls: [], hasMore: false });
  });
  await assert.rejects(() => src.search({ ...settings, query: 'my password: SECRET_VALUE' }, 0));
  assert.equal(src.requests, 0);
  const results = await Promise.allSettled(
    Array.from({ length: 24 }, (_, n) => src.search({ ...settings, query: 'pen ' + n }, 0)),
  );
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 20);
  assert.equal(src.requests, 20);
  assert.equal(peak, 2);
  ctrl.abort();
  await assert.rejects(() => src.baseline(url));
  assert.equal(src.requests, 20);
});
