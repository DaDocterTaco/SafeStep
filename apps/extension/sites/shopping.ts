import {
  emptyContext,
  publicExcerpt,
  resellStorefrontRoute,
  textGroup,
  type ShoppingData,
  type ShoppingKind,
  type ReviewBinding,
  type ShopMetric,
  type ShopRecord,
} from '@safestep/contracts';
import { z } from 'zod';

const shopSlug = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const uuid = z.uuid();
const api = 'https://api.resell.store/v1';
const amo = 'https://addons.mozilla.org';
export function shoppingRoute(u: URL) {
  if (u.username || u.password) return null;
  if (
    u.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
    /^\/shopping-lab\/(listing|seller|product|amazon-us)$/.test(u.pathname)
  )
    return { market: 'practice' as const, key: u.pathname };
  if (u.protocol !== 'https:' || u.port) return null;
  const mo =
    /^\/(?:[a-z]{2,3}(?:-[A-Za-z]{2,4})?\/)?firefox\/addon\/([a-z0-9_-]{1,80})(?:\/reviews)?\/?$/.exec(
      u.pathname,
    );
  if (u.origin === amo && mo) return { market: 'mozilla' as const, key: mo[1]! };
  const account = resellStorefrontRoute(u);
  if (account) return { market: 'resell' as const, key: account };
  const a = /^\/v1\/(?:market\/stores\/([a-z0-9-]+)|stores\/([a-z0-9-]+)\/reviews)$/.exec(
    u.pathname,
  );
  if (u.origin === 'https://api.resell.store' && a && shopSlug.test((a[1] ?? a[2])!))
    return { market: 'resell' as const, key: (a[1] ?? a[2])! };
  return null;
}
type SourceSubject = Omit<ShoppingData, 'binding'>;
export function blankShop(
  b: ReviewBinding,
  kind: ShoppingKind,
  m: ShoppingData['context']['market'],
): ShoppingData {
  return { ...blankSourceSubject(kind, m), binding: b };
}
export function blankSourceSubject(
  kind: ShoppingKind,
  m: ShoppingData['context']['market'],
): SourceSubject {
  return {
    kind,
    context: emptyContext(m),
    captured: new Date().toISOString(),
    status: 'limited_evidence',
    scope: 'Current public view',
    source: null,
    more: null,
    metrics: [],
    records: [],
    limited: false,
    note: '',
    filter: 'Current view',
    automatedFilter: 'unknown',
    badge: null,
    target: null,
  };
}
export function metric(
  label: string,
  value: number,
  unit: ShopMetric['unit'] = 'count',
  period = 'Source does not specify a time window',
  scale: number | null = null,
  approximate = false,
): ShopMetric {
  return { label, value, unit, period, scale, approximate };
}
export function shopRecord(d: SourceSubject, index: number): ShopRecord {
  return {
    id: 'r' + (index + 1),
    platformId: null,
    channel: d.kind === 'seller' ? 'seller_received_feedback' : 'catalog_product_review',
    subject: (d.kind === 'seller' ? d.context.seller : (d.context.catalog ?? d.context.listing))!,
    listing: null,
    soldBy: null,
    version: null,
    text: '',
    rating: null,
    published: null,
    precision: 'unknown',
    automated: false,
    verified: false,
    condition: null,
  };
}
export function failShop<T extends SourceSubject>(
  d: T,
  status: ShoppingData['status'],
  note: string,
) {
  d.status = status;
  d.note = note;
  d.metrics = [];
  d.records = [];
  d.target = null;
  return d;
}
export function conclude<T extends SourceSubject>(d: T, explicitZero = false) {
  const seen = new Set<string>();
  d.records = d.records
    .filter((r) => {
      if (!r.platformId) return true;
      if (seen.has(r.platformId)) return false;
      seen.add(r.platformId);
      return true;
    })
    .map((r, i) => ({ ...r, id: 'r' + (i + 1) }));
  const groups = new Set(d.records.filter((r) => !r.automated && r.text).map(textGroup));
  d.status = explicitZero
    ? 'explicit_zero'
    : !d.records.length
      ? 'no_reviews_in_view'
      : groups.size < 2
        ? 'limited_evidence'
        : 'reviews_available';
  return d;
}
export async function readPublicJSON(
  url: string,
  signal: AbortSignal,
  preciseListingMoney = false,
) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    throw Error(
      'Source HTTP ' +
        response.status +
        (response.status === 429 && retry && /^\d{1,7}$/.test(retry)
          ? '; retry after ' + retry + ' seconds.'
          : '.'),
    );
  }
  if (!response.headers.get('content-type')?.includes('json') || !response.body)
    throw Error('source unavailable');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = '';
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > 262144) {
        await reader.cancel();
        throw Error('source limit');
      }
      text += decoder.decode(r.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const json = text + decoder.decode();
  // Resell publishes amounts as JSON numbers in major USD units. Keep the actual
  // number token for comparisons even when it exceeds IEEE-754 decimal precision.
  if (preciseListingMoney)
    return JSON.parse(json, (key, value, context?: { source?: string }) =>
      (key === 'price' || key === 'shipping') && typeof value === 'number'
        ? (context?.source ?? null)
        : value,
    ) as unknown;
  return JSON.parse(json) as unknown;
}
const listing = z.object({
  id: uuid,
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(160),
  store: z.string().regex(shopSlug),
  url: z.url(),
  title: z.string().max(240),
});
const storeSchema = z.object({
  object: z.literal('store'),
  slug: z.string().regex(shopSlug),
  name: z.string().max(160),
  since: z.string().max(100).nullable().optional(),
  sold: z.number().int().nonnegative().optional(),
  listings: z.array(listing).max(150),
});
const feedback = z.object({
  object: z.literal('list'),
  rating: z.object({
    average: z.number().min(0).max(5).nullable(),
    count: z.number().int().nonnegative(),
  }),
  data: z
    .array(
      z.object({
        id: uuid,
        rating: z.number().int().min(1).max(5),
        body: z.string().nullable(),
        created_at: z.iso.datetime({ offset: true }),
        shop: z.object({ slug: z.string(), name: z.string() }),
        listing: z
          .object({ id: uuid, url: z.string().nullable().optional() })
          .nullable()
          .optional(),
      }),
    )
    .max(20),
  has_more: z.boolean(),
});
export type ReserveShopSet = (subject: string) => Promise<boolean>;
export function limitShop<T extends SourceSubject>(d: T) {
  d.limited = true;
  return failShop(
    d,
    'session_limit',
    'This subject has reached the three-set session limit (up to 60 records).',
  );
}
export async function readResell<T extends SourceSubject>(
  d: T,
  key: string,
  url: URL,
  signal: AbortSignal,
  reserve?: ReserveShopSet,
  json: typeof readPublicJSON = readPublicJSON,
) {
  const raw = storeSchema.parse(await json(api + '/market/stores/' + key, signal));
  if (raw.slug !== key)
    return failShop(d, 'identity_uncertain', 'The store response named another shop.');
  const c = d.context;
  c.seller = raw.slug;
  c.store = raw.slug;
  c.display = raw.name;
  c.since = raw.since ?? null;
  const isListing = url.hostname !== 'api.resell.store' && url.pathname !== '/';
  const found = isListing
    ? raw.listings.filter(
        (x) =>
          x.store === key &&
          x.slug === url.pathname.replace(/^\/|\/$/g, '') &&
          x.url === url.origin + '/' + x.slug,
      )
    : [];
  if (isListing && found.length !== 1)
    return failShop(
      d,
      'identity_uncertain',
      'The current listing could not be matched to a unique listing in this shop.',
    );
  if (found[0]) {
    const item = z
      .object({
        id: uuid,
        store: z.string(),
        slug: z.string(),
        title: z.string().max(240),
        url: z.string(),
        details: z
          .array(z.object({ label: z.string(), value: z.string() }))
          .max(40)
          .optional(),
      })
      .parse(await json(api + '/market/listings/' + found[0].id, signal));
    if (
      item.id !== found[0].id ||
      item.store !== key ||
      item.slug !== found[0].slug ||
      item.url !== found[0].url
    )
      return failShop(d, 'identity_uncertain', 'The listing and shop details disagree.');
    const detail = (name: string) => {
      const values=new Set(item.details?.filter(f=>f.label.toLowerCase()===name.toLowerCase())
        .map(f=>f.value.trim()).filter(v=>v.length>0&&v.length<=160));
      return values.size===1?[...values][0]!:null;
    };
    c.listing = item.id;
    c.title = item.title.slice(0, 160);
    c.condition = detail('Condition');
    c.variant = detail('Edition') ?? detail('Nib') ?? detail('Size');
    c.format = detail('Format');
    c.year = detail('Publication year')?.match(/^\d{4}$/)?.[0] ?? null;
    c.isbn =
      detail('ISBN')
        ?.replaceAll('-', '')
        .match(/^(?:\d{13}|\d{9}[\dX])$/)?.[0] ?? null;
  }
  d.more = 'https://api.resell.store/v1/market/stores/' + key;
  if (d.kind === 'product') {
    d.source = found[0]?.url ?? d.more;
    d.scope = 'Resell.store listing information';
    d.status = 'limited_evidence';
    d.note =
      'This marketplace supplies shop feedback. Independent product reviews and an exact catalog mapping are unavailable here.';
    return d;
  }
  if (reserve && !(await reserve(key))) return limitShop(d);
  const rows = feedback.parse(await json(api + '/stores/' + key + '/reviews?limit=20', signal));
  if (rows.data.some((r) => r.shop.slug !== key) || rows.data.length > rows.rating.count)
    return failShop(d, 'identity_uncertain', 'Feedback did not match the selected shop.');
  d.source = 'https://api.resell.store/v1/stores/' + key + '/reviews';
  d.scope = 'Public feedback received by this shop from buyers';
  d.filter = 'Newest first · first page, up to 20';
  d.limited = rows.has_more;
  d.metrics.push(metric('Published shop ratings', rows.rating.count));
  if (rows.rating.average !== null && rows.rating.count > 0)
    d.metrics.push(
      metric('Average shop rating', rows.rating.average, 'stars', 'Published shop ratings', 5),
    );
  if (raw.sold !== undefined) d.metrics.push(metric('Items sold (store profile)', raw.sold));
  d.records = rows.data.map((r, i) => ({
    ...shopRecord(d, i),
    platformId: r.id,
    listing: r.listing?.id ?? null,
    text: publicExcerpt(r.body),
    published: r.created_at,
    precision: 'instant',
    rating: r.rating,
    verified: true,
  }));
  d.note =
    'Resell.store identifies the shop by its public slug and publishes feedback from its buyers. A separate owner account ID and automated-feedback classification are unavailable.';
  return conclude(d, rows.rating.count === 0);
}
const positive = z.number().int().positive(),
  count = z.number().int().nonnegative();
