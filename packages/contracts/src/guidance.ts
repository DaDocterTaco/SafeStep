import { z } from 'zod';

export const WorkflowId = z.enum(['wikipedia_cite_apa', 'videolan_windows_page']);
export type WorkflowId = z.infer<typeof WorkflowId>;
export const AddressFlag = z.enum([
  'user_info',
  'label_mismatch',
  'embedded_expected_domain',
  'similar_spelling',
  'international',
  'ip_address',
  'unknown_suffix',
  'unexpected_scheme',
  'nondefault_port',
  'trailing_dot',
]);
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.[\]:_-]+$/);
export const AddressObservation = z.strictObject({
  host: host.nullable(),
  domain: host.nullable(),
  expected: host.nullable(),
  scheme: z.enum(['http', 'https']).nullable(),
  port: z.string().regex(/^\d{0,5}$/),
  relationship: z.enum([
    'expected_host',
    'same_registered_domain_other_host',
    'different_domain',
    'no_expected_site',
    'uninspectable_destination',
    'invalid_or_unsupported_address',
  ]),
  flags: z.array(AddressFlag).max(10),
  allowed: z.boolean(),
});
export type AddressObservation = z.infer<typeof AddressObservation>;
// Local observations live inside a timestamped, document-bound PageSnapshot; never provider subjects.
export const Placement = z.enum(['visible', 'above', 'below', 'beside']);
export type Placement = z.infer<typeof Placement>;
export const GuideFacts = z
  .strictObject({
    workflow: WorkflowId,
    version: z.literal(1),
    step: z.number().int().min(1).max(3),
    result: z.enum([
      'target',
      'complete',
      'unsupported',
      'missing',
      'duplicate',
      'unexpected_link',
    ]),
    ref: z.uuid().nullable(),
    placement: Placement.nullable(),
    link: AddressObservation.nullable(),
  })
  .refine((f) => (f.result === 'target') === (!!f.ref && !!f.placement));
export type GuideFacts = z.infer<typeof GuideFacts>;
export const Progress = z.strictObject({
  workflow: WorkflowId,
  step: z.number().int().min(1).max(3),
});
