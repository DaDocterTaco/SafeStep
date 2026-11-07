import {
  Fault,
  type Checkpoint,
  type PageSnapshot,
  type PanelRequest,
  type TaskSession,
  type WorkflowId,
  type Placement,
} from '@safestep/contracts';

export type RecordState = {
  cp: Checkpoint;
  snapshot: PageSnapshot | null;
  windowId?: number;
  busy?: string;
  binding?: { documentId: string; origin: string };
  navigation?: { taskId: string; workflow: WorkflowId; from: number };
  inspectProfile?: WorkflowId;
  cue?: { ref: string; placement: Placement };
};
export function blank(tabId: number): RecordState {
  return {
    cp: { tabId, epoch: 0, invokedOrigin: null, knownOrigin: null, issue: null, task: null },
    snapshot: null,
  };
}
export function live(t: TaskSession | null) {
  return !!t && !['cancelled', 'completed', 'failed'].includes(t.state);
}
export function advance(s: RecordState) {
  s.cp.epoch = Math.max(Date.now() * 1000, s.cp.epoch + 1);
  s.busy = undefined;
  s.snapshot = null;
  s.cue = undefined;
  if (s.cp.task) {
    s.cp.task.epoch = s.cp.epoch;
    s.cp.task.documentId = null;
    s.cp.task.revision = null;
  }
  return s.cp.epoch;
}
export function guard(s: RecordState, expected: number) {
  if (s.cp.epoch !== expected)
    throw new Fault(s.cp.task?.cancelled ? 'cancelled' : 'stale_document');
}
export function checkRequest(s: RecordState, r: PanelRequest) {
  guard(s, r.epoch);
  const ctx = s.snapshot?.context;
  if (r.documentId !== (ctx?.documentId ?? null) || r.revision !== (ctx?.revision ?? null))
    throw new Fault('stale_document');
}
export function canHighlight(s: RecordState, step: { ref: string; expectedOrigin: string }) {
  if (!s.cp.task || s.cp.task.cancelled) throw new Fault('cancelled');
  if (!s.snapshot || !['awaiting_user', 'showing_step'].includes(s.cp.task.state))
    throw new Fault('blocked_by_policy');
  if (s.snapshot.context.origin !== step.expectedOrigin) throw new Fault('stale_document');
  if (!s.snapshot.controls.some((c) => c.ref === step.ref)) throw new Fault('element_missing');
}
