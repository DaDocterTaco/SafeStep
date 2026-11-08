import { z } from 'zod';
import {
  Offer,
  isCanonicalOfferUrl,
  publicExcerpt,
  safeLabel,
  shoppingThemes,
  textGroup,
  CompareSettings,
  type CompareCost,
  ComparisonAssessment,
  type ShoppingKind,
} from '@safestep/contracts';
import {
  blankSourceSubject,
  readMozilla,
  readPublicJSON,
  readResell,
  shoppingRoute,
} from './shopping';

const marketAPI = 'https://api.resell.store/v1',
  amo = 'https://addons.mozilla.org',
  usdContract = 'Resell v1 API money contract · docs.resell.store/api';
const slug = z.string().regex(/^[a-z0-9-]{1,63}$/),
  listingSlug = z.string().regex(/^[a-z0-9-]{1,160}$/);
const listing = z.object({
  id: z.uuid(),
  slug: listingSlug,
  store: slug,
  url: z.url(),
  title: z.string().min(1).max(240),
});
const placement = z.object({
  sponsored: z.boolean().optional(),
  is_sponsored: z.boolean().optional(),
});
const store = z.object({
  object: z.literal('store'),
  slug,
  name: z.string().max(160),
  paused: z.boolean().optional(),
  listings: z.array(listing).max(150),
});
const amount = z.string().max(80).nullable().optional();
const detail = listing.extend({
  ...placement.shape,
  object: z.literal('public_listing'),
  sold: z.boolean().nullable().optional(),
  price: amount,
  shipping: amount,
  category: z.string().optional(),
  details: z
    .array(z.object({ label: z.string().max(100), value: z.string().max(500) }))
    .max(40)
    .optional(),
});
const localized = z.union([z.string(), z.record(z.string(), z.string())]);
const catalog = z.object({
  ...placement.shape,
  promoted: z
    .array(z.object({ category: z.string().max(80) }))
    .max(20)
    .nullable()
    .optional(),
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9_-]{1,80}$/),
  url: z.url(),
  type: z.string(),
  status: z.string(),
  is_disabled: z.boolean().optional(),
  name: localized,
  authors: z
    .array(z.object({ name: z.string().trim().min(1).max(100).catch('') }))
    .max(30)
    .catch([]),
  summary: localized.nullable().optional(),
  tags: z.array(z.string()).max(60).optional(),
  current_version: z.object({
    version: z.string().min(1).max(100),
    compatibility: z
      .record(z.string(), z.object({ min: z.string().optional(), max: z.string().optional() }))
      .optional(),
  }),
});
const clean = (s: unknown) => {
  const t = publicExcerpt(s);
  return /ignore (?:all|previous)|system prompt|javascript:/i.test(t) ? '' : t.slice(0, 180);
};
const localText = (s: z.infer<typeof localized> | null | undefined) =>
  clean(typeof s === 'string' ? s : (s?.['en-US'] ?? s?.en));
const adClaim =
  /\bad[- ]?block(?:er|ing)?s?\b|\bblock(?:s|ing)?\s+(?:(?:annoying|intrusive|online)\s+)?(?:ads|advertisements|advertising)\b/gi;
const trackerClaim =
  /\b(?:tracking protection|anti[- ]tracker|tracker block(?:er|ing))\b|\b(?:stops?|stopping|blocks?|blocking)\s+(?:ads(?:,\s*| and )\s*)?(?:trackers|tracking)\b/gi;
