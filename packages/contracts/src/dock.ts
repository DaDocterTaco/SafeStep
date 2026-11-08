import { z } from 'zod';
import { documentToken, id } from './model.js';
import { safeChatText } from './chat-route.js';

export const dockAction = z.enum(['open', 'show', 'pause', 'stop', 'takeover', 'restore']);
export type DockAction = z.infer<typeof dockAction>;
const route = z.string().regex(/^[a-f0-9]{32}$/);
export const DockDisplay = z.discriminatedUnion('op', [
  z.strictObject({
    channel: z.literal('dock-display'),
    op: z.literal('show'),
    cap: id,
    route,
    documentId: documentToken,
    state: z.enum(['guide', 'automatic', 'paused', 'idle']),
    goal: z.string().min(1).max(240).refine(safeChatText).optional(),
    actions: z.array(dockAction).min(1).max(6),
  }),
  z.strictObject({ channel: z.literal('dock-display'), op: z.literal('clear'), cap: id }),
]);
export type DockDisplay = z.infer<typeof DockDisplay>;
export const DockControl = z.strictObject({
  channel: z.literal('dock-control'),
  cap: id,
  route,
  action: z.union([dockAction, z.literal('lost')]),
});
export type DockControl = z.infer<typeof DockControl>;
