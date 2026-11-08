import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompareAction,
  CompareSettings,
  CompareView,
  Offer,
  comparableSubtotal,
  defaultCompareSettings,
  evaluateComparison,
  comparisonFromWords,
  isCanonicalOfferUrl,
  isComparisonSearchSource,
  type CompareCost,
  type ComparisonAssessment,
} from '@safestep/contracts';

const now = Date.parse('2026-11-07T12:00:00.000Z'),
  captured = new Date(now).toISOString(),
  origin = 'http://localhost:4174/comparison-lab/';
function assessment(
  subject: string,
  label: string,
  value: number,
  count = 12,
  groups = 3,
): ComparisonAssessment {
  return {
    subject,
    source: origin + 'item',
    captured,
    metric: { label, value, scale: 5, period: 'All published ratings', count },
    sample: groups,
    groups,
    summary: [],
    limits: [],
  };
}
const cost: CompareCost = {
  text: 'USD 0.10',
  amount: '0.10',
  currency: 'USD',
  currencySource: 'Practice listing states USD',
  shipping: '0.20',
  shippingScope: 'Published standard shipping',
  fees: '0',
  tax: null,
  basis: 'exact',
};
function offer(
  id: string,
  seller: string,
  costs: Partial<CompareCost> = {},
  extras: Partial<Offer> = {},
): Offer {
  return {
    market: 'practice',
    id,
    title: 'Model P',
    url: origin + id,
    family: 'fountain pen',
    catalog: 'Acme:P',
    seller,
    sellerName: 'Same shop name',
    quantity: 1,
    attributes: {
      purpose: 'drawing',
      model: 'P',
      nib: 'fine',
      condition: 'used',
      accessories: 'box',
    },
    availability: 'available',
    captured,
    cost: { ...cost, ...costs },
    productEvidence: assessment('Acme:P', 'Product rating', 4),
    sellerEvidence: assessment(seller, 'Seller rating', 4),
    ...extras,
  };
}
const base = offer('item', 'first.shop'),
  cfg = defaultCompareSettings(base);
