import { z } from 'zod';
import { publicHost } from './evidence.js';

export const merchantProvider = 'Washington State Attorney General’s Office';
export const merchantDataset =
  'https://data.wa.gov/Consumer-Protection/Complaint-By-Practice/fvrz-yz45/data';
export const merchantEndpoint = 'https://data.wa.gov/resource/fvrz-yz45.json';
const publicId = z.string().regex(/^\d{1,15}$/);
export const MerchantRequest = z.strictObject({ domain: publicHost });
export type MerchantRequest = z.infer<typeof MerchantRequest>;
export const MerchantPractice = z.enum([
  'Failure To Adjust/Refund',
  'Failure To Deliver/Perform',
  'Non-Fulfillment',
]);
export function merchantRecordUrl(business: string, complaint: string): string {
  const url = new URL(merchantEndpoint);
  url.searchParams.set(
    '$select',
    'businessname,businessid,complaintid,openeddate,practicename,status',
  );
  url.searchParams.set(
    '$where',
    `businessid='${publicId.parse(business)}' AND complaintid='${publicId.parse(complaint)}'`,
  );
  url.searchParams.set('$limit', '12');
  return url.href;
}
const MerchantRecord = z.strictObject({
  id: publicId,
  date: z.iso.date(),
  practices: z.array(MerchantPractice).min(1).max(3),
  caseStatus: z.enum(['New', 'Open', 'Closed', 'Other', 'Conflicting']),
  url: z.url().max(600),
});
export const MerchantReply = z
  .strictObject({
    domain: publicHost,
    status: z.enum(['reports', 'limited', 'no_match', 'unavailable', 'rate_limited']),
    severity: z.enum(['caution', 'information']),
    provider: z.literal(merchantProvider),
    checkedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    summary: z.string().min(1).max(360),
    limitations: z.array(z.string().min(1).max(360)).max(6),
    source: z.literal(merchantDataset),
    businessId: publicId.nullable(),
    windowStart: z.iso.date(),
    rowsInspected: z.number().int().nonnegative().max(12),
    distinctComplaints: z.number().int().nonnegative().max(12),
    records: z.array(MerchantRecord).max(12),
  })
  .superRefine((r, ctx) => {
    const recent = new Set(
      r.records
        .filter(
          (x) =>
            Date.parse(r.checkedAt) - Date.parse(x.date) < 90 * 86400000 &&
            x.caseStatus !== 'Conflicting',
        )
        .map((x) => x.date),
    );
    if (
      r.records.length !== new Set(r.records.map((x) => x.id)).size ||
      r.distinctComplaints !== r.records.length ||
      r.rowsInspected < r.distinctComplaints ||
      (r.status === 'reports') !== (r.severity === 'caution') ||
      (r.status === 'reports' &&
        (recent.size < 2 || r.records.some((x) => x.caseStatus === 'Conflicting'))) ||
      (['no_match', 'unavailable', 'rate_limited'].includes(r.status) && r.records.length) ||
      Date.parse(r.expiresAt) < Date.parse(r.checkedAt) ||
      Date.parse(r.expiresAt) - Date.parse(r.checkedAt) > 300000 ||
      r.windowStart > r.checkedAt.slice(0, 10) ||
      r.records.some(
        (x) =>
          !r.businessId ||
          x.url !== merchantRecordUrl(r.businessId, x.id) ||
          x.date < r.windowStart ||
          x.date > r.checkedAt.slice(0, 10) ||
          x.practices.length !== new Set(x.practices).size,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Merchant evidence is inconsistent with its source, time or coverage.',
      });
  });
export type MerchantReply = z.infer<typeof MerchantReply>;
