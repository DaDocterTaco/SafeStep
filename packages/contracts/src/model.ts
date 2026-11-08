import { CompareView, CompareSettings } from './comparison.js';
import { ProtectionPreferences, ProtectionView } from './protection.js';
import { z } from 'zod';
import { AddressObservation, GuideFacts, Placement, Progress } from './guidance.js';
import { bindingSchema, ReviewData } from './review.js';
import { ShopView } from './shopping.js';
import { AdaptiveState, CleanupView } from './assist.js';
import { ChatConversation } from './conversation.js';

export { FeatureId, Features } from './features.js';
export const Errors = z.enum([
  'permission_required',
  'permission_denied',
  'permission_revoked',
  'unsupported_page',
  'stale_document',
  'element_missing',
  'provider_not_configured',
  'provider_unavailable',
  'timeout',
  'cancelled',
  'invalid_message',
  'blocked_by_policy',
]);
export type ErrorCode = z.infer<typeof Errors>;
export const messages: Record<ErrorCode, string> = {
  permission_required: 'Click the SafeStep toolbar button on this page to give access.',
  permission_denied: 'Site access was declined. No automatic access was enabled.',
  permission_revoked: 'Site access was removed. Click the toolbar button to inspect again.',
  unsupported_page:
    'SafeStep can inspect ordinary HTTP and HTTPS pages. Browser pages, the Chrome Web Store and embedded frames are unsupported.',
  stale_document: 'The page or task changed. Inspect again to get fresh controls.',
  element_missing: 'This control is no longer available. Inspect the page again.',
  provider_not_configured: 'This source is not configured.',
  provider_unavailable: 'No verified evidence is available from this source.',
  timeout: 'The request timed out. Inspect again before continuing.',
  cancelled: 'The task was cancelled.',
  invalid_message: 'The request or reply was not valid.',
  blocked_by_policy: 'This action is not available in the current state.',
};
export class Fault extends Error {
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
  }
}
export const id = z.uuid();
// Chrome document identifiers are opaque tokens, not extension-generated RFC UUIDs.
export const documentToken = z
  .string()
  .regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
export const tab = z.number().int().nonnegative();
export const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().max(96);
export const mode = z.enum(['guide', 'automatic']);
export const states = z.enum([
  'idle',
  'inspecting',
  'planning',
  'showing_step',
  'awaiting_user',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'paused',
  'completed',
  'cancelled',
  'failed',
]);
export const Access = z.enum([
  'temporary',
  'site',
  'permission_required',
  'permission_denied',
  'permission_revoked',
  'unsupported_page',
]);
export const origin = z
  .string()
  .max(260)
  .refine((s) => {
    try {
      const u = new URL(s);
      return ['http:', 'https:'].includes(u.protocol) && u.origin === s;
    } catch {
      return false;
    }
  });
export const capability = z.enum(['inspect', 'highlight', 'clear']);
export const PageContext = z.strictObject({
  tabId: tab,
  frameId: z.literal(0),
  documentId: documentToken,
  revision: id,
  origin,
  route: z.string().max(256),
  access: z.enum(['temporary', 'site']),
  capabilities: z.array(capability).max(3),
});
export const Control = z.strictObject({
  ref: id,
  previousRef: id.optional(),
  kind: z.enum(['link', 'button']),
  label,
  destination: z.string().max(512).nullable(),
  address: AddressObservation.optional(),
});
export const PageSnapshot = z.strictObject({
  context: PageContext,
  capturedAt: z.iso.datetime(),
  title: z.string().max(160),
  controls: z.array(Control).max(32),
  limited: z.boolean(),
  framesSkipped: z.boolean(),
  address: AddressObservation.optional(),
  guide: GuideFacts.optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;
export const TaskSession = z.strictObject({
  adaptive: AdaptiveState.optional(),
  id: id,
  tabId: tab,
  goal: z.string().max(240),
  mode,
  state: states,
  epoch,
  documentId: documentToken.nullable(),
  revision: id.nullable(),
  lastVerified: z.enum(['inspected', 'highlighted', 'cleared']).nullable(),
  steps: z.number().int().min(0).max(1000000),
  cancelled: z.boolean(),
  guide: Progress.optional(),
});
export type TaskSession = z.infer<typeof TaskSession>;
export const TaskStep = z.strictObject({
  id,
  kind: z.literal('highlight'),
  ref: id,
  expectedOrigin: origin,
  requiredAccess: z.literal('inspect'),
  expectedOutcome: z.literal('visible_outline'),
  confirmation: z.literal('user_request'),
});
export type TaskStep = z.infer<typeof TaskStep>;
export const Preferences = z.strictObject({
  largeText: z.boolean(),
  sites: z.array(origin).max(64),
  protection: ProtectionPreferences.optional(),
});
export type Preferences = z.infer<typeof Preferences>;
export const Checkpoint = z.strictObject({
  chat: ChatConversation.optional(),
  compare: z
    .strictObject({
      id: z.uuid(),
      version: z.number().int().positive(),
      origin: z.string().max(260),
      url: z.string().max(512),
      baselineId: z.string().max(160).optional(),
      settings: CompareSettings.optional(),
    })
    .optional(),
  cleanup: bindingSchema.optional(),
  shopping: z
    .strictObject({ seller: bindingSchema.optional(), product: bindingSchema.optional() })
    .optional(),
  review: bindingSchema.optional(),
  tabId: tab,
  epoch,
  invokedOrigin: origin.nullable(),
  knownOrigin: origin.nullable(),
  issue: Errors.nullable(),
  task: TaskSession.nullable(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;
export const PanelView = z.strictObject({
  chat: ChatConversation.optional(),
  protection: ProtectionView.optional(),
  comparison: CompareView.optional(),
  cleanup: CleanupView.optional(),
  shopping: z
    .strictObject({ seller: ShopView.optional(), product: ShopView.optional() })
    .optional(),
  review: ReviewData.optional(),
  reviewStale: z.boolean().optional(),
  tabId: tab,
  epoch,
  origin: origin.nullable(),
  access: Access,
  issue: Errors.nullable(),
  snapshot: PageSnapshot.nullable(),
  task: TaskSession.nullable(),
  prefs: Preferences,
  cue: z.strictObject({ ref: id, placement: Placement }).optional(),
});
export type PanelView = z.infer<typeof PanelView>;
export function permittedOrigin(raw?: string): string | null {
  try {
    const u = new URL(raw ?? '');
    if (
      !origin.safeParse(u.origin).success ||
      (['chromewebstore.google.com', 'chrome.google.com'].includes(u.hostname) &&
        (u.hostname === 'chromewebstore.google.com' || u.pathname.startsWith('/webstore')))
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}
