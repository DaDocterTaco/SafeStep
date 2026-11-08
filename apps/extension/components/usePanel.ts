import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PanelReply,
  messages,
  parseWire,
  type PanelRequest,
  type PanelView,
} from '@safestep/contracts';

type Command = PanelRequest['command'];

function sameSelectionContext(before: PanelView, after: PanelView) {
  const a = before.snapshot?.context,
    b = after.snapshot?.context;
  if (
    !a ||
    !b ||
    before.tabId !== after.tabId ||
    !before.task ||
    before.task.id !== after.task?.id ||
    a.documentId !== b.documentId ||
    a.origin !== b.origin
  )
    throw Error(messages.stale_document);
}
function currentRef(before: PanelView, after: PanelView, ref: string) {
  sameSelectionContext(before, after);
  const sameRevision = before.snapshot!.context.revision === after.snapshot!.context.revision;
  const control = after.snapshot!.controls.find(
    (c) => (sameRevision ? c.ref : c.previousRef) === ref,
  );
  if (!control) throw Error(messages.element_missing);
  return control.ref;
}

async function ask(t: { id: number; windowId: number }, v: PanelView | null, command: Command) {
  const request: PanelRequest = {
    v: 2,
    channel: 'panel',
    requestId: crypto.randomUUID(),
    tabId: t.id,
    windowId: t.windowId,
    epoch: v?.epoch ?? 0,
    documentId: v?.snapshot?.context.documentId ?? null,
    revision: v?.snapshot?.context.revision ?? null,
    command,
  };
  const raw = await chrome.runtime.sendMessage(request);
  const reply = parseWire(PanelReply, raw);
  if (
    !reply ||
    reply.requestId !== request.requestId ||
    reply.tabId !== request.tabId ||
    (reply.view && reply.view.tabId !== request.tabId)
  )
    throw Error(messages.invalid_message);
  if (!reply.ok || !reply.view) throw Error(messages[reply.error ?? 'invalid_message']);
  return reply.view;
}
export function usePanel() {
  const [view, setView] = useState<PanelView | null>(null),
    [error, setError] = useState('');
  const target = useRef<{ id: number; windowId: number } | null>(null),
    latest = useRef(0),
    session = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (seq !== latest.current) return;
      if (t?.id === undefined) {
        target.current = null;
        setView(null);
        setError('No active tab in this window.');
        return;
      }
      if (target.current?.id !== t.id) {
        session.current++;
        setView(null);
        setError('');
      }
      target.current = { id: t.id, windowId: t.windowId };
      const v = await ask(target.current, null, { kind: 'view' });
      if (seq === latest.current) {
        setView(v);
      }
    } catch {
      if (seq === latest.current) {
        setView(null);
        setError('The current tab is unavailable. Reopen SafeStep on an ordinary web page.');
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const switched = (a: chrome.tabs.OnActivatedInfo) => {
      if (target.current && a.windowId !== target.current.windowId) return;
      ++session.current;
      target.current = null;
      setView(null);
      setError('');
      void refresh();
    };
    const changed = (id: number, c: chrome.tabs.OnUpdatedInfo) => {
      if (id === target.current?.id && (c.url || c.status)) void refresh();
    };
    const stored = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' || (target.current && 'task:' + target.current.id in c)) void refresh();
    };
    const cue = (msg: unknown, sender: chrome.runtime.MessageSender) => {
      if (
        sender.id === chrome.runtime.id &&
        !sender.tab &&
        typeof msg === 'object' &&
        msg &&
        'channel' in msg &&
        msg.channel === 'cue-updated' &&
        'tabId' in msg &&
        msg.tabId === target.current?.id
      )
        void refresh();
    };
    chrome.runtime.onMessage.addListener(cue);
    chrome.tabs.onActivated.addListener(switched);
    chrome.tabs.onUpdated.addListener(changed);
    chrome.storage.onChanged.addListener(stored);
    return () => {
      latest.current++;
      chrome.tabs.onActivated.removeListener(switched);
      chrome.tabs.onUpdated.removeListener(changed);
      chrome.storage.onChanged.removeListener(stored);
      chrome.runtime.onMessage.removeListener(cue);
    };
  }, [refresh]);
  const command = async (c: Command) => {
    const t = target.current,
      version = session.current;
    if (!t || !view || view.tabId !== t.id) return;
    setError('');
    try {
      if (c.kind === 'highlight' || c.kind === 'clear') {
        // Reading the view wakes an idle worker. Its mandatory reinspection may have
        // paused the task and rotated its refs in the middle of this user's click.
        let fresh = await ask(t, null, { kind: 'view' });
        if (session.current !== version) return;
        sameSelectionContext(view, fresh);
        if (c.kind === 'clear') {
          if (fresh.task?.state !== 'paused') await ask(t, fresh, c); // Recovery already cleared it.
        } else if (c.kind === 'highlight') {
          let ref = currentRef(view, fresh, c.step.ref);
          if (fresh.task?.state === 'paused') {
            if (fresh.epoch === view.epoch || fresh.issue || view.task?.state === 'paused')
              throw Error(messages.blocked_by_policy);
            const resumed = await ask(t, fresh, { kind: 'resume' });
            if (session.current !== version) return;
            ref = currentRef(fresh, resumed, ref);
            fresh = resumed;
          }
          await ask(t, fresh, { ...c, step: { ...c.step, ref } });
        }
      } else if (c.kind === 'reveal') {
        const fresh = await ask(t, null, { kind: 'view' });
        if (session.current !== version) return;
        if (fresh.task?.state === 'paused')
          throw Error('Guidance is paused. Resume to find a fresh target.');
        sameSelectionContext(view, fresh);
        if (fresh.snapshot!.context.revision !== view.snapshot!.context.revision)
          throw Error(messages.stale_document);
        await ask(t, fresh, c);
      } else if (
        [
          'pause',
          'resume',
          'cancel',
          'guide',
          'inspect',
          'review',
          'shop',
          'assistGoal',
          'compare',
        ].includes(c.kind) ||
        (c.kind === 'assistControl' && ['pause', 'stop', 'takeover', 'edit'].includes(c.action))
      ) {
        const fresh = await ask(t, null, { kind: 'view' });
        if (session.current !== version) return;
        if (view.task?.id !== fresh.task?.id || view.origin !== fresh.origin)
          throw Error(messages.stale_document);
        // Waking a worker can already have paused this same task. A deliberate stop
        // still applies; no stale reference or action is replayed.
        if (
          !(c.kind === 'pause' && fresh.task?.state === 'paused') &&
          !(c.kind === 'cancel' && fresh.task?.state === 'cancelled')
        )
          await ask(t, fresh, c);
      } else await ask(t, view, c);
    } catch (e) {
      if (session.current === version)
        setError(e instanceof Error ? e.message : messages.invalid_message);
    } finally {
      if (session.current === version) void refresh();
    }
  };
  return { view, error, command };
}
