import { z } from 'zod';
import { FeatureId, Errors } from './model.js';
import { SellerAccount } from './shopping.js';
import {mozillaReviewScope} from './source-scope.js';

export const reportKinds = [
  'website_identity',
  'website_risk',
  'seller_reputation',
  'product_feedback',
  'offer',
  'intent',
] as const;
import { publicHost } from './public-host.js';
export { publicHost } from './public-host.js';
const publicId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const site = { domain: publicHost };
const item = { market: publicHost, publicId };
export const Subject = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('website_identity'), ...site }),
  z.strictObject({ kind: z.literal('website_risk'), ...site }),
  z
    .strictObject({
      kind: z.literal('seller_reputation'),
      market: publicHost,
      publicId: SellerAccount,
    })
    .refine(
      (s) =>
        !s.publicId.includes('.') ||
        ['ebay.com', 'www.ebay.com', 'resell.store'].includes(s.market),
    ),
  z.strictObject({ kind: z.literal('product_feedback'), ...item }),
  z.strictObject({ kind: z.literal('offer'), ...item }),
  z.strictObject({ kind: z.literal('intent'), workflow: publicId }),
]);
export type Subject = z.infer<typeof Subject>;
const avail = z.enum(['available', 'partial', 'unavailable', 'unsupported', 'unimplemented']);
const sourceURL = z
  .url({ protocol: /^https$/ })
  .max(512)
  .refine((s) => {
    try {
      const u = new URL(s);
      return !u.username && !u.password && !u.hash && (!u.search||mozillaReviewScope(u));
    } catch {
      return false;
    }
  });
export const EvidenceItem = z.strictObject({
  id: z.string().max(100),
  subject: Subject,
  source: z.string().min(1).max(100),
  sourceUrl: sourceURL.nullable(),
  retrievedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  freshness: z.string().max(160),
  availability: avail,
  finding: z.string().max(320),
  coverage: z.string().min(1).max(320),
});
const requiredReports: Partial<Record<z.infer<typeof FeatureId>, Subject['kind']>> = {
  url_identity: 'website_identity',
  site_trust: 'website_risk',
  seller_assessment: 'seller_reputation',
  product_assessment: 'product_feedback',
  shopping_alternatives: 'offer',
};
export const FeatureResult = z
  .strictObject({
    featureId: FeatureId,
    subject: Subject,
    availability: avail,
    finding: z.string().max(320),
    explanation: z.string().max(480),
    evidence: z.array(EvidenceItem).max(16),
    limitations: z.array(z.string().max(240)).max(8),
    nextStep: z.string().max(240),
  })
  .refine(
    (r) => r.evidence.every((e) => JSON.stringify(e.subject) === JSON.stringify(r.subject)),
    'Evidence must describe the same subject.',
  )
  .refine(
    (r) => !requiredReports[r.featureId] || requiredReports[r.featureId] === r.subject.kind,
    'Wrong report type for this feature.',
  );
export type FeatureResult = z.infer<typeof FeatureResult>;
export const Providers = [
  'intent',
  'url_threat',
  'website_reputation',
  'seller_feedback',
  'product_feedback',
  'shopping_comparison',
] as const;
export const providerSubject = {
  intent: 'intent',
  url_threat: 'website_risk',
  website_reputation: 'website_risk',
  seller_feedback: 'seller_reputation',
  product_feedback: 'product_feedback',
  shopping_comparison: 'offer',
} as const;
export const ProviderId = z.enum(Providers);
export type ProviderId = z.infer<typeof ProviderId>;
export const Lookup = z
  .strictObject({ provider: ProviderId, subject: Subject })
  .refine(
    (r) => providerSubject[r.provider] === r.subject.kind,
    'Provider does not cover this subject.',
  );
export type Lookup = z.infer<typeof Lookup>;
export const Readiness = z.strictObject({
  provider: ProviderId,
  credentialPresent: z.boolean(),
  status: z.enum(['not_configured', 'connector_unavailable', 'ready']),
});
export const Health = z.strictObject({
  service: z.literal('safestep-local'),
  version: z.literal(1),
  providers: z.array(Readiness).length(6),
});
export type Health = z.infer<typeof Health>;
export const ProviderReply = z.strictObject({
  provider: ProviderId,
  code: Errors.nullable(),
  result: FeatureResult,
});
