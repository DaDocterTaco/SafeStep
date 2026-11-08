import { z } from 'zod';
import { isPublicComparisonText } from './comparison-privacy.js';
import { mozillaReviewScope } from './source-scope.js';

const short = z.string().trim().min(1).max(180);
const field = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9 _-]{0,39}$/i);
const timestamp = z.iso.datetime({ offset: true });
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:/-]+$/);
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const currencies = new Set(Intl.supportedValuesOf('currency'));
const currency = z.string().refine((s) => currencies.has(s), 'Use a confirmed ISO currency.');
const publicText = z.string().trim().max(240).refine(isPublicComparisonText);
export const ComparePriority = z.enum(['cost', 'feature', 'product', 'seller', 'condition']);
export type ComparePriority = z.infer<typeof ComparePriority>;
export const CompareMode = z.enum([
  'same_product_other_sellers',
  'similar_products',
  'compare_selected',
]);
const priorities = z
  .array(ComparePriority)
  .min(1)
  .max(5)
  .refine((x) => new Set(x).size === x.length);
const preference = z.strictObject({ field, value: publicText.pipe(short) });
// Keep the first source spelling; field, value and inclusion/exclusion together
// identify one rule. Opposite signs and different attributes remain separate.
export function uniqueCompareRules<T extends { field: string; value: string; exclude: boolean }>(
  rules: readonly T[],
): T[] {
  const seen = new Set<string>();
  return rules.filter(rule => {
    const key = JSON.stringify([rule.field.trim().toLowerCase(), rule.value.trim().toLowerCase(), rule.exclude]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export const CompareSettings = z.strictObject({
  mode: CompareMode,
  goal: publicText,
  query: publicText.pipe(z.string().max(100)),
  hard: z.array(preference.extend({ exclude: z.boolean() })).max(16).transform(uniqueCompareRules),
  preferred: z.array(preference).max(8).optional(),
  allowedDifferences: z.array(field).max(16),
  budget: z
    .strictObject({ amount: decimal, currency, basis: z.enum(['item', 'subtotal']) })
    .nullable(),
  quantity: z.number().int().min(1).max(10000),
  priorities,
});
export type CompareSettings = z.infer<typeof CompareSettings>;
export const ComparisonSettings = CompareSettings;
export type ComparisonSettings = CompareSettings;
export function isCanonicalOfferUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (raw.length > 420 || u.href !== raw || u.username || u.password || u.search || u.hash)
      return false;
    if (
      /\/(?:cart|checkout|account|admin|login|logout|buy|buy-now|add-to-cart|make-offer|reserve|messages?|watch|install|download)\/?$/i.test(
        u.pathname,
      )
    )
      return false;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      return /^\/comparison-lab(?:\/[a-zA-Z0-9_.-]+)?\/?$/.test(u.pathname);
    if (u.protocol !== 'https:' || u.port) return false;
    if (u.hostname === 'addons.mozilla.org')
      return /^\/[a-zA-Z-]+\/firefox\/addon\/[a-z0-9_-]+\/$/.test(u.pathname);
    return (
      /^[a-z0-9-]+\.resell\.store$/.test(u.hostname) &&
      !['api', 'docs', 'files', 'www'].includes(u.hostname.split('.')[0]!) &&
      /^\/[a-z0-9-]+\/?$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
function validSource(raw: string) {
  if (isCanonicalOfferUrl(raw)) return true;
  try {
    const u = new URL(raw);
    if (mozillaReviewScope(u)) return true;
    return (
      u.href === raw &&
      u.origin === 'https://api.resell.store' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      /^\/v1\/(?:stores\/[a-z0-9-]+\/reviews|market\/(?:stores\/[a-z0-9-]+|listings\/[a-f0-9-]{36}))$/.test(
        u.pathname,
      )
    );
  } catch {
    return false;
  }
}
export const CompareCost = z.strictObject({
  text: z.string().max(180),
  amount: decimal.nullable(),
  currency: currency.nullable(),
  currencySource: short.nullable(),
  shipping: decimal.nullable(),
  shippingScope: short.nullable(),
  fees: decimal.nullable(),
  tax: short.nullable(),
  basis: z.enum([
    'exact',
    'range',
    'from',
    'bid',
    'subscription',
    'conditional',
    'unknown',
    'not_applicable',
  ]),
});
export type CompareCost = z.infer<typeof CompareCost>;
export const ComparisonAssessment = z
  .strictObject({
    subject: short,
    source: z.string().max(420).refine(validSource),
    captured: timestamp,
    metric: z
      .strictObject({
        label: short,
        value: z.number().nonnegative().finite(),
        scale: z.number().positive().finite(),
        period: short,
        count: z.number().int().nonnegative().max(1_000_000_000).nullable(),
      })
      .refine((m) => m.value <= m.scale)
      .nullable(),
    sample: z.number().int().min(0).max(20),
    summary: z.array(z.string().max(500)).max(16),
    limits: z.array(z.string().max(500)).max(16),
    groups: z.number().int().min(0).max(20).optional(),
    scope: short.optional(),
    metrics: z
      .array(z.strictObject({ label: short, value: short }))
      .max(24)
      .optional(),
    records: z
      .array(
        z.strictObject({
          date: short.nullable(),
          version: short.nullable(),
          rating: z.number().min(0).max(5).nullable(),
          text: z.string().max(500),
        }),
      )
      .max(20)
      .optional(),
  })
  .refine((v) => (v.groups ?? 0) <= v.sample && (v.records?.length ?? 0) <= v.sample);
export type ComparisonAssessment = z.infer<typeof ComparisonAssessment>;
export const Offer = z
  .strictObject({
    market: z.enum(['resell', 'mozilla', 'practice']),
    id,
    title: short,
    url: z.string().refine(isCanonicalOfferUrl),
    family: short,
    catalog: short.nullable(),
    seller: short.nullable(),
    sellerName: short.nullable(),
    attributes: z
      .record(field, short)
      .refine(
        (v) =>
          Object.keys(v).length <= 40 &&
          !Object.keys(v).some((k) => ['constructor', 'prototype', '__proto__'].includes(k)),
      ),
    quantity: z.number().int().min(1).max(10000).nullable(),
    availability: z.enum(['available', 'sold', 'unknown']),
    captured: timestamp,
    cost: CompareCost,
    productEvidence: ComparisonAssessment.nullable(),
    sellerEvidence: ComparisonAssessment.nullable(),
  })
  .superRefine((o, ctx) => {
    if (!URL.canParse(o.url)) return;
    const u = new URL(o.url);
    const market =
      u.hostname === 'addons.mozilla.org'
        ? 'mozilla'
        : u.hostname.endsWith('.resell.store')
          ? 'resell'
          : 'practice';
    if (
      market !== o.market ||
      (o.productEvidence && o.productEvidence.subject !== o.catalog) ||
      (o.sellerEvidence && o.sellerEvidence.subject !== o.seller) ||
      (market === 'mozilla' && (o.sellerEvidence || o.seller || o.sellerName)) ||
      (market === 'resell' && (o.productEvidence || o.seller !== u.hostname.split('.')[0]))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Offer and feedback subjects or channels disagree.',
      });
    for (const evidence of [o.productEvidence, o.sellerEvidence])
      if (evidence) {
        if (!URL.canParse(evidence.source)) continue;
        const cited = new URL(evidence.source);
        if (
          (market === 'practice' && cited.origin !== u.origin) ||
          (market === 'mozilla' &&
            (cited.hostname !== u.hostname ||
              cited.pathname.replace(/reviews\/$/, '') !== u.pathname)) ||
          (market === 'resell' &&
            o.seller &&
            !(
              cited.origin === 'https://api.resell.store' &&
              cited.pathname === '/v1/stores/' + o.seller + '/reviews'
            ))
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Evidence source is outside the identified subject.',
          });
      }
  });
export type Offer = z.infer<typeof Offer>;
export const ComparisonOffer = Offer;
export type ComparisonOffer = Offer;
export const CompareCandidate = z.strictObject({
  offer: Offer,
  fit: z.enum(['confirmed', 'needs_checking', 'incompatible', 'identity_uncertain', 'unavailable']),
  fitReason: z.string().min(1).max(500).optional(),
  reasons: z.array(z.string().max(500)).max(48),
  tradeoffs: z.array(z.string().max(500)).max(48),
  matched: z.array(z.string().max(500)).max(48),
  subtotal: z.string().max(35).nullable(),
  savings: z.string().max(35).nullable(),
  savingsPercent: z.string().max(35).nullable(),
  recommended: z.boolean(),
});
export type CompareCandidate = z.infer<typeof CompareCandidate>;
export function isComparisonSearchSource(raw: string): boolean {
  if (raw.length > 700 || !URL.canParse(raw)) return false;
  const u = new URL(raw),
    p = u.searchParams;
  if (u.href !== raw || u.username || u.password || u.hash) return false;
  const query = p.get('q');
  if (!query || query.length > 100 || !publicText.safeParse(query).success) return false;
  for (const key of p.keys()) if (p.getAll(key).length !== 1) return false;
  const only = (keys: string[]) => [...p.keys()].every((k) => keys.includes(k));
  const offset = /^(0|12|24)$/.test(p.get('offset') ?? '');
  if (u.origin === 'https://api.resell.store' && u.pathname === '/v1/market/search')
    return (
      only(['q', 'category', 'limit', 'offset']) &&
      p.get('limit') === '12' &&
      offset &&
      (!p.has('category') || publicText.pipe(short).safeParse(p.get('category')).success)
    );
  if (u.origin === 'https://addons.mozilla.org' && u.pathname === '/api/v5/addons/search/')
    return (
      only(['q', 'app', 'type', 'page', 'page_size', 'lang']) &&
      p.get('app') === 'firefox' &&
      p.get('type') === 'extension' &&
      p.get('page_size') === '12' &&
      /^[123]$/.test(p.get('page') ?? '') &&
      p.get('lang') === 'en-US'
    );
  return (
    u.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
    u.pathname === '/comparison-lab/source/search' &&
    only(['q', 'offset', 'mode']) &&
    offset &&
    CompareMode.safeParse(p.get('mode')).success
  );
}
export const CompareView = z
  .strictObject({
    id: z.uuid(),
    version: z.number().int().positive(),
    status: z.enum([
      'idle',
      'needs_baseline',
      'clarify',
      'searching',
      'checking_candidates',
      'comparing',
      'ready',
      'partial',
      'no_matches',
      'only_baseline',
      'needs_checking',
      'source_unavailable',
      'unsupported',
      'stale',
      'cancelled',
      'paused',
    ]),
    baseline: Offer.nullable(),
    settings: CompareSettings,
    candidates: z.array(CompareCandidate).max(3),
    coverage: z.strictObject({
      searched: z.number().int().min(0).max(36),
      checked: z.number().int().min(0).max(36),
      excluded: z.number().int().min(0).max(36),
      batches: z.number().int().min(0).max(3),
      more: z.boolean(),
    }),
    at: timestamp,
    message: z.string().max(500),
    searchSource: z.string().refine(isComparisonSearchSource).optional(),
    excludedReasons: z.array(z.string().min(1).max(500)).max(6).optional(),
    ai: z.string().max(500).optional(),
    explanation: z.array(z.string().max(500)).max(8).optional(),
    explanationOffers: z.array(z.string().max(160).nullable()).max(8).optional(),
  })
  .superRefine((view, ctx) => {
    if (!view.searchSource || !URL.canParse(view.searchSource)) return;
    const u = new URL(view.searchSource),
      market = view.baseline?.market;
    const rightSource =
      (market === 'resell' && u.origin === 'https://api.resell.store') ||
      (market === 'mozilla' && u.origin === 'https://addons.mozilla.org') ||
      (market === 'practice' &&
        view.baseline &&
        URL.canParse(view.baseline.url) &&
        u.origin === new URL(view.baseline.url).origin);
    if (!rightSource || u.searchParams.get('q') !== view.settings.query)
      ctx.addIssue({
        code: 'custom',
        message: 'Discovery source does not match this baseline and query.',
      });
  });
export type CompareView = z.infer<typeof CompareView>;
const bound = { session: z.uuid(), version: z.number().int().positive() };
export const CompareAction = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('prepare') }),
  z.strictObject({
    ...bound,
    op: z.enum(['find', 'edit', 'interpret']),
    settings: CompareSettings,
  }),
  z.strictObject({
    ...bound,
    op: z.enum(['more', 'refresh', 'cancel', 'keep', 'clear', 'explain']),
  }),
  z.strictObject({
    ...bound,
    op: z.literal('add'),
    url: z.string().max(420).refine(isCanonicalOfferUrl),
  }),
  z.strictObject({ ...bound, op: z.enum(['open', 'remove']), id }),
  z.strictObject({ ...bound, op: z.literal('openSource'), url:z.string().max(420).refine(validSource) }),
  z.strictObject({ ...bound, op: z.literal('sort'), priorities }),
]);
export type CompareAction = z.infer<typeof CompareAction>;
export const CompareCommand = z.strictObject({ kind: z.literal('compare'), action: CompareAction });
export type CompareCommand = z.infer<typeof CompareCommand>;
export function defaultCompareSettings(baseline?: Offer | null): CompareSettings {
  return {
    mode: 'same_product_other_sellers',
    goal: '',
    query: baseline?.title.slice(0, 100) ?? '',
    hard: [],
    allowedDifferences: [],
    budget: null,
    quantity: baseline?.quantity ?? 1,
    priorities: ['cost'],
  };
}

