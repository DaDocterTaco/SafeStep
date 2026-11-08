import { z } from 'zod';
import { bindingSchema } from './review.js';
import { mozillaReviewScope } from './source-scope.js';

export const SellerAccount = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
  .max(64);
const key = z
  .string()
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
  .max(100);
const short = z.string().min(1).max(160);
export const ShoppingKind = z.enum(['seller', 'product']);
export type ShoppingKind = z.infer<typeof ShoppingKind>;
export const market = z.enum(['resell', 'mozilla', 'practice', 'unsupported']);
export const ShoppingContext = z.strictObject({
  practiceOffer: z.strictObject({
    region:z.literal('US'),marketplaceHost:z.literal('www.amazon.com'),asin:z.string().regex(/^[A-Z0-9]{10}$/),offer:key,shipsFrom:short.nullable(),brand:short.nullable(),
  }).optional(),
  market,
  seller: SellerAccount.nullable(),
  display: short.nullable(),
  store: short.nullable(),
  listing: key.nullable(),
  catalog: key.nullable(),
  title: short.nullable(),
  isbn: z
    .string()
    .regex(/^(?:[0-9]{13}|[0-9]{9}[0-9X])$/)
    .nullable(),
  format: short.nullable(),
  year: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable(),
  variant: short.nullable(),
  condition: short.nullable(),
  since: short.nullable(),
});
export type ShoppingContext = z.infer<typeof ShoppingContext>;
export const emptyContext = (source: ShoppingContext['market']): ShoppingContext => ({
  market: source,
  seller: null,
  display: null,
  store: null,
  listing: null,
  catalog: null,
  title: null,
  isbn: null,
  format: null,
  year: null,
  variant: null,
  condition: null,
  since: null,
});
export const metricSchema = z
  .strictObject({
    label: short,
    value: z.number().nonnegative().finite(),
    unit: z.enum(['count', 'stars', 'percent']),
    scale: z.number().positive().max(100).nullable(),
    approximate: z.boolean(),
    period: short,
  })
  .refine((m) =>
    m.unit === 'count'
      ? Number.isSafeInteger(m.value) && m.scale === null
      : m.scale !== null && m.value <= m.scale && (m.unit !== 'percent' || m.scale === 100),
  );
export type ShopMetric = z.infer<typeof metricSchema>;
export const recordSchema = z.strictObject({
  id: key,
  platformId: key.nullable(),
  channel: z.enum(['seller_received_feedback', 'catalog_product_review', 'listing_product_review']),
  subject: key,
  listing: key.nullable(),
  soldBy: SellerAccount.nullable(),
  version: short.nullable(),
  text: z.string().max(400),
  rating: z.number().int().min(1).max(5).nullable(),
  published: z.string().min(1).max(64).nullable(),
  precision: z.enum(['date', 'instant', 'relative', 'unknown']),
  automated: z.boolean(),
  verified: z.boolean(),
  condition: short.nullable(),
});
export type ShopRecord = z.infer<typeof recordSchema>;
export const ShopStatus = z.enum([
  'reviews_available',
  'limited_evidence',
  'no_reviews_in_view',
  'identity_uncertain',
  'source_unavailable',
  'unsupported',
  'loading',
  'explicit_zero',
  'session_limit',
]);
export type ShopStatus = z.infer<typeof ShopStatus>;
const sourceURL = z
  .string()
  .max(420)
  .refine((v) => {
    try {
      const u = new URL(v);
      if (u.username || u.password || u.hash || (u.search && !mozillaReviewScope(u))) return false;
      if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        return /^\/shopping-lab\/(listing|seller|product|amazon-us)$/.test(u.pathname);
      return (
        u.protocol === 'https:' &&
        !u.port &&
        ((u.hostname === 'addons.mozilla.org' &&
          /^\/[a-zA-Z-]+\/firefox\/addon\/[a-z0-9_-]+\/(?:reviews\/)?$/.test(u.pathname)) ||
          (u.hostname === 'api.resell.store' &&
            /^\/v1\/(?:market\/(?:stores\/[a-z0-9-]+|listings\/[a-f0-9-]{36})|stores\/[a-z0-9-]+\/reviews)$/.test(
              u.pathname,
            )) ||
          (!['api', 'files', 'docs', 'www'].includes(u.hostname.split('.')[0]!) &&
            /^[a-z0-9-]+\.resell\.store$/.test(u.hostname) &&
            /^\/(?:[a-z0-9-]+\/?)?$/.test(u.pathname)))
      );
    } catch {
      return false;
    }
  });
