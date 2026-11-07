import { z } from 'zod';
import { Placement, WorkflowId } from './guidance.js';
import {
  id,
  documentToken,
  tab,
  epoch,
  mode,
  origin,
  PanelView,
  PageSnapshot,
  Errors,
  TaskStep,
} from './model.js';
export const wireVersion = 2 as const;
const common = { v: z.literal(wireVersion), requestId: id, tabId: tab };
const command = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('view') }),
  z.strictObject({
    kind: z.literal('inspect'),
    goal: z.string().max(240),
    mode,
    profile: WorkflowId.optional(),
  }),
  z.strictObject({ kind: z.literal('guide'), workflow: WorkflowId }),
  z.strictObject({ kind: z.literal('reveal'), ref: id }),
  z.strictObject({ kind: z.literal('highlight'), step: TaskStep }),
  ...(
    [
      'clear',
      'pause',
      'resume',
      'cancel',
      'restore',
      'forget',
      'siteGranted',
      'siteDenied',
      'siteRemoved',
    ] as const
  ).map((kind) => z.strictObject({ kind: z.literal(kind) })),
  z.strictObject({ kind: z.literal('textSize'), large: z.boolean() }),
]);
export const PanelRequest = z.strictObject({
  ...common,
  channel: z.literal('panel'),
  windowId: tab,
  epoch,
  documentId: documentToken.nullable(),
  revision: id.nullable(),
  command,
});
export type PanelRequest = z.infer<typeof PanelRequest>;
export const binding = {
  ...common,
  channel: z.literal('bridge'),
  epoch,
  documentId: documentToken,
  origin,
};
export const BridgeRequest = z.strictObject({
  ...binding,
  command: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('snapshot'),
      access: z.enum(['temporary', 'site']),
      previousRevision: id.optional(),
      workflow: WorkflowId.optional(),
      profile: WorkflowId.optional(),
    }),
    z.strictObject({ kind: z.literal('fence') }),
    z.strictObject({ kind: z.literal('highlight'), revision: id, ref: id }),
    z.strictObject({ kind: z.literal('reveal'), revision: id, ref: id }),
    z.strictObject({ kind: z.literal('clear'), revision: id }),
  ]),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;
export const BridgeReply = z
  .strictObject({
    ...binding,
    ok: z.boolean(),
    error: Errors.nullable(),
    snapshot: PageSnapshot.nullable(),
    placement: Placement.optional(),
  })
  .refine((r) => r.ok === (r.error === null));
export type BridgeReply = z.infer<typeof BridgeReply>;
export const PanelReply = z
  .strictObject({
    ...common,
    channel: z.literal('panelReply'),
    ok: z.boolean(),
    error: Errors.nullable(),
    view: PanelView.nullable(),
  })
  .refine((r) => r.ok === (r.error === null));
export const Changed = z.strictObject({
  v: z.literal(wireVersion),
  channel: z.literal('changed'),
  tabId: tab,
  documentId: documentToken,
  revision: id,
  epoch,
  reason: z.enum(['page', 'element_missing', 'placement']),
  cue: z.strictObject({ ref: id, placement: Placement }).optional(),
});
export const maxWireBytes = 65536;
export function parseWire<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> | null {
  try {
    const serialized = JSON.stringify(raw);
    if (!serialized || new TextEncoder().encode(serialized).length > maxWireBytes) return null;
    const result = schema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
export function matchReply(req: BridgeRequest, raw: unknown) {
  const r = parseWire(BridgeReply, raw);
  if (
    !r ||
    r.requestId !== req.requestId ||
    r.documentId !== req.documentId ||
    r.epoch !== req.epoch ||
    r.tabId !== req.tabId ||
    r.origin !== req.origin
  )
    return null;
  if (r.ok && (req.command.kind === 'snapshot') !== !!r.snapshot) return null;
  if (
    r.snapshot &&
    req.command.kind === 'snapshot' &&
    r.snapshot.guide?.workflow !== req.command.workflow
  )
    return null;
  const c = r.snapshot?.context;
  if (
    c &&
    (c.documentId !== req.documentId ||
      c.tabId !== req.tabId ||
      c.origin !== req.origin ||
      req.command.kind !== 'snapshot' ||
      c.access !== req.command.access)
  )
    return null;
  return r;
}