const addon = z.object({
  id: positive,
  slug: z.string(),
  name: z.union([z.string(), z.record(z.string(), z.string())]),
  ratings: z.object({ average: z.number().min(0).max(5).nullable(), count, text_count: count }),
  current_version: z.object({ version: z.string().max(100) }),
});
const ratingPage = z.object({
  count,
  next: z.string().nullable(),
  results: z
    .array(
      z.object({
        id: positive,
        addon: z.object({ id: positive, slug: z.string() }),
        score: z.number().int().min(1).max(5),
        body: z.string().nullable(),
        created: z.iso.datetime({ offset: true }),
        is_deleted: z.boolean(),
        is_developer_reply: z.boolean(),
        is_latest: z.boolean(),
        version: z.object({ version: z.string().max(100) }).nullable(),
      }),
    )
    .max(20),
});
export async function readMozilla<T extends SourceSubject>(
  d: T,
  key: string,
  signal: AbortSignal,
  url: URL,
  reserve?: ReserveShopSet,
  json: typeof readPublicJSON = readPublicJSON,
) {
  d.source = amo + '/en-US/firefox/addon/' + key + '/';
  d.more = d.source + 'reviews/';
  if (d.kind === 'seller')
    return failShop(
      d,
      'unsupported',
      'Mozilla lists software publishers. A seller-service feedback source is unavailable on this page.',
    );
  const meta = addon.parse(
    await json(amo + '/api/v5/addons/addon/' + key + '/?lang=en-US', signal),
  );
  if (meta.slug !== key)
    return failShop(d, 'identity_uncertain', 'Mozilla returned a different product.');
  const c = d.context;
  c.title = (typeof meta.name === 'string' ? meta.name : (meta.name['en-US'] ?? key)).slice(0, 160);
  c.catalog = 'amo_' + meta.id;
  c.format = 'Firefox add-on';
  c.variant = meta.current_version.version;
  d.scope = 'Mozilla catalog reviews across published versions';
  d.filter = 'First public page · written reviews only · up to 20';
  d.source = d.more;
  const params = new URLSearchParams({
    addon: String(meta.id),
    filter: 'without_empty_body',
    page_size: '20',
  });
  const pageNumber = url.searchParams.get('page') ?? '1',
    score = url.searchParams.get('score');
  if (!/^[1-3]$/.test(pageNumber) || (score !== null && !/^[1-5]$/.test(score)))
    return failShop(
      d,
      'unsupported',
      'Use one of the first three public review pages and a supported star filter.',
    );
  params.set('page', pageNumber);
  if (score) params.set('score', score);
  const cited = new URL(d.more!);
  if (score) cited.searchParams.set('score', score);
  if (pageNumber !== '1') cited.searchParams.set('page', pageNumber);
  d.source = cited.href;
  d.more = cited.href;
  if (reserve && !(await reserve(c.catalog))) return limitShop(d);
  d.filter =
    'Public API page ' +
    pageNumber +
    ' · written reviews only · ' +
    (score ? score + ' stars' : 'all stars') +
    ' · up to 20';
  const page = ratingPage.parse(await json(amo + '/api/v5/ratings/rating/?' + params, signal));
  if (
    page.results.some(
      (r) =>
        r.addon.id !== meta.id ||
        r.addon.slug !== key ||
        r.is_deleted ||
        r.is_developer_reply ||
        !r.is_latest ||
        (score && r.score !== Number(score)),
    )
  )
    return failShop(
      d,
      'identity_uncertain',
      'The returned review channel or product did not match.',
    );
  if (meta.ratings.average !== null && meta.ratings.count)
    d.metrics.push(
      metric('Average product rating', meta.ratings.average, 'stars', 'All catalog ratings', 5),
    );
  d.metrics.push(
    metric('Total ratings', meta.ratings.count),
    metric('Written reviews (catalog)', meta.ratings.text_count),
    metric('Written results (filtered view)', page.count),
  );
  d.records = page.results.map((r, i) => ({
    ...shopRecord(d, i),
    platformId: String(r.id),
    text: publicExcerpt(r.body),
    published: r.created,
    precision: 'instant',
    rating: r.score,
    version: r.version?.version ?? null,
  }));
  // This distinct unfiltered endpoint reports the catalog histogram, including star-only ratings.
  const binsSchema = z.object({
    grouped_ratings: z.strictObject({ '1': count, '2': count, '3': count, '4': count, '5': count }),
  });
  const bins = await json(
    amo + '/api/v5/ratings/rating/?addon=' + meta.id + '&show_grouped_ratings=1&page_size=1',
    signal,
  )
    .then((body) => binsSchema.safeParse(body).data?.grouped_ratings)
    .catch(() => undefined);
  signal.throwIfAborted();
  if (bins)
    for (const [star, value] of Object.entries(bins))
      d.metrics.push(
        metric(
          star + '-star ratings',
          value,
          'count',
          'Mozilla catalog distribution · all ratings, all versions',
        ),
      );
  d.limited = !!page.next;
  d.note =
    'Reviews span versions. The current release and each review’s version are shown separately. This source supplies no physical-item condition or seller-service evidence.';
  return conclude(d, meta.ratings.count === 0 && page.count === 0);
}
