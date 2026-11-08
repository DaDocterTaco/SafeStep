import { useEffect, useRef, useState } from 'react';
import {
  checkedCleanAdvice,
  CleanAdviceInput,
  CleanAdviceReply,
  cleanupDescriptions,
  cleanupScope,
  PanelReply,
  sameBinding,
  type CleanupView,
} from '@safestep/contracts';
import { storageKey, tokenPattern } from './Explain';
import type { Send } from './ChatCards';

export function CleanupAdvice({
  preview,
  turnId,
  applyAll,
  goal,
  send,
}: {
  preview: CleanupView;
  turnId: string;
  applyAll: () => void;
  goal:string;
  send: Send;
}) {
  const [advice, setAdvice] = useState<ReturnType<typeof checkedCleanAdvice>>(null);
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const { binding: b } = preview;
  const scope=cleanupScope(goal);
  const candidates = preview.items.flatMap((i) =>
    !i.hidden && i.signal && scope.allowed.includes(i.reason) ? [{ id: i.id, reason: i.reason, signal: i.signal }] : [],
  );
  async function current() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== b.tabId) return false;
    const requestId = crypto.randomUUID();
    const reply = PanelReply.safeParse(
      await chrome.runtime.sendMessage({
        v: 2,
        channel: 'panel',
        requestId,
        tabId: b.tabId,
        windowId: tab.windowId,
        epoch: 0,
        documentId: null,
        revision: null,
        command: { kind: 'view' },
      }),
    );
    if (!reply.success || reply.data.requestId !== requestId || !reply.data.ok) return false;
    const v = reply.data.view;
    return (
      !!v?.cleanup &&
      !v.cleanup.enabled &&
      v.chat?.activeTurnId === turnId &&
      sameBinding(v.cleanup.binding, b) &&
      JSON.stringify(v.cleanup.items) === JSON.stringify(preview.items)
    );
  }
  async function ask() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage('');
    try {
      const token = (await chrome.storage.session.get(storageKey))[storageKey];
      if (typeof token !== 'string' || !tokenPattern.test(token)) {
        setMessage('Gemini is not paired. You can still use the local preview.');
        return;
      }
      const input = CleanAdviceInput.parse({
        operationId: b.operationId,
        bindingToken: b.revision,
        candidates,
      });
      if (!(await current()) || controller.signal.aborted) return;
      const response = await fetch('http://127.0.0.1:4317/v1/cleanup/classify', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        body: JSON.stringify(input),
      });
      if (!response.ok) throw Error();
      const body = await response.text();
      if (body.length > 8192) throw Error();
      const result = CleanAdviceReply.parse(JSON.parse(body));
      if (controller.signal.aborted || !(await current())) return;
      if (result.operationId !== b.operationId || result.bindingToken !== b.revision) throw Error();
      const valid = checkedCleanAdvice(result.explanation, input);
      if (result.status !== 'available' || !valid) {
        setMessage(
          'Gemini could not classify this preview (' +
            result.status.replaceAll('_', ' ') +
            '). The local preview remains available.',
        );
        return;
      }
      setAdvice(valid);
    } catch {
      if (!controller.signal.aborted)
        setMessage('Gemini advice is unavailable. You can still use the local preview.');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  if (preview.enabled) return null;
  if(!candidates.length&&scope.restricted) return <p>{scope.unclear?'Which marked regions may be hidden? This preview cannot identify the exception you named.':'No eligible region matches what you asked to hide.'}</p>;
  if (!candidates.length)
    return preview.items.length ? (
      <button className="primary" onClick={applyAll}>
        Apply cleanup
      </button>
    ) : null;
  const ids = advice?.regions.filter((r) => r.choice === 'offer_hide').map((r) => r.id) ?? [];
  return (
    <>
      {!advice && (
        <button className="primary" onClick={applyAll}>
          Apply cleanup
        </button>
      )}
      {!advice && (
        <button disabled={busy} onClick={() => void ask()}>
          Review these regions with Gemini
        </button>
      )}
      {busy && (
        <button
          onClick={() => {
            pending.current?.abort();
            setMessage('Review cancelled.');
          }}
        >
          Cancel Gemini review
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {advice && (
        <div>
          <p>Gemini reviewed the local region labels. Nothing has been hidden.</p>
          {advice.regions.map((r) => {
            const c = candidates.find((c) => c.id === r.id);
            return c ? (
              <p key={r.id}>
                {cleanupDescriptions[c.signal]} ·{' '}
                {r.choice === 'offer_hide' ? 'suggested for hiding' : 'keep visible'}
              </p>
            ) : null;
          })}
          {!!ids.length && (
            <button
              onClick={() =>
                void send({
                  kind: 'clean',
                  action: 'apply',
                  selection: { operationId: b.operationId, revision: b.revision, ids },
                })
              }
            >
              Apply suggested regions
            </button>
          )}
          <button onClick={() => setAdvice(null)}>Use local preview</button>
        </div>
      )}
    </>
  );
}