// Amounts use a fixed six-decimal integer scale locally; the wire carries decimal strings only.
const million = 1_000_000n;
function scaled(amount: string | null): bigint | null {
  if (amount === null || !decimal.safeParse(amount).success) return null;
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole!) * million + BigInt(fraction.padEnd(6, '0'));
}
function display(n: bigint) {
  const fraction = (n % million).toString().padStart(6, '0').replace(/0+$/, '');
  return (n / million).toString() + (fraction ? '.' + fraction : '');
}
function confirmedCurrency(c: CompareCost) {
  return !!(c.currency && currencies.has(c.currency) && c.currencySource?.trim());
}
function fresh(captured: string, now: number) {
  const age = now - Date.parse(captured);
  return age >= 0 && age < 300000;
}
function subtotal(o: Offer): bigint | null {
  const c = o.cost,
    item = scaled(c.amount),
    shipping = scaled(c.shipping),
    fees = scaled(c.fees);
  if (
    c.basis !== 'exact' ||
    !confirmedCurrency(c) ||
    item === null ||
    shipping === null ||
    fees === null ||
    !o.quantity ||
    !c.shippingScope?.trim()
  )
    return null;
  return item + shipping + fees;
}
export function comparableSubtotal(o: Offer, now = Date.now()): string | null {
  const n = fresh(o.captured, now) ? subtotal(o) : null;
  return n === null ? null : display(n);
}
const normal = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const variantFields = [
  'model',
  'isbn',
  'edition',
  'printing',
  'format',
  'size',
  'capacity',
  'nib',
  'condition',
  'accessories',
  'bundle',
  'color',
  'platform',
  'version',
];
function attr(o: Offer, key: string): string | null {
  const f = normal(key);
  if (f === 'seller') return o.seller;
  if (f === 'catalog') return o.catalog;
  if (f === 'quantity') return o.quantity === null ? null : String(o.quantity);
  if (f === 'family') return o.family;
  if (f === 'delivery' && o.cost.shippingScope) return o.cost.shippingScope;
  return Object.entries(o.attributes).find(([k]) => normal(k) === f)?.[1] ?? null;
}
function same(a: string | null, b: string | null) {
  return a !== null && b !== null && normal(a) === normal(b);
}
const nibWidths = new Map([
  ['ef', 'extra fine'], ['xf', 'extra fine'], ['extra fine', 'extra fine'],
  ['f', 'fine'], ['fine', 'fine'], ['m', 'medium'], ['medium', 'medium'],
  ['b', 'broad'], ['broad', 'broad'], ['bb', 'double broad'], ['double broad', 'double broad'],
]);
function nibRequirement(observed: string, requested: string): boolean | null {
  const words = (text: string) => normal(text).replace(/[-‐‑‒–—]+/g, ' ').replace(/\s+/g, ' ');
  const accepted = words(requested).split(/\s+or\s+/).map(x => nibWidths.get(x));
  if (accepted.some(x => !x)) return same(observed, requested) ? true : null;
  const source = words(observed);
  if (/\b(?:not|no|without|unknown|unspecified|possibly|maybe|or)\b|[?/]/.test(source)) return null;
  // Read width from its named nib attribute. Keep “extra fine” distinct from “fine”.
  const matches = source.match(/\b(?:extra fine|double broad|fine|medium|broad|ef|xf|bb|f|m|b)\b/g) ?? [];
  const widths = [...new Set(matches.map(x => nibWidths.get(x)))];
  return widths.length === 1 ? accepted.includes(widths[0]) : null;
}
function deliveryRequirement(cost: CompareCost, observed: string, requested: string): boolean | null {
  const scope = normal(observed), goal = normal(requested);
  if (scope === goal) return true;
  const pickupOnly = /^(?:(?:local |store )?pickup only|collection only)$/.test(scope);
  const method = scope.replace(/; destination eligibility unknown$/, '');
  const shipping = /\b(?:shipping|delivery)\b/.test(method) &&
    !/\b(?:no|not|unknown|unconfirmed|unavailable|unspecified|may|might|excluded)\b/.test(method);
  if (/^(?:pickup only|local pickup only|collection only)$/.test(goal)) return pickupOnly || (shipping ? false : null);
  if (/^(?:delivery|shipping|delivery required)$/.test(goal)) return shipping || (pickupOnly ? false : null);
  if (/^free (?:delivery|shipping)$/.test(goal)) {
    if (pickupOnly) return false;
    const amount = scaled(cost.shipping);
    return shipping && amount !== null ? amount === 0n : null;
  }
  // A quoted shipping charge does not establish delivery to any particular region.
  if (pickupOnly && /\b(?:deliver(?:y|ed)?|ship(?:ping|ped)?)\b/.test(goal)) return false;
  return null;
}
function matchesRequirement(field: string, observed: string, requested: string, cost: CompareCost) {
  if (normal(field) === 'nib') return nibRequirement(observed, requested);
  if (normal(field) === 'delivery') return deliveryRequirement(cost, observed, requested);
  if (same(observed, requested)) return true;
  // A release channel can be embedded in the catalog's version (e.g. 1.2b4).
  if (normal(field) === 'version' && /^(?:beta|beta versions?)$/.test(normal(requested)))
    return /(?:^|[^a-z])beta(?:$|[^a-z])|\d[.-]?b\d+(?:$|[^a-z0-9])/i.test(observed);
  return false;
}
function promoted(o: Offer) {
  return same(attr(o, 'promoted'), 'true') || same(attr(o, 'sponsored'), 'true');
}
function validIsbn(raw: string) {
  const x = raw.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{13}$/.test(x))
    return (
      /^(978|979)/.test(x) &&
      [...x].reduce((sum, d, i) => sum + Number(d) * (i % 2 ? 3 : 1), 0) % 10 === 0
    );
  if (/^\d{9}[\dX]$/.test(x))
    return (
      [...x].reduce((sum, d, i) => sum + (d === 'X' ? 10 : Number(d)) * (10 - i), 0) % 11 === 0
    );
  return false;
}
function identity(o: Offer) {
  if (!o.catalog) return null;
  const isbn = attr(o, 'isbn');
  if (isbn && !validIsbn(isbn)) return null;
  if (o.market !== 'mozilla' && normal(o.catalog) === normal(o.title) && !attr(o, 'model') && !isbn)
    return null;
  return o.catalog;
}
const fitOrder = {
  confirmed: 0,
  needs_checking: 1,
  identity_uncertain: 2,
  incompatible: 3,
  unavailable: 4,
};
function assess(b: Offer, o: Offer, s: CompareSettings, now: number): CompareCandidate {
  const c: CompareCandidate = {
    offer: o,
    fit: 'confirmed',
    matched: [],
    tradeoffs: [],
    reasons: [],
    savings: null,
    savingsPercent: null,
    subtotal: comparableSubtotal(o, now),
    recommended: false,
  };
  const issue = (state: CompareCandidate['fit'], why: string) => {
    if (fitOrder[state] > fitOrder[c.fit]) {
      c.fit = state;
      c.fitReason = why;
    }
    c.tradeoffs.push(why);
  };
  const allowed = (k: string) =>
    s.mode !== 'same_product_other_sellers' && s.allowedDifferences.some((v) => normal(v) === k);
  if (b.market !== o.market || !same(b.family, o.family))
    issue('incompatible', 'The product belongs to a different source or family.');
  if (o.availability === 'sold')
    issue('unavailable', 'The source marks this offer sold or unavailable.');
  if (o.availability === 'unknown') issue('needs_checking', 'Availability is unknown.');
  if (!fresh(o.captured, now) || !fresh(b.captured, now))
    issue('needs_checking', 'Comparison evidence needs an explicit refresh.');
  if (promoted(o))
    c.tradeoffs.push(
      'Source-marked promotion. Shown for information and excluded from default recommendations.',
    );
  const badge = attr(o, 'publisher badge');
  if (badge)
    c.tradeoffs.push(
      'Publisher program: ' +
        badge +
        '. The comparison uses the published product and service facts.',
    );
  if (o.quantity === null) issue('needs_checking', 'Quantity is unknown.');
  else if (o.quantity !== s.quantity)
    issue('incompatible', 'Offered quantity differs from the requirement.');
  const baseId = identity(b),
    candidateId = identity(o),
    sameProduct = baseId !== null && candidateId === baseId;
  if (!baseId || !candidateId)
    issue('identity_uncertain', 'A strong product or edition identifier is unavailable.');
  else if (sameProduct) c.matched.push('Same source product identifier: ' + baseId);
  else if (!allowed('model') && !allowed('product') && !allowed('catalog'))
    issue('incompatible', 'Different catalog/model identity was not allowed.');
  else c.reasons.push('Different product/model allowed: ' + candidateId);
  if (s.mode === 'same_product_other_sellers') {
    if (!b.seller || !o.seller)
      issue('needs_checking', 'The other seller’s exact identity is unavailable.');
    else if (b.seller === o.seller)
      issue('incompatible', 'Both listings belong to the same seller.');
    else c.matched.push('Distinct seller account: ' + o.seller);
  }
  const basePurpose = attr(b, 'purpose'),
    otherPurpose = attr(o, 'purpose');
  if (!sameProduct) {
    if (!basePurpose || !otherPurpose)
      issue('needs_checking', 'Product purpose is not established by source facts.');
    else if (!same(basePurpose, otherPurpose))
      issue('incompatible', 'The source describes a different product purpose.');
    else c.matched.push('Source-stated purpose: ' + otherPurpose);
  }
  for (const field of variantFields) {
    const a = attr(b, field),
      v = attr(o, field);
    if (field === 'isbn' && ((a && !validIsbn(a)) || (v && !validIsbn(v)))) continue;
    const book = same(b.family, 'book'),
      pen = same(b.family, 'fountain pen');
    const essential =
      (field === 'condition' && b.market !== 'mozilla') ||
      (field === 'nib' && pen) ||
      (field === 'platform' && b.market === 'mozilla') ||
      (field === 'printing' && book && s.mode === 'same_product_other_sellers');
    const explicitCondition =
      field === 'condition' && s.hard.some((h) => normal(h.field) === 'condition' && !h.exclude);
    if (
      explicitCondition ||
      allowed(field) ||
      (field === 'model' && (allowed('product') || allowed('catalog')))
    ) {
      if (a && v && !same(a, v)) c.tradeoffs.push(field + ' differs: ' + a + ' → ' + v + '.');
      else if (a && !v) c.tradeoffs.push(field + ' is not disclosed for this option.');
      continue;
    }
    if (!a && !essential) continue;
    if (!a || !v) issue('needs_checking', 'Required ' + field + ' is unconfirmed.');
    else if (!same(a, v)) issue('incompatible', field + ' differs: ' + a + ' → ' + v + '.');
    else c.matched.push(field + ' matches: ' + v);
  }
  for (const h of s.hard) {
    const v = attr(o, h.field);
    const match = v === null ? null : matchesRequirement(h.field, v, h.value, o.cost);
    if (match === null) issue('needs_checking', 'Cannot confirm '+h.field+' “'+h.value+'” from this offer’s source evidence.');
    else if (match === h.exclude)
      issue(
        'incompatible',
        h.field +
          ' conflicts with the requested ' +
          (h.exclude ? 'exclusion' : 'value') +
          ': ' +
          h.value +
          '.',
      );
    else c.matched.push(h.field + ': ' + v);
  }
  const m = o.cost;
  if (s.budget) {
    const n =
      s.budget.basis === 'subtotal' ? subtotal(o) : m.basis === 'exact' ? scaled(m.amount) : null;
    if (!confirmedCurrency(m) || m.currency !== s.budget.currency || n === null)
      issue(
        'needs_checking',
        'Cannot verify the ' + s.budget.currency + ' ' + s.budget.basis + ' budget.',
      );
    else if (n > scaled(s.budget.amount)!)
      issue('incompatible', 'Exceeds the stated ' + s.budget.basis + ' budget.');
    else
      c.matched.push(
        'Within ' + s.budget.currency + ' ' + s.budget.amount + ' ' + s.budget.basis + ' budget.',
      );
  }
  if (m.basis !== 'not_applicable') {
    if (!confirmedCurrency(m))
      c.tradeoffs.push('Currency unconfirmed; numeric savings unavailable.');
    if (m.shipping === null) c.tradeoffs.push('Shipping is unknown.');
    if (m.fees === null) c.tradeoffs.push('Mandatory fee coverage is unknown.');
    if (m.basis !== 'exact')
      c.tradeoffs.push('Price basis: ' + m.basis + '; an exact one-time price is unavailable.');
  }
  if (!o.productEvidence) c.tradeoffs.push('Product review evidence is unavailable.');
  if (!o.sellerEvidence) c.tradeoffs.push('Seller feedback is unavailable.');
  else if ((o.sellerEvidence.metric?.count ?? 0) < 5 || (o.sellerEvidence.groups ?? 0) < 2)
    c.tradeoffs.push('Sparse seller feedback does not establish a service advantage.');
  if (o.productEvidence && o.productEvidence.subject === b.productEvidence?.subject)
    c.tradeoffs.push('Shared catalog feedback applies to both offers.');
  const version = attr(o, 'version');
  if (version && o.productEvidence?.records?.some((r) => r.version && !same(r.version, version)))
    c.tradeoffs.push(
      'The inspected reviews include another version; these are not solely current-version observations.',
    );
  return c;
}

