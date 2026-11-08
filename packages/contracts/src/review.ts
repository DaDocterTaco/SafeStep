import { z } from 'zod';
import { AddressObservation, Placement, WorkflowId } from './guidance.js';

export const FileProfile = z.enum(['vlc_windows_x64', 'seven_zip_windows_x64_exe']);
export type FileProfile = z.infer<typeof FileProfile>;
export const Selection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('website'), expected: WorkflowId.optional() }),
  z.strictObject({ kind: z.literal('download'), profile: FileProfile }),
]);
export type Selection = z.infer<typeof Selection>;
export const Signal = z.enum([
  'host',
  'http',
  'user_info',
  'label_mismatch',
  'embedded_expected_domain',
  'similar_spelling',
  'international',
  'urgent_dialog',
  'sponsored',
  'self_claim',
  'limited',
  'publisher_vlc',
  'publisher_7zip',
  'wrong_destination',
  'other_option',
  'unknown_link',
  'missing',
  'duplicate',
]);
export type Signal = z.infer<typeof Signal>;
const evidenceId = z.string().regex(/^e(?:[1-9]|1[0-6])$/);
export const Observation = z.strictObject({
  id: evidenceId,
  code: Signal,
  detail: z.string().max(160),
});
export type Observation = z.infer<typeof Observation>;
export const signalText: Record<Signal, string> = {
  host: 'The address comes from the current tab.',
  http: 'This page uses an unencrypted HTTP connection.',
  user_info: 'The address contains sign-in-style text before its actual host.',
  label_mismatch: 'A displayed web address names a different host from its link.',
  embedded_expected_domain: 'The expected domain appears inside a different host.',
  similar_spelling: 'The spelling resembles the expected site.',
  international: 'This internationalized hostname is shown in ASCII.',
  urgent_dialog:
    'A visible dialog combines an urgent device warning with a request to download, pay or contact someone.',
  sponsored: 'A nearby label describes this control as sponsored or advertising.',
  self_claim: 'The page displays its own review claim.',
  limited: 'Only part of the public page was inspected.',
  publisher_vlc: 'The VLC version, Windows x64 architecture and distributor path agree.',
  publisher_7zip:
    'The current Windows x64 EXE row matches the release and filename in the publisher’s ip7z/7zip GitHub repository.',
  wrong_destination: 'This destination does not match the selected publisher and package.',
  other_option: 'This is another package, platform, release or page option.',
  unknown_link: 'This control has no inspectable web destination.',
  missing: 'No matching publisher control was identified.',
  duplicate: 'Multiple controls match the selected package.',
};
export const bindingSchema = z.strictObject({
  operationId: z.uuid(),
  taskId: z.uuid().nullable(),
  tabId: z.number().int().nonnegative(),
  documentId: z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i),
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revision: z.uuid(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  origin: z
    .string()
    .max(260)
    .refine((s) => {
      try {
        const u = new URL(s);
        return /^https?:$/.test(u.protocol) && u.origin === s;
      } catch {
        return false;
      }
    }),
});
export type ReviewBinding = z.infer<typeof bindingSchema>;
export const sourceSchema = z.strictObject({
  kind: z.enum(['business_reviews', 'homepage_threat']),
  source: z.enum(['unavailable', 'labelled_fixture']),
  state: z.enum([
    'unavailable',
    'no_coverage',
    'zero_reviews',
    'wrong_business',
    'stale',
    'matched',
    'no_match',
  ]),
  subject: z.string().max(280),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});
export type SourceCoverage = z.infer<typeof sourceSchema>;
export const Candidate = z.strictObject({
  ref: z.uuid(),
  label: z.string().max(96),
  packageHint: z.string().max(96),
  publisherPath: z
    .string()
    .max(140)
    .regex(
      /^\/(?:vlc\/[\d.]+\/win64\/vlc-[\d.]+-win64\.exe|ip7z\/7zip\/releases\/download\/[\d.]+\/7z\d+-x64\.exe)$/,
    )
    .nullable(),
  address: AddressObservation,
  relation: z.enum(['publisher_link', 'other_option', 'warning_pattern', 'unknown']),
  reason: Signal,
});
export type Candidate = z.infer<typeof Candidate>;
export const ReviewData = z
  .strictObject({
    binding: bindingSchema,
    cleanup:z.strictObject({at:z.iso.datetime(),count:z.number().int().min(1).max(30)}).optional(),
    selection: Selection,
    at: z.iso.datetime(),
    fixture: z.boolean(),
    address: AddressObservation,
    limited: z.boolean(),
    frames: z.boolean(),
    observations: z.array(Observation).max(16),
    sources: z.tuple([sourceSchema, sourceSchema]),
    status: z.enum([
      'reported_threat',
      'warning_signs',
      'limited_information',
      'no_known_warning_in_checked_sources',
    ]),
    fileState: z
      .enum(['identified', 'missing', 'ambiguous', 'unsupported', 'incomplete'])
      .nullable(),
    candidates: z.array(Candidate).max(12),
    selected: z.uuid().nullable(),
    placement: Placement.nullable(),
  })
  .refine((r) =>
    r.selection.kind === 'download'
      ? r.fileState === 'identified'
        ? r.selected !== null &&
          r.candidates.filter((c) => c.relation === 'publisher_link' && c.ref === r.selected)
            .length === 1
        : r.selected === null
      : r.fileState === null && r.selected === null,
  );
export type ReviewData = z.infer<typeof ReviewData>;
export const ReviewPageCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read'), selection: Selection }),
  z.strictObject({ kind: z.literal('show'), ref: z.uuid(), scroll: z.boolean() }),
  z.strictObject({ kind: z.literal('verify') }),
  z.strictObject({ kind: z.literal('hide') }),
  z.strictObject({ kind: z.literal('close') }),
]);
export const ReviewPageRequest = z.strictObject({
  channel: z.literal('review-page'),
  v: z.literal(1),
  requestId: z.uuid(),
  binding: bindingSchema,
  command: ReviewPageCommand,
});
export type ReviewPageRequest = z.infer<typeof ReviewPageRequest>;
export const ReviewPageReply = z.strictObject({
  channel: z.literal('review-result'),
  requestId: z.uuid(),
  binding: bindingSchema,
  ok: z.boolean(),
  data: ReviewData.nullable(),
});
export type ReviewPageReply = z.infer<typeof ReviewPageReply>;
export const ReviewChange = z.strictObject({
  channel: z.literal('review-change'),
  binding: bindingSchema,
  placement: Placement.optional(),
});
export function sameBinding(a: ReviewBinding, b: ReviewBinding) {
  return (
    a.operationId === b.operationId &&
    a.revision === b.revision &&
    a.tabId === b.tabId &&
    a.documentId === b.documentId &&
    a.origin === b.origin &&
    a.epoch === b.epoch &&
    a.generation === b.generation &&
    a.taskId === b.taskId
  );
}