function publisherClaim(summary: string, terms: RegExp, tagged: boolean): 'yes' | 'no' | undefined {
  // An abbreviated or unsafe excerpt can omit the publisher's qualification.
  const text = summary.trim().replace(/\s+/g, ' ');
  if (!text || text !== publicExcerpt(text) || !clean(text)) return undefined;
  const clauses = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[.!?;]|\b(?:but|however)\b/);
  let positive = false,
    negative = false,
    ambiguous = false;
  for (const clause of clauses) {
    for (const match of clause.matchAll(terms)) {
      const before = clause.slice(0, match.index),
        after = clause.slice(match.index + match[0].length);
      if (
        /\b(?:not|no|without|never|cannot|\w+n't)\s+(?:(?:an?|the|any|actually|currently|support|provide|offer|include|enable|have|do)\s+)*$/.test(
          before,
        ) ||
        /^\s+(?:(?:is|are)\s+)?(?:unavailable|unsupported|disabled|not (?:available|supported|included|provided))\b/.test(
          after,
        )
      ) {
        negative = true;
      } else if (
        /\b(?:detects?|disable[sd]?|compares?|comparison|requires?|bypass(?:es)?|compatible with|works with|alongside|recommend(?:s|ed)?|instead of|may|might|could|planned|coming soon|without|not|never|\w+n't)\b/.test(
          before,
        ) ||
        /^\s+(?:detector|detection|tutorial|remover|bypass)\b/.test(after)
      ) {
        ambiguous = true;
      } else positive = true;
    }
  }
  if (ambiguous || (negative && (positive || tagged))) return undefined;
  if (negative) return 'no';
  if (positive) return 'yes';
  // A specific capability tag can clarify a publisher's generic content-blocker
  // description (e.g. uBlock Origin). A category tag on its own is insufficient.
  if (
    tagged &&
    /\bcontent blocker\b/i.test(text) &&
    !/\b(?:not|without|never|no|\w+n't)\b/i.test(text)
  )
    return 'yes';
  return undefined;
}
function mozillaDevelopers(authors: z.infer<typeof catalog>['authors']): string | undefined {
  const names = new Set<string>();
  let omitted = false;
  for (const { name } of authors) {
    const label = clean(name);
    if (!label || !safeLabel(label) || /[\u202a-\u202e\u2066-\u2069]/u.test(label)) {
      omitted = true;
      continue;
    }
    if (names.has(label)) continue;
    const joined = [...names, label].join(', ');
    if (names.size >= 4 || joined.length > 150) omitted = true;
    else names.add(label);
  }
  if (!names.size) return undefined;
  return [...names].join(', ') + (omitted ? ' (partial list)' : '');
}
function decimal(n: string | undefined | null) {
  if (n == null) return null;
  const s = String(n);
  return /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(s) ? s : null;
}
function priceBasis(label: string, amount: string | null): CompareCost['basis'] {
  if (!label) return amount === null ? 'unknown' : 'exact';
  if (/\b(?:auction|bid)\b/i.test(label)) return 'bid';
  if (/\b(?:subscription|recurring|per month|monthly subscription)\b/i.test(label))
    return 'subscription';
  if (
    /\b(?:coupon|member|members|installments?|instalments?|financing|trade[ -]?in)\b/i.test(label)
  )
    return 'conditional';
  if (/\brange\b|\d\s*[-–]\s*\D?\d/i.test(label)) return 'range';
  if (/\b(?:from|starting at)\b/i.test(label)) return 'from';
  if (amount !== null && /^(?:fixed(?: price)?|one[ -]time(?: price)?|exact)$/i.test(label))
    return 'exact';
  return 'unknown';
}

