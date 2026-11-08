import { z } from 'zod';
import { FeatureId } from './features.js';
import { FileProfile } from './review.js';

export const ChatState = z.enum([
  'idle',
  'routing',
  'clarifying',
  'awaiting_access',
  'preview_ready',
  'working',
  'awaiting_user',
  'paused',
  'completed',
  'stale',
  'unsupported',
  'unavailable',
  'error',
]);
export type ChatState = z.infer<typeof ChatState>;
export const ChatTurn = z.strictObject({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(600),
  state: ChatState,
  feature: FeatureId.optional(),
  choices: z.array(z.string().max(160)).max(3).optional(),
  suggestions: z.array(FeatureId).max(3).optional(),
  origin: z.string().max(260).nullable(),
  documentId: z.string().max(150).nullable(),
  epoch: z.number().int().nonnegative(),
  historical: z.boolean(),
  scope: z.string().max(80).optional(),
  taskId: z.uuid().optional(),
  operationId: z.uuid().optional(),
  version: z.number().int().nonnegative().optional(),
  original: z.string().max(240).optional(),
  mode: z.enum(['guide', 'automatic']).optional(),
  comparisonMode: z
    .enum(['same_product_other_sellers', 'similar_products', 'compare_selected'])
    .optional(),
  profile: FileProfile.optional(),
  clarifications: z.number().int().min(0).max(2).optional(),
});
export type ChatTurn = z.infer<typeof ChatTurn>;
export function chatCharacters(turn: ChatTurn) {
  return (
    turn.text.length +
    (turn.original?.length ?? 0) +
    (turn.choices ?? []).reduce((n, s) => n + s.length, 0)
  );
}
export const ChatConversation = z
  .strictObject({
    id: z.uuid(),
    turns: z.array(ChatTurn).max(50),
    activeTurnId: z.uuid().nullable(),
  })
  .refine((c) => c.turns.reduce((n, t) => n + chatCharacters(t), 0) <= 12000);
export type ChatConversation = z.infer<typeof ChatConversation>;
const cursor = { conversationId: z.uuid().optional() };
const text = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.trim().length > 0);
export const ChatAction = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('submit'), ...cursor, text, replyTo: z.uuid().optional() }),
  z.strictObject({ op: z.literal('shortcut'), ...cursor, feature: FeatureId, text }),
  z.strictObject({ op: z.enum(['clear', 'cancel']), ...cursor }),
  z.strictObject({
    op: z.literal('act'),
    conversationId: z.uuid(),
    turnId: z.uuid(),
    action: z.enum([
      'guide',
      'automatic',
      'pause',
      'stop',
      'takeover',
      'resume',
      'restore',
      'apply',
      'reveal',
      'retry',
      'confirm',
      'localDownload',
      'returnCatalog',
      'refreshEvidence',
      'dismissEvidence',
    ]),
  }),
]);
export type ChatAction = z.infer<typeof ChatAction>;