function equalCostBasis(b: Offer, o: Offer, now: number) {
  const c = b.cost,
    d = o.cost;
  return (
    fresh(b.captured, now) &&
    fresh(o.captured, now) &&
    b.availability === 'available' &&
    o.availability === 'available' &&
    b.market === o.market &&
    same(b.family, o.family) &&
    b.quantity !== null &&
    b.quantity === o.quantity &&
    confirmedCurrency(c) &&
    confirmedCurrency(d) &&
    c.currency === d.currency &&
    same(c.shippingScope, d.shippingScope) &&
    (b.market === 'mozilla' || same(attr(b, 'condition'), attr(o, 'condition'))) &&
    ['edition', 'printing', 'format', 'size', 'capacity', 'nib', 'accessories', 'bundle'].every(
      (k) => {
        const a = attr(b, k),
          v = attr(o, k);
        return (a === null && v === null) || same(a, v);
      },
    ) &&
    subtotal(b) !== null &&
    subtotal(o) !== null
  );
}
function comparableRating(b: Offer, o: Offer, p: 'product' | 'seller', now: number) {
  const base = p === 'product' ? b.productEvidence : b.sellerEvidence,
    other = p === 'product' ? o.productEvidence : o.sellerEvidence;
  if (
    b.market !== o.market ||
    !base ||
    !other ||
    base.subject === other.subject ||
    !fresh(base.captured, now) ||
    !fresh(other.captured, now)
  )
    return null;
  const a = base.metric,
    v = other.metric;
  if (
    !a ||
    !v ||
    !a.count ||
    !v.count ||
    a.scale !== v.scale ||
    !same(a.label, v.label) ||
    !same(a.period, v.period)
  )
    return null;
  if (
    p === 'seller' &&
    (Math.min(a.count, v.count) < 5 || Math.min(base.groups ?? 0, other.groups ?? 0) < 2)
  )
    return null;
  return [a, v] as const;
}
function preferenceDelta(b: Offer, o: Offer, p: ComparePriority, s: CompareSettings) {
  const prefs = (s.preferred ?? []).filter(
    (f) => (normal(f.field) === 'condition') === (p === 'condition'),
  );
  let delta = 0;
  for (const f of prefs) {
    const a = attr(b, f.field),
      v = attr(o, f.field);
    if (a === null || v === null) return null;
    delta += Number(same(v, f.value)) - Number(same(a, f.value));
  }
  return prefs.length ? delta : null;
}
function priorityDelta(
  b: Offer,
  c: CompareCandidate,
  p: ComparePriority,
  s: CompareSettings,
  now: number,
): number | bigint | null {
  const o = c.offer;
  if (p === 'cost') return equalCostBasis(b, o, now) ? subtotal(b)! - subtotal(o)! : null;
  if (p === 'seller' || p === 'product') {
    const m = comparableRating(b, o, p, now);
    return m ? m[1].value - m[0].value : null;
  }
  return preferenceDelta(b, o, p, s);
}
export function offerKey(o: Offer) {
  return JSON.stringify([o.market, o.id, variantFields.map((f) => attr(o, f))]);
}
export function evaluateComparison(
  b: Offer,
  offers: Offer[],
  s: CompareSettings,
  now = Date.now(),
): CompareCandidate[] {
  const seen = new Set([offerKey(b)]);
  const rows: CompareCandidate[] = [];
  for (const o of offers) {
    const key = offerKey(o);
    if (seen.has(key)) continue;
    seen.add(key);
    const c = assess(b, o, s, now);
    if (c.fit === 'confirmed') {
      const difference = priorityDelta(b, c, 'cost', s, now);
      if (typeof difference === 'bigint' && difference > 0n) {
        c.savings = display(difference);
        const base = subtotal(b)!;
        if (base > 0n) {
          const hundredths = (difference * 10_000n + base / 2n) / base;
          c.savingsPercent = display(hundredths * 10_000n);
        }
        c.reasons.push(
          'Lower listed pre-tax subtotal by ' +
            o.cost.currency +
            ' ' +
            c.savings +
            ' among checked options; tax and duties excluded.',
        );
      }
      for (const channel of ['product', 'seller'] as const) {
        const m = comparableRating(b, o, channel, now);
        if (m && m[1].value > m[0].value)
          c.reasons.push(
            'Higher published ' +
              channel +
              ' ' +
              m[1].label +
              ': ' +
              m[1].value +
              '/' +
              m[1].scale +
              ' (' +
              m[1].count +
              ' ratings, ' +
              m[1].period +
              ').',
          );
      }
      for (const f of s.preferred ?? [])
        if (same(attr(o, f.field), f.value) && attr(b, f.field) && !same(attr(b, f.field), f.value))
          c.reasons.push('Matches preferred ' + f.field + ': ' + f.value + '.');
    }
    if (!c.tradeoffs.length)
      c.tradeoffs.push('Published facts cover only the inspected sources and capture time.');
    rows.push(c);
  }
  const metrics = new Map(
    rows.map((c) => [
      c,
      s.priorities.map((p) => (c.fit === 'confirmed' ? priorityDelta(b, c, p, s, now) : null)),
    ]),
  );
  function compare(a: CompareCandidate, v: CompareCandidate) {
    const fit = fitOrder[a.fit] - fitOrder[v.fit];
    if (fit) return fit;
    if (promoted(a.offer) !== promoted(v.offer)) return promoted(a.offer) ? 1 : -1;
    for (let i = 0; i < s.priorities.length; i++) {
      const x = metrics.get(a)![i] ?? null,
        y = metrics.get(v)![i] ?? null;
      if (x === y) continue;
      if (x === null || y === null) return x === null ? 1 : -1;
      if (x !== y) return x > y ? -1 : 1;
    }
    return 0;
  }
  rows.sort(compare);
  const first = rows[0];
  function outperforms(candidate: CompareCandidate, other: CompareCandidate | null) {
    for (let i = 0; i < s.priorities.length; i++) {
      const x = metrics.get(candidate)![i],
        y = other ? metrics.get(other)![i] : 0;
      if (x == null || y == null) return false;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }
  if (first?.fit === 'confirmed' && !promoted(first.offer)) {
    first.recommended =
      outperforms(first, null) &&
      rows
        .slice(1)
        .every((c) => c.fit !== 'confirmed' || promoted(c.offer) || outperforms(first, c));
  }
  for (const c of rows)
    if (!c.reasons.length)
      c.reasons.push(
        c.fit === 'confirmed'
          ? 'No confirmed advantage over the original on the stated priorities.'
          : 'Keep original; this option does not meet all confirmed requirements.',
      );
  // The owner retains the excluded reasons/count; only its PanelView contains
  // the three visible alternatives.
  return rows;
}