export function comparisonRoute(raw: URL): string | null {
  const u = new URL(raw);
  if (u.username || u.password || u.href.length > 2048) return null;
  u.hash = '';
  if (
    u.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
    /^\/comparison-lab(?:\/[a-z0-9-]{1,80})?\/?$/.test(u.pathname)
  ) {
    u.search = '';
    return u.href;
  }
  const scope = shoppingRoute(u);
  if (scope?.market === 'resell' && u.hostname !== 'api.resell.store' && u.pathname !== '/') {
    u.search = '';
    u.pathname = u.pathname.replace(/\/$/, '');
    return u.href;
  }
  if (scope?.market === 'mozilla') {
    const review = /\/reviews\/?$/.test(u.pathname),
      q = new URLSearchParams();
    if (review) {
      for (const key of ['score', 'page']) {
        const vals = u.searchParams.getAll(key);
        if (
          vals.length > 1 ||
          (vals[0] && !(key === 'score' ? /^[1-5]$/ : /^[1-3]$/).test(vals[0]))
        )
          return null;
        if (vals[0]) q.set(key, vals[0]);
      }
    }
    const out = new URL(
      amo + '/en-US/firefox/addon/' + scope.key + '/' + (review ? 'reviews/' : ''),
    );
    out.search = q.toString();
    return out.href;
  }
  return null;
}
function marketOf(u: URL): Offer['market'] {
  if (u.origin === amo) return 'mozilla';
  if (u.protocol === 'http:') return 'practice';
  return 'resell';
}
export type ComparisonReserve = (
  market: Offer['market'],
  kind: ShoppingKind,
  subject: string,
  scope: string,
) => Promise<boolean>;
export type SearchPage = { urls: string[]; returned: number; hasMore: boolean; source: string };