function compare(o: Offer, s: CompareSettings = cfg, b = base) {
  return evaluateComparison(b, [o], s, now)[0]!;
}
test('an unfamiliar required feature cannot be inherited from another seller or an offer title',()=>{
  const settings=comparisonFromWords(cfg,'Compare pens. They must have an ultraviolet coating.');
  const item=offer('current','other.shop',{}, {title:'Advertised ultraviolet coating'});
  const unconfirmed=compare(item,settings);
  assert.equal(unconfirmed.fit,'needs_checking');
  assert.equal(unconfirmed.recommended,false);
  assert(unconfirmed.tradeoffs.some(x=>x.includes('ultraviolet coating') && x.includes('source evidence')));
  const originWithProof={...base,attributes:{...base.attributes,feature:'ultraviolet coating'}};
  assert.equal(compare(item,settings,originWithProof).fit,'needs_checking');
  const withOwnEvidence={...item,attributes:{...item.attributes,feature:'ultraviolet coating'}};
  assert.equal(compare(withOwnEvidence,settings,originWithProof).fit,'confirmed');
});
test('SS6-02 matches only disclosed nib widths allowed by the user', () => {
  const alt = offer('different', 'another.shop');
  const fits = (label: string | null, wanted: string, exclude = false) => {
    const attributes = { ...alt.attributes };
    if (label === null) delete attributes.nib;
    else attributes.nib = label;
    return compare({ ...alt, attributes }, {
      ...cfg, mode: 'similar_products', allowedDifferences: ['nib', 'model'],
      hard: [{ field: 'nib', value: wanted, exclude }],
    });
  };
  const either = 'Fine or Extra-Fine';
  for (const label of ['fine', 'extra fine', 'Fine, hooded', '9668 firm fine', 'extra‑fine', '14k EF'])
    assert.equal(fits(label, either).fit, 'confirmed', label);
  for (const label of ['Medium', '14k two-tone, medium', 'Broad'])
    assert.equal(fits(label, either).fit, 'incompatible', label);
  for (const label of [null, '14k hooded', 'not fine', 'fine or medium', 'fine?'])
    assert.equal(fits(label, either).fit, 'needs_checking', label ?? 'missing');
  assert.equal(fits('extra fine', 'fine').fit, 'incompatible');
  assert.equal(fits('Fine, hooded', either, true).fit, 'incompatible');
  assert.equal(fits('medium', either, true).fit, 'confirmed');
  assert.equal(fits(null, either, true).fit, 'needs_checking');
});
test('SS6-04 applies pickup and delivery requirements only to source-bound shipping facts', () => {
  const check = (scope: string | null, shipping: string | null, value: string, exclude = false) =>
    compare(offer('candidate', 'another.shop', { shippingScope: scope, shipping }), {
      ...cfg, hard: [{ field: 'delivery', value, exclude }],
    });
  const pickup = check('Pickup only', '0', 'Pickup only');
  assert.equal(pickup.fit, 'confirmed');
  assert(pickup.matched.includes('delivery: Pickup only'));
  assert.equal(check('Pickup only', '0', 'Pickup only', true).fit, 'incompatible');
  assert.equal(check('Pickup only', '0', 'Free shipping').fit, 'incompatible');
  assert.equal(check('Explicit free delivery', '0', 'pickup only').fit, 'incompatible');
  assert.equal(check('Explicit free delivery', '0', 'free shipping').fit, 'confirmed');
  assert.equal(check('Fixture domestic delivery', '3.05', 'shipping').fit, 'confirmed');
  assert.equal(check('Fixture domestic delivery', '3.05', 'free shipping').fit, 'incompatible');
  assert.equal(check('Listed shipping; destination eligibility unknown', '4.15', 'delivery to Alaska').fit, 'needs_checking');
  assert.equal(check('Fixture domestic delivery', null, 'free shipping').fit, 'needs_checking');
  for (const scope of [null, 'Shipping unknown']) {
    assert.equal(check(scope, '0', 'pickup only').fit, 'needs_checking');
    assert.equal(check(scope, '0', 'pickup only', true).fit, 'needs_checking');
  }
});
test('A beta version exclusion checks the actual catalog version before recommending an offer', () => {
  const settings: CompareSettings = {
    ...cfg,
    hard: [{ field: 'version', value: 'beta', exclude: true }],
  };
  const candidate = offer('extension', 'another.shop');
  const withVersion = (version: string) => ({
    ...candidate, attributes: { ...candidate.attributes, version },
  });
  for (const version of ['1.4.0-beta.1', '2.0b4', '2.0B12', 'beta 4']) {
    const c = compare(withVersion(version), settings);
    assert.equal(c.fit, 'incompatible', version);
    assert.equal(c.recommended, false);
  }
  assert.equal(compare(withVersion('2.0.4'), settings).fit, 'confirmed');
  assert.equal(compare(candidate, settings).fit, 'needs_checking');
});
test('Comparison costs retain decimal precision, reject malformed amounts and preserve zero', () => {
  assert.equal(comparableSubtotal(base, now), '0.3');
  assert.equal(
    comparableSubtotal(
      offer('second', 'other', { amount: '999999999999.999999', shipping: '0.000001' }),
      now,
    ),
    '1000000000000',
  );
  assert.equal(
    comparableSubtotal(offer('second', 'other', { amount: '0', shipping: '0.000000' }), now),
    '0',
  );
  for (const amount of [
    'NaN',
    'Infinity',
    '0x20',
    '1e2',
    '+0.1',
    '-2',
    '0,20',
    '1234567890123',
    '0.1234567',
    '',
  ])
    assert.equal(comparableSubtotal(offer('b', 'x', { amount }), now), null);
  for (const missing of [
    { currency: null },
    { currencySource: null },
    { fees: null },
    { shipping: null },
    { shippingScope: null },
  ])
    assert.equal(comparableSubtotal(offer('b', 'x', missing), now), null);
  assert(CompareSettings.safeParse(cfg).success);
  for (const privateValue of ['token:secret', 'address=private home', '340 Orange Tree Avenue']) {
    assert(!CompareSettings.safeParse({ ...cfg, goal: privateValue }).success);
    assert(!CompareSettings.safeParse({ ...cfg, query: privateValue }).success);
    assert(
      !CompareSettings.safeParse({
        ...cfg,
        hard: [{ field: 'shipping', value: privateValue, exclude: false }],
      }).success,
    );
  }
  assert(
    !CompareSettings.safeParse({
      ...cfg,
      budget: { amount: '12', basis: 'subtotal', currency: 'QQQ' },
    }).success,
  );
  for (const basis of [
    'range',
    'from',
    'bid',
    'subscription',
    'conditional',
    'unknown',
    'not_applicable',
  ] as const)
    assert.equal(comparableSubtotal(offer('b', 'x', { basis }), now), null);
});
test('Savings distinguish equal basis, mixed currencies, changed quantity, condition, package and budget scope', () => {
  const cheaper = offer('second', 'other', { amount: '0.07' }),
    row = compare(cheaper);
  assert.equal(row.savings, '0.03');
  assert.equal(row.savingsPercent, '10');
  assert(row.recommended);
  for (const o of [
    offer('b', 'x', { currency: 'EUR' }),
    offer('b', 'x', { shippingScope: 'Store pickup' }),
    offer('b', 'x', {}, { quantity: 2 }),
    offer('b', 'x', {}, { attributes: { ...base.attributes, accessories: 'no box' } }),
    offer('b', 'x', {}, { attributes: { ...base.attributes, condition: 'damaged' } }),
  ])
    assert.equal(compare(o).savings, null);
  assert.equal(
    compare(
      offer('b', 'x', { amount: '0' }),
      cfg,
      offer('item', 'first.shop', { amount: '0', shipping: '0' }),
    ).savingsPercent,
    null,
  );
  assert.equal(
    compare(offer('b', 'x', { shipping: null }), {
      ...cfg,
      budget: { currency: 'USD', amount: '0.11', basis: 'item' },
    }).fit,
    'confirmed',
  );
  assert.equal(
    compare(offer('b', 'x', { shipping: null }), {
      ...cfg,
      budget: { currency: 'USD', amount: '0.11', basis: 'subtotal' },
    }).fit,
    'needs_checking',
  );
  assert.equal(
    compare(offer('b', 'x', { currency: null }), {
      ...cfg,
      budget: { currency: 'USD', amount: '2', basis: 'item' },
    }).fit,
    'needs_checking',
  );
  assert.equal(
    compare(cheaper, { ...cfg, budget: { currency: 'USD', amount: '0.06', basis: 'item' } }).fit,
    'incompatible',
  );
  assert.equal(compare({ ...cheaper, availability: 'sold' }).fit, 'unavailable');
  assert.equal(
    compare({ ...cheaper, captured: new Date(now - 300000).toISOString() }).fit,
    'needs_checking',
  );
});
test('Modes preserve immutable identities, edition/variant, offer quantity, condition and explicitly allowed differences', () => {
  const oldVariant = offer('b', 'x', {}, { attributes: { ...base.attributes, nib: 'extra fine' } });
  assert.equal(compare(oldVariant).fit, 'incompatible');
  const newCopy = offer(
    'b',
    'x',
    { amount: '0.01' },
    { attributes: { ...base.attributes, condition: 'new' } },
  );
  const requested = compare(newCopy, {
    ...cfg,
    hard: [{ field: 'condition', value: 'new', exclude: false }],
  });
  assert.equal(requested.fit, 'confirmed');
  assert.equal(requested.savings, null);
  assert(requested.tradeoffs.some((x) => x.includes('condition differs')));
  assert.equal(compare(newCopy).fit, 'incompatible');
  const other = offer(
    'b',
    'x',
    {},
    {
      catalog: 'Acme:Q',
      productEvidence: null,
      attributes: { ...base.attributes, model: 'Q', nib: 'extra fine' },
    },
  );
  const similar: CompareSettings = {
    ...cfg,
    mode: 'similar_products',
    allowedDifferences: ['model', 'nib'],
  };
  assert.equal(compare(other, similar).fit, 'confirmed');
  assert.equal(
    compare(other, { ...similar, hard: [{ field: 'nib', value: 'extra fine', exclude: true }] })
      .fit,
    'incompatible',
  );
  assert.equal(
    compare(other, { ...similar, hard: [{ field: 'offline', value: 'yes', exclude: false }] }).fit,
    'needs_checking',
  );
  assert.equal(
    compare({ ...other, attributes: { ...other.attributes, purpose: 'unrelated' } }, similar).fit,
    'incompatible',
  );
  assert.equal(compare(offer('b', 'first.shop')).fit, 'incompatible');
  assert.equal(
    compare(offer('b', 'x', {}, { catalog: null, productEvidence: null })).fit,
    'identity_uncertain',
  );
  const book = offer(
    'book',
    'first.shop',
    {},
    {
      family: 'book',
      catalog: '9780307593528',
      attributes: {
        isbn: '9780307593528',
        printing: '1961 first',
        format: 'hardback',
        condition: 'used',
      },
    },
  );
  const reprint = {
    ...book,
    id: 'second',
    seller: 'other',
    attributes: { ...book.attributes, printing: 'later' },
  };
  assert.equal(compare(reprint, cfg, book).fit, 'incompatible');
  assert.equal(
    compare({ ...reprint, attributes: { ...book.attributes, isbn: '9780307593520' } }, cfg, book)
      .fit,
    'identity_uncertain',
  );
  const ad = offer(
    'ad',
    'promoted.shop',
    { amount: '0' },
    { attributes: { ...base.attributes, promoted: 'true' } },
  );
  const verified = offer('verified', 'other.shop', { amount: '0.05' });
  for (const mode of ['same_product_other_sellers', 'compare_selected'] as const) {
    const rows = evaluateComparison(base, [ad, verified], { ...cfg, mode }, now);
    assert.equal(rows[0]!.offer.id, 'verified');
    assert(rows[0]!.recommended);
    assert.equal(rows[1]!.fit, 'confirmed');
    assert(!rows[1]!.recommended);
    assert(rows[1]!.tradeoffs.some((t) => t.includes('Source-marked promotion')));
    assert(!evaluateComparison(base, [ad], { ...cfg, mode }, now)[0]!.recommended);
  }
  const editorial = offer(
    'catalogue',
    'other.shop',
    { amount: '0.04' },
    { attributes: { ...base.attributes, 'publisher badge': 'Recommended' } },
  );
  assert(compare(editorial).recommended);
  assert(compare(editorial).tradeoffs.some((x) => x.includes('Publisher program: Recommended')));
  assert(!compare(editorial).tradeoffs.some((x) => x.includes('promotion')));
});
test('Source-bound product/seller metrics preserve sparsity, scale, period and shared catalog scope', () => {
  const alt = offer(
    'second',
    'other',
    {},
    { sellerEvidence: assessment('other', 'Seller rating', 4.9) },
  );
  const sellerFirst: CompareSettings = { ...cfg, priorities: ['seller'] };
  assert(compare(alt, sellerFirst).recommended);
  for (const ev of [
    assessment('other', 'Seller rating', 5, 1, 1),
    assessment('other', 'Seller rating', 5, 10, 1),
    {
      ...assessment('other', 'Seller rating', 5),
      metric: { ...alt.sellerEvidence!.metric!, period: 'Last month' },
    },
    {
      ...assessment('other', 'Seller rating', 5),
      metric: { ...alt.sellerEvidence!.metric!, scale: 10 },
    },
  ])
    assert(!compare({ ...alt, sellerEvidence: ev }, sellerFirst).recommended);
  assert(!compare(alt, { ...cfg, priorities: ['product'] }).recommended);
  assert(compare(alt).tradeoffs.some((s) => s.includes('Shared catalog')));
  assert(
    !Offer.safeParse({ ...alt, sellerEvidence: assessment('wrong', 'Seller rating', 5) }).success,
  );
  assert(
    !Offer.safeParse({
      ...alt,
      productEvidence: { ...alt.productEvidence, source: 'https://malicious.test/somewhere' },
    }).success,
  );
  assert(!Offer.safeParse({ ...alt, url: 'not an absolute URL' }).success);
});
test('Ranking follows declared priorities, leaves ties unresolved, deduplicates and honors unknown evidence', () => {
  const cheap = offer('cheap', 'lower.shop', { amount: '0.05' }),
    service = offer(
      'service',
      'other.shop',
      {},
      { sellerEvidence: assessment('other.shop', 'Seller rating', 5) },
    );
  const first = evaluateComparison(
    base,
    [base, cheap, cheap, service],
    { ...cfg, priorities: ['cost', 'seller'] },
    now,
  );
  assert.equal(first.length, 2);
  assert.equal(first[0]!.offer.id, 'cheap');
  assert(first[0]!.recommended);
  const second = evaluateComparison(
    base,
    [cheap, service],
    { ...cfg, priorities: ['seller', 'cost'] },
    now,
  );
  assert.equal(second[0]!.offer.id, 'service');
  assert(second[0]!.recommended);
  const equal = offer('equally-cheap', 'third.shop', { amount: '0.05' });
  assert(evaluateComparison(base, [cheap, equal], cfg, now).every((x) => !x.recommended));
  const unknown = offer('unknown', 'third.shop', { shipping: null });
  assert(evaluateComparison(base, [cheap, unknown], cfg, now).every((x) => !x.recommended));
  const similar = offer(
    'different',
    'third.shop',
    {},
    {
      catalog: 'Acme:Q',
      productEvidence: null,
      attributes: { ...base.attributes, model: 'Q', offline: 'yes' },
    },
  );
  const offlineBase = { ...base, attributes: { ...base.attributes, offline: 'no' } };
  const s: CompareSettings = {
    ...cfg,
    mode: 'similar_products',
    allowedDifferences: ['model'],
    preferred: [{ field: 'offline', value: 'yes' }],
    priorities: ['feature'],
  };
  assert(compare(similar, s, offlineBase).recommended);
  assert(!compare(similar, s, base).recommended);
});
test('Explicit zero budgets, priority ties and stale or unavailable choices never manufacture a winning savings', () => {
  const zero = offer('item', 'first.shop', { amount: '0.000', shipping: '0', fees: '0' });
  const other = offer('alternative', 'second.shop', {
    amount: '0.00',
    shipping: '0.000000',
    fees: '0',
  });
  const noCharge: CompareSettings = {
    ...cfg,
    budget: { amount: '0', currency: 'USD', basis: 'subtotal' },
    priorities: ['cost', 'seller'],
  };
  const equal = compare(other, noCharge, zero);
  assert.equal(equal.subtotal, '0');
  assert.equal(equal.savings, null);
  assert.equal(equal.savingsPercent, null);
  assert(!equal.recommended);
  assert.equal(equal.fit, 'confirmed');
  assert.equal(
    compare({ ...other, cost: { ...other.cost, fees: '0.000001' } }, noCharge, zero).fit,
    'incompatible',
  );
  const lowerSold = offer(
    'sold',
    'third.shop',
    { amount: '0' },
    { availability: 'sold', sellerEvidence: assessment('third.shop', 'Seller rating', 5) },
  );
  const lowerStale = offer(
    'stale',
    'third.shop',
    { amount: '0' },
    { captured: new Date(now - 301000).toISOString() },
  );
  for (const priorities of [
    ['seller', 'cost'],
    ['cost', 'seller'],
  ] as const) {
    const list = evaluateComparison(
      base,
      [lowerSold, lowerStale, offer('eligible', 'second.shop')],
      { ...cfg, priorities: [...priorities] },
      now,
    );
    assert.equal(list[0]!.offer.id, 'eligible');
    assert(list.every((c) => !c.recommended));
  }
});
test('Discovery citations match the fixed read-only source, baseline origin and approved query', () => {
  const res =
    'https://api.resell.store/v1/market/search?q=fountain+pen&category=Pens&limit=12&offset=12';
  const moz =
    'https://addons.mozilla.org/api/v5/addons/search/?q=ad+blocker&app=firefox&type=extension&page=1&page_size=12&lang=en-US';
  const fixture =
    origin + 'source/search?q=' + encodeURIComponent(cfg.query) + '&mode=' + cfg.mode + '&offset=0';
  for (const url of [res, moz, fixture]) assert(isComparisonSearchSource(url));
  for (const url of [
    res + '&return=https://outside.example',
    res.replace('limit=12', 'limit=99'),
    moz.replace('page=1', 'page=4'),
    moz + '&q=second',
    res.replace('api.resell.store', 'api.resell.store.bad.test'),
    fixture.replace('/source/search', '/buy'),
    res + '#private',
  ])
    assert(!isComparisonSearchSource(url));
  const v = {
    id: crypto.randomUUID(),
    version: 1,
    status: 'ready',
    baseline: base,
    settings: cfg,
    candidates: [],
    coverage: { searched: 1, checked: 1, excluded: 0, batches: 1, more: false },
    at: captured,
    message: 'Capture',
    searchSource: fixture,
  };
  assert(CompareView.safeParse(v).success);
  for (const source of [
    res,
    fixture.replace('4174', '4173'),
    fixture.replace(encodeURIComponent(cfg.query), 'another'),
  ])
    assert(!CompareView.safeParse({ ...v, searchSource: source }).success);
});
test('Offer URL and command contracts refuse tracked, transactional, spoofed or malformed destinations', () => {
  for (const url of [
    origin + 'item',
    'https://nibdrawer.resell.store/lamy-2000-makrolon',
    'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
  ])
    assert(isCanonicalOfferUrl(url));
  for (const url of [
    'https://api.resell.store/a',
    'https://nibdrawer.resell.store.evil.test/pen',
    'https://x:y@nibdrawer.resell.store/pen',
    'https://addons.mozilla.org/en-US/firefox/addon/u/?token=key',
    origin + '../checkout',
    'https://nibdrawer.resell.store/p/checkout',
    'ftp://nibdrawer.resell.store/pen',
  ])
    assert(!isCanonicalOfferUrl(url));
  const session = crypto.randomUUID();
  assert(CompareAction.safeParse({ op: 'prepare' }).success);
  assert(CompareAction.safeParse({ op: 'open', id: 'cheap', session, version: 1 }).success);
  assert(
    !CompareAction.safeParse({ op: 'open', id: 'cheap', session, version: 1, url: origin + 'item' })
      .success,
  );
  assert(
    CompareView.safeParse({
      id: session,
      version: 1,
      status: 'ready',
      baseline: base,
      settings: cfg,
      candidates: [compare(offer('b', 'x'))],
      coverage: { searched: 1, checked: 1, excluded: 0, batches: 1, more: false },
      at: captured,
      message: 'Two checked offers.',
    }).success,
  );
});
