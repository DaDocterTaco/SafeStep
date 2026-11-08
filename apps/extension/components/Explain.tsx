import { useEffect, useRef, useState } from 'react';
import {
  ExplainHealth,
  ExplainReply,
  PanelReply,
  parseWire,
  explanationInput,
  validatedExplanation,
  threatWarningLinks,
  sameBinding,
  type ReviewData,
  type ShoppingData,
  type Explanation,
} from '@safestep/contracts';
const endpoint = 'http://127.0.0.1:4317/v1/explain';
export const storageKey = 'local-ai-session';
export const tokenPattern = /^ss3_[A-Za-z0-9_-]{43}$/;
export function ConnectAI() {
  const [input, setInput] = useState(''),
    [note, setNote] = useState(''),
    [paired, setPaired] = useState(false);
  useEffect(() => {
    void chrome.storage.session
      .get(storageKey)
      .then((v) =>
        setPaired(typeof v[storageKey] === 'string' && tokenPattern.test(v[storageKey])),
      );
  }, []);
  async function connect() {
    if (!tokenPattern.test(input)) {
      setNote('Enter the local pairing token from the SafeStep service.');
      return;
    }
    const token = input;
    setInput('');
    try {
      const response = await fetch(endpoint + '/connect', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(3500),
      });
      const data = parseWire(ExplainHealth, await response.json());
      if (!response.ok || !data?.connected) throw Error();
      await chrome.storage.session.set({ [storageKey]: token });
      setPaired(true);
      setNote(
        data.state === 'not_configured'
          ? 'Connected. Gemini is unavailable until the server has a key and model.'
          : 'Connected to ' +
              data.provider +
              ' · ' +
              data.model +
              '. A valid response is required to verify access.',
      );
    } catch {
      setNote('Connection unavailable. Check the local service and its current pairing token.');
    }
  }
  return (
    <details>
      <summary>Connect local AI</summary>
      <p>Enter the 30-minute pairing token from your local SafeStep service.</p>
      <label>
        Local pairing token
        <input
          type="password"
          autoComplete="off"
          value={input}
          maxLength={64}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      <button onClick={connect}>Connect</button>
      {paired && (
        <button
          onClick={async () => {
            await chrome.storage.session.remove(storageKey);
            setPaired(false);
            setNote('Disconnected.');
          }}
        >
          Disconnect
        </button>
      )}
      <p role="status">{note}</p>
    </details>
  );
}
export async function currentReview(d: ReviewData | ShoppingData) {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (t?.id !== d.binding.tabId) return false;
  const requestId = crypto.randomUUID();
  const r = parseWire(
    PanelReply,
    await chrome.runtime.sendMessage({
      v: 2,
      channel: 'panel',
      requestId,
      tabId: t.id,
      windowId: t.windowId,
      epoch: 0,
      documentId: null,
      revision: null,
      command: { kind: 'view' },
    }),
  );
  const current = 'kind' in d ? r?.view?.shopping?.[d.kind]?.data : r?.view?.review;
  if (!r?.ok || r.requestId !== requestId || !current || !sameBinding(d.binding, current.binding))
    return false;
  const checkedId = crypto.randomUUID(),
    ctx = r.view!.snapshot?.context;
  const checked = parseWire(
    PanelReply,
    await chrome.runtime.sendMessage({
      v: 2,
      channel: 'panel',
      requestId: checkedId,
      tabId: t.id,
      windowId: t.windowId,
      epoch: r.view!.epoch,
      documentId: ctx?.documentId ?? null,
      revision: ctx?.revision ?? null,
      command:
        'kind' in d
          ? { kind: 'shopVerify', subject: d.kind, operationId: d.binding.operationId }
          : { kind: 'reviewVerify', operationId: d.binding.operationId },
    }),
  );
  const verified = 'kind' in d ? checked?.view?.shopping?.[d.kind]?.data : checked?.view?.review;
  return (
    !!checked?.ok &&
    checked.requestId === checkedId &&
    !!verified &&
    sameBinding(d.binding, verified.binding)
  );
}
export function Explain({ data,receipt }: { data: ReviewData; receipt?:import('@safestep/contracts').ThreatReply }) {
  const [result, setResult] = useState<Explanation | null>(null),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const disconnect = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && storageKey in c) {
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
        setResult(null);
        setNote('Connection changed.');
      }
    };
    chrome.storage.onChanged.addListener(disconnect);
    return () => {
      chrome.storage.onChanged.removeListener(disconnect);
      pending.current?.abort();
      pending.current = null;
    };
  }, []);
  async function explain() {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setNote('');
    setResult(null);
    try {
      const token = (await chrome.storage.session.get(storageKey))[storageKey];
      if (typeof token !== 'string' || !tokenPattern.test(token)) {
        setNote('AI explanation unavailable. Connect the local service to use Gemini.');
        return;
      }
      if (!(await currentReview(data)) || request.signal.aborted) return;
      const input = explanationInput(data,receipt);
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
      });
      if (!r.ok) throw Error('unavailable');
      const reply = parseWire(ExplainReply, await r.json());
      if (request.signal.aborted || !(await currentReview(data))) return;
      if (reply?.operationId !== input.operationId || reply.bindingToken !== input.bindingToken)
        throw Error('unavailable');
      const valid = validatedExplanation(reply.explanation, input);
      if (reply.status === 'available' && valid) setResult(valid);
      else setNote('AI explanation unavailable (' + reply.status.replaceAll('_', ' ') + ').');
    } catch {
      if (!request.signal.aborted)
        setNote('AI explanation unavailable. The local check is still available.');
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div>
      <strong>AI explanation</strong>
      <button disabled={busy} onClick={explain}>
        {busy
          ? 'Waiting for Gemini…'
          : data.selection.kind === 'website'
            ? 'Explain this check'
            : 'Why this button?'}
      </button>
      {busy && (
        <button
          onClick={() => {
            pending.current?.abort();
            pending.current = null;
            setBusy(false);
            setNote('Explanation cancelled.');
          }}
        >
          Cancel explanation
        </button>
      )}
      <p role="status">{note}</p>
      {result && (
        <div>
          <strong>Gemini explanation</strong>
          {receipt?.status==='match' && <p>{threatWarningLinks(receipt).map(link=>
            <a key={link.url} href={link.url} rel="noreferrer" target="_blank">{link.label}{' '}</a>)}</p>}
          <p>{result.summary}</p>
          {result.reasons.map((r) => (
            <p key={r.evidenceId}>
              {r.text} [{r.evidenceId}]
            </p>
          ))}
          <p>{result.nextStep}</p>
          {result.coverageLimits.map((l) => (
            <small key={l}>{l}</small>
          ))}
        </div>
      )}
    </div>
  );
}