function evidence(
  d: ReturnType<typeof blankSourceSubject>,
  subject: string,
): ComparisonAssessment | null {
  if (!d.source) return null;
  const avg = d.metrics.find((m) => m.unit === 'stars' && m.scale === 5),
    count = d.metrics.find((m) => ['Total ratings', 'Published shop ratings'].includes(m.label));
  const groups = new Set(d.records.filter((r) => r.text && !r.automated).map(textGroup)).size;
  const themes = shoppingThemes(d.kind, d.records);
  return {
    subject,
    source: d.source,
    captured: d.captured,
    sample: d.records.length,
    groups,
    scope: d.filter,
    metric: avg
      ? {
          label: avg.label,
          value: avg.value,
          scale: 5,
          count: count?.value ?? null,
          period: avg.period,
        }
      : null,
    metrics: d.metrics.map((m) => ({ label: m.label, value: String(m.value) })).slice(0, 16),
    summary: themes.map(
      (t) => t.label + ' · ' + t.tone + ' · ' + t.ids.length + ' distinct sampled comments',
    ),
    records: d.records.map((r) => ({
      date: r.published,
      version: r.version,
      rating: r.rating,
      text: r.text,
    })),
    limits: [
      d.scope,
      d.filter,
      d.note,
      d.limited
        ? 'Coverage is bounded to this source page.'
        : 'Coverage is the cited response only.',
    ].filter(Boolean),
  };
}
const unavailableCost: CompareCost = {
  text: 'No checkout price supplied; shipping does not apply to this catalog.',
  amount: null,
  currency: null,
  currencySource: null,
  shipping: null,
  shippingScope: null,
  fees: null,
  tax: null,
  basis: 'not_applicable',
};
function isbn(value: string | undefined) {
  if (!value) return null;
  const s = value.replace(/[-\s]/g, '').toUpperCase();
  if (
    /^\d{9}[\dX]$/.test(s) &&
    [...s].reduce((a, c, i) => a + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0
  )
    return s;
  if (
    /^\d{13}$/.test(s) &&
    [...s].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0
  )
    return s;
  return null;
}
function resellCanonical(x: z.infer<typeof listing>) {
  return (
    x.url === 'https://' + x.store + '.resell.store/' + x.slug &&
    comparisonRoute(new URL(x.url)) === x.url
  );
}
export class ComparisonSource {
  requests = 0;
  private readonly origin: URL;
  private readonly market: Offer['market'];
  private readonly signal: AbortSignal;
  private readonly responses = new Map<string, Promise<unknown>>();
  private readonly sellers = new Map<string, Promise<ComparisonAssessment | null>>();
  private readonly practiceEvidence = new Map<string, Promise<ComparisonAssessment | null>>();
  private readonly hints = new Map<string, string | number>();
  private readonly placements = new Set<string>();
  private readonly lanes: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
  private scheduled = 0;
  constructor(
    ownerURL: URL,
    signal: AbortSignal,
    private reserve?: ComparisonReserve,
  ) {
    const validated = comparisonRoute(ownerURL);
    if (!validated) throw Error('Unsupported comparison page.');
    this.origin = new URL(validated);
    this.market = marketOf(this.origin);
    this.signal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  }
  private get = (url: string, _unused?: AbortSignal): Promise<unknown> => {
    this.signal.throwIfAborted();
    const existing = this.responses.get(url);
    if (existing) return existing;
    const n = this.scheduled++ % 2,
      pending = this.lanes[n]!.then(async () => {
        this.signal.throwIfAborted();
        if (this.requests >= 20) throw Error('The 20-request comparison limit was reached.');
        this.requests++;
        return readPublicJSON(
          url,
          AbortSignal.any([this.signal, AbortSignal.timeout(8000)]),
          this.market === 'resell',
        );
      });
    this.responses.set(url, pending);
    this.lanes[n] = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  private validated(raw: URL, allowScope: boolean) {
    const value = comparisonRoute(raw);
    if (!value || (!allowScope && (!isCanonicalOfferUrl(raw.href) || raw.search || raw.hash)))
      throw Error('Unsupported canonical comparison link.');
    const url = new URL(value);
    if (
      marketOf(url) !== this.market ||
      (this.market === 'practice' && url.origin !== this.origin.origin)
    )
      throw Error('Offers must belong to the baseline source family.');
    return url;
  }
  baseline(url: URL) {
    return this.resolve(this.validated(url, true));
  }
  offer(url: URL) {
    return this.resolve(this.validated(url, false));
  }
  private async resolve(url: URL) {
    this.signal.throwIfAborted();
    const data =
      this.market === 'practice'
        ? await this.practice(url)
        : this.market === 'resell'
          ? await this.physical(url)
          : await this.software(url);
    this.signal.throwIfAborted();
    return Offer.parse(data);
  }
  async search(settings: CompareSettings, offset: number): Promise<SearchPage> {
    settings = CompareSettings.parse(settings);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= 36 ||
      offset % 12 ||
      !settings.query.trim()
    )
      throw Error('Use a confirmed query and supported page.');
    const params = new URLSearchParams({ q: settings.query });
    if (this.market === 'practice') {
      params.set('offset', String(offset));
      params.set('mode', settings.mode);
      const source = this.origin.origin + '/comparison-lab/source/search?' + params;
      const page = z
        .object({ urls: z.array(z.string()).max(12), hasMore: z.boolean() })
        .parse(await this.get(source));
      const urls = page.urls.filter((s) => {
        try {
          const u = new URL(s);
          return (
            u.origin === this.origin.origin && isCanonicalOfferUrl(s) && comparisonRoute(u) === s
          );
        } catch {
          return false;
        }
      });
      return {
        urls: [...new Set(urls)],
        returned: page.urls.length,
        hasMore: page.hasMore,
        source,
      };
    }
    if (this.market === 'resell') {
      const baseline = await this.physicalDetail(this.origin);
      if (
        [
          'Clothing',
          'Shoes',
          'Bags',
          'Home',
          'Collectibles',
          'Books',
          'Tech',
          'Kids',
          'Garden',
        ].includes(baseline.item.category ?? '')
      )
        params.set('category', baseline.item.category!);
      params.set('limit', '12');
      params.set('offset', String(offset));
      const source = marketAPI + '/market/search?' + params;
      const page = z
        .object({
          object: z.literal('search_result'),
          data: z.array(z.unknown()).max(12),
          has_more: z.boolean(),
        })
        .parse(await this.get(source));
      const urls: string[] = [];
      for (const raw of page.data) {
        const row = listing.extend(placement.shape).safeParse(raw).data;
        if (!row) continue;
        if (!resellCanonical(row)) continue;
        if (row.sponsored || row.is_sponsored) this.placements.add(row.url);
        if (!this.hints.has(row.url)) {
          this.hints.set(row.url, row.id);
          urls.push(row.url);
        } else if (this.hints.get(row.url) !== row.id)
          throw Error('Conflicting discovery identities for one link.');
        else urls.push(row.url);
      }
      return {
        urls: [...new Set(urls)],
        returned: page.data.length,
        hasMore: page.has_more,
        source,
      };
    }
    params.set('app', 'firefox');
    params.set('type', 'extension');
    params.set('page', String(offset / 12 + 1));
    params.set('page_size', '12');
    params.set('lang', 'en-US');
    const source = amo + '/api/v5/addons/search/?' + params;
    const page = z
      .object({
        results: z.array(z.unknown()).max(12),
        next: z.string().nullable(),
      })
      .parse(await this.get(source));
    const urls: string[] = [];
    for (const raw of page.results) {
      const x = z
        .object({
          ...placement.shape,
          id: z.number().int().positive(),
          slug: z.string().regex(/^[a-z0-9_-]{1,80}$/),
          url: z.url(),
        })
        .safeParse(raw).data;
      if (!x) continue;
      const expected = amo + '/en-US/firefox/addon/' + x.slug + '/';
      if (x.url !== expected) continue;
      if (x.sponsored || x.is_sponsored) this.placements.add(expected);
      const existing = this.hints.get(expected);
      if (existing != null && existing !== x.id)
        throw Error('Conflicting catalog identities for one link.');
      this.hints.set(expected, x.id);
      urls.push(expected);
    }
    return {
      urls: [...new Set(urls)],
      returned: page.results.length,
      hasMore: page.next !== null,
      source,
    };
  }
  private async physicalDetail(url: URL) {
    const shop = url.hostname.split('.')[0]!,
      s = store.parse(await this.get(marketAPI + '/market/stores/' + shop)),
      slug = url.pathname.slice(1);
    if (s.slug !== shop) throw Error('The returned shop identity changed.');
    const matches = s.listings.filter(
      (x) => x.slug === slug && x.store === shop && x.url === url.href && resellCanonical(x),
    );
    if (matches.length !== 1) throw Error('No unique current listing in the named shop.');
    const id = matches[0]!.id;
    if (this.hints.has(url.href) && this.hints.get(url.href) !== id)
      throw Error('Listing identity differs from discovery.');
    const item = detail.parse(await this.get(marketAPI + '/market/listings/' + id));
    if (item.id !== id || item.url !== url.href || item.slug !== slug || item.store !== shop)
      throw Error('Listing detail and shop identity disagree.');
    return { shop: s, item };
  }
  private async seller(shop: string) {
    const old = this.sellers.get(shop);
    if (old) return old;
    const read = (async () => {
      const d = blankSourceSubject('seller', 'resell'),
        url = new URL('https://' + shop + '.resell.store/');
      try {
        await readResell(
          d,
          shop,
          url,
          this.signal,
          this.reserve
            ? (subject) => this.reserve!('resell', 'seller', subject, 'newest page 1')
            : undefined,
          this.get,
        );
        return evidence(d, shop);
      } catch (e) {
        this.signal.throwIfAborted();
        return {
          subject: shop,
          source: marketAPI + '/stores/' + shop + '/reviews',
          captured: new Date().toISOString(),
          metric: null,
          sample: 0,
          groups: 0,
          summary: [],
          limits: [
            e instanceof Error && e.message.startsWith('Source HTTP')
              ? e.message
              : 'Seller feedback unavailable for this shop.',
          ],
        };
      }
    })();
    this.sellers.set(shop, read);
    return read;
  }
  private async physical(url: URL): Promise<Offer> {
    const { shop, item } = await this.physicalDetail(url);
    const attrs: Record<string, string> = {};
    const keys: Record<string, string> = {
      Brand: 'brand',
      Model: 'model',
      Nib: 'nib',
      Colour: 'color',
      Color: 'color',
      Condition: 'condition',
      'Comes with': 'accessories',
      Edition: 'edition',
      Format: 'format',
      'Publication year': 'year',
      Author: 'author',
      Publisher: 'publisher',
      Flaws: 'flaws',
      Category: 'category',
      'Ships from': 'ships from',
      ISBN: 'isbn',
    };
    for (const f of item.details ?? []) {
      const k = keys[f.label];
      if (!k) continue;
      const v = k === 'isbn' ? isbn(f.value) : clean(f.value);
      if (v) attrs[k] = v;
    }
    if (attrs.edition && /\bprinting\b/i.test(attrs.edition)) attrs.printing = attrs.edition;
    const pen = /\bfountain pens?\b/i.test([attrs.category, item.title].join(' ')),
      family = pen
        ? 'fountain pen'
        : item.category === 'Books'
          ? 'book'
          : clean(item.category) || 'physical item';
    attrs.purpose = family;
    if (item.sponsored || item.is_sponsored || this.placements.has(url.href))
      attrs.promoted = 'true';
    const itemAmount = decimal(item.price),
      shipping = decimal(item.shipping);
    const terms = (item.details ?? [])
      .filter((x) => /^(?:price basis|price type|pricing terms|price conditions)$/i.test(x.label))
      .map((x) => clean(x.value) || 'Unconfirmed pricing terms')
      .join(' · ');
    const displayed = itemAmount ? '$' + itemAmount : 'Item price not supplied';
    const cost: CompareCost = {
      text: [displayed, terms].filter(Boolean).join(' · ').slice(0, 180),
      amount: itemAmount,
      currency: 'USD',
      currencySource: usdContract,
      shipping,
      shippingScope:
        shipping !== null && /^0(?:\.0+)?$/.test(shipping)
          ? 'Pickup only'
          : shipping
            ? 'Listed shipping; destination eligibility unknown'
            : null,
      fees: null,
      tax: null,
      basis: priceBasis(terms, itemAmount),
    };
    return {
      market: 'resell',
      id: item.id,
      title: clean(item.title) || 'Listing title unavailable',
      url: item.url,
      family,
      catalog: attrs.isbn
        ? 'isbn:' + attrs.isbn
        : attrs.brand && attrs.model
          ? attrs.brand + ' ' + attrs.model
          : null,
      seller: shop.slug,
      sellerName: clean(shop.name) || null,
      attributes: attrs,
      quantity: /\b(bundle|set of|pack of|lot of)\b/i.test(item.title)
        ? null
        : pen || family === 'book'
          ? 1
          : null,
      availability:
        item.sold === true || shop.paused ? 'sold' : item.sold === false ? 'available' : 'unknown',
      captured: new Date().toISOString(),
      cost,
      productEvidence: null,
      sellerEvidence: await this.seller(shop.slug),
    };
  }
  private async software(url: URL): Promise<Offer> {
    const key = shoppingRoute(url)!.key,
      dataUrl = amo + '/api/v5/addons/addon/' + key + '/?lang=en-US',
      meta = catalog.parse(await this.get(dataUrl)),
      canonical = amo + '/en-US/firefox/addon/' + key + '/';
    if (
      meta.slug !== key ||
      meta.url !== canonical ||
      meta.type !== 'extension' ||
      (this.hints.has(canonical) && this.hints.get(canonical) !== meta.id)
    )
      throw Error('Catalog detail does not match the selected result.');
    const subject = 'amo_' + meta.id,
      d = blankSourceSubject('product', 'mozilla');
    let review: ComparisonAssessment | null;
    try {
      await readMozilla(
        d,
        key,
        this.signal,
        url,
        this.reserve
          ? (s) => this.reserve!('mozilla', 'product', s, url.search || 'unfiltered page 1')
          : undefined,
        this.get,
      );
      review = evidence(d, subject);
    } catch (err) {
      this.signal.throwIfAborted();
      review = {
        subject,
        source: d.source ?? canonical,
        captured: new Date().toISOString(),
        metric: null,
        sample: 0,
        groups: 0,
        summary: [],
        limits: [
          err instanceof Error && err.message.startsWith('Source HTTP')
            ? err.message
            : 'Matching catalog review data unavailable.',
        ],
      };
    }
    const attrs: Record<string, string> = { version: meta.current_version.version },
      tags = meta.tags?.map((x) => x.toLowerCase()) ?? [],
      description = localText(meta.summary);
    const developers = mozillaDevelopers(meta.authors);
    if (developers) attrs.developer = developers;
    const firefox = meta.current_version.compatibility?.firefox;
    if (firefox) {
      attrs.platform = 'Firefox';
      attrs.compatibility =
        'Firefox ' +
        (firefox.min ?? 'unspecified minimum') +
        ' – ' +
        (firefox.max ?? 'unspecified maximum');
    }
    const summary =
      typeof meta.summary === 'string'
        ? meta.summary
        : (meta.summary?.['en-US'] ?? meta.summary?.en ?? '');
    const ad = publisherClaim(summary, adClaim, tags.includes('ad blocker'));
    const tracking = publisherClaim(summary, trackerClaim, tags.includes('anti tracker'));
    if (ad) attrs['ad blocking'] = ad;
    if (tracking) attrs['tracking protection'] = tracking;
    if (ad === 'yes') {
      attrs.purpose = 'ad blocking';
    } else if (tracking === 'yes') attrs.purpose = 'tracking protection';
    if (description) attrs.description = description;
    if (
      meta.sponsored ||
      meta.is_sponsored ||
      this.placements.has(canonical) ||
      meta.promoted?.some((program) =>
        /^(?:paid|sponsored|paid placement)$/i.test(program.category),
      )
    )
      attrs.promoted = 'true';
    if (meta.promoted?.length)
      attrs['catalog program'] =
        'Mozilla: ' +
        meta.promoted
          .map((p) => clean(p.category))
          .filter(Boolean)
          .join(', ')
          .slice(0, 160);
    return {
      market: 'mozilla',
      id: String(meta.id),
      title: localText(meta.name) || key,
      url: canonical,
      family: 'Firefox extension',
      catalog: subject,
      seller: null,
      sellerName: null,
      attributes: attrs,
      quantity: 1,
      availability: meta.status !== 'public' || meta.is_disabled ? 'sold' : 'available',
      captured: new Date().toISOString(),
      cost: { ...unavailableCost },
      productEvidence: review,
      sellerEvidence: null,
    };
  }
  private async practice(url: URL) {
    const key = url.pathname.split('/')[2] || 'original',
      source = url.origin + '/comparison-lab/source/offers/' + encodeURIComponent(key),
      data = Offer.parse(await this.get(source));
    if (
      data.id !== key ||
      data.market !== 'practice' ||
      data.url !== url.origin + '/comparison-lab/' + key
    )
      throw Error('Practice detail does not match the selected identity.');
    for (const kind of ['product', 'seller'] as const) {
      const subject = kind === 'seller' ? data.seller : data.catalog;
      if (!subject) continue;
      const identity = kind + '/' + subject;
      let reading = this.practiceEvidence.get(identity);
      if (!reading) {
        reading = (async () => {
          if (
            this.reserve &&
            !(await this.reserve('practice', kind, subject, 'Practice first page'))
          )
            return null;
          const raw = await this.get(
            url.origin + '/comparison-lab/source/evidence/' + kind + '/' + key,
          );
          const assessment = ComparisonAssessment.parse(raw);
          if (new URL(assessment.source).origin !== url.origin || assessment.subject !== subject)
            throw Error('Practice assessment identity mismatch.');
          return assessment;
        })();
        this.practiceEvidence.set(identity, reading);
      }
      const assessment = await reading;
      if (kind === 'seller') data.sellerEvidence = assessment;
      else data.productEvidence = assessment;
    }
    return data;
  }
}