const fields = {
  binding: bindingSchema,
  context: ShoppingContext,
  inspectedUrl: sourceURL.optional(),
  captured: z.iso.datetime(),
  status: ShopStatus,
  scope: short,
  source: sourceURL.nullable(),
  more: sourceURL.nullable(),
  metrics: z.array(metricSchema).max(14),
  records: z.array(recordSchema).max(20),
  limited: z.boolean(),
  note: z.string().max(320),
  filter: z.string().max(120),
  automatedFilter: z.enum(['included', 'excluded', 'unknown']),
  badge: short.nullable(),
  target: z.uuid().nullable(),
};
export const SellerAssessment = z.strictObject({ ...fields, kind: z.literal('seller') });
export const ProductAssessment = z.strictObject({ ...fields, kind: z.literal('product') });
export const ShoppingData = z
  .discriminatedUnion('kind', [SellerAssessment, ProductAssessment])
  .superRefine((d, c) => {
    if (!URL.canParse(d.binding.origin)) return;
    const origin = new URL(d.binding.origin);
    if (d.inspectedUrl && (!URL.canParse(d.inspectedUrl) || new URL(d.inspectedUrl).origin !== origin.origin))
      c.addIssue({code:'custom',message:'Inspected page differs from the bound origin'});
    if(d.context.practiceOffer&&(d.context.market!=='practice'||d.context.catalog!==d.context.practiceOffer.asin || d.context.listing!==d.context.practiceOffer.offer))
      c.addIssue({code:'custom',message:'Synthetic marketplace offer does not match its selected listing or ASIN.'});
    if (
      (d.context.market === 'practice' &&
        !(
          origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        )) ||
      (d.context.market === 'mozilla' && origin.origin !== 'https://addons.mozilla.org') ||
      (d.context.market === 'resell' &&
        !(
          origin.protocol === 'https:' &&
          !origin.port &&
          (origin.hostname === 'api.resell.store' ||
            /^[a-z0-9-]+\.resell\.store$/.test(origin.hostname))
        ))
    )
      c.addIssue({ code: 'custom', message: 'The public source and current tab do not agree' });
    const subject =
      d.kind === 'seller' ? d.context.seller : (d.context.catalog ?? d.context.listing);
    if (
      d.records.some(
        (r) =>
          r.subject !== subject ||
          (d.kind === 'seller') !== (r.channel === 'seller_received_feedback') ||
          (d.kind === 'seller' && r.soldBy !== null && r.soldBy !== d.context.seller) ||
          (r.channel === 'listing_product_review' && r.listing !== null && r.listing !== d.context.listing),
      ) ||
      new Set(d.records.map((r) => r.id)).size !== d.records.length
    )
      c.addIssue({ code: 'custom', message: 'Review subject or channel changed' });
    if (
      ['identity_uncertain', 'unsupported', 'source_unavailable', 'loading'].includes(d.status) &&
      (d.records.length || d.metrics.length)
    )
      c.addIssue({ code: 'custom', message: 'Unverified identity or source' });
    for (const v of [d.source, d.more])
      if (v) {
        if (!URL.canParse(v)) continue;
        const u = new URL(v);
        const ok =
          d.context.market === 'practice'
            ? u.origin === d.binding.origin
            : d.context.market === 'mozilla'
              ? u.hostname === 'addons.mozilla.org'
              : d.context.market === 'resell'
                ? !!d.context.seller &&
                  (u.hostname === d.context.seller + '.resell.store' ||
                    (u.hostname === 'api.resell.store' &&
                      [
                        '/v1/market/stores/' + d.context.seller,
                        '/v1/stores/' + d.context.seller + '/reviews',
                      ].includes(u.pathname)))
                : false;
        if (!ok) c.addIssue({ code: 'custom', message: 'Source outside market' });
      }
  });
export type ShoppingData = z.infer<typeof ShoppingData>;
export const ShopOperation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('read') }),
  z.strictObject({ op: z.literal('verify') }),
  z.strictObject({ op: z.literal('reveal'), ref: z.uuid() }),
  z.strictObject({ op: z.literal('close') }),
]);
export const ShopPageRequest = z.strictObject({
  channel: z.literal('shop-page'),
  requestId: z.uuid(),
  binding: bindingSchema,
  kind: ShoppingKind,
  command: ShopOperation,
});
export type ShopPageRequest = z.infer<typeof ShopPageRequest>;
export const ShopPageReply = z.strictObject({
  channel: z.literal('shop-result'),
  requestId: z.uuid(),
  binding: bindingSchema,
  ok: z.boolean(),
  data: ShoppingData.nullable(),
});
export const ShopChange = z.strictObject({
  channel: z.literal('shop-change'),
  kind: ShoppingKind,
  binding: bindingSchema,
});
export const ShopReserve = z.strictObject({
  channel: z.literal('shop-reserve'),
  binding: bindingSchema,
  kind: ShoppingKind,
  subject: key,
});
export const historySummary = z.strictObject({
  at: z.iso.datetime(),
  scope: short,
  records: z.number().int().min(0).max(20),
});
export const ShopView = z.strictObject({
  data: ShoppingData,
  history: z.array(historySummary).max(3),
});
export type ShopView = z.infer<typeof ShopView>;
