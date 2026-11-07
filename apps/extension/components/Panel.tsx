import { useState } from 'react';
import { messages, type PanelView } from '@safestep/contracts';
import { registry } from '../features';
import { pattern } from '../core/access';
import { usePanel } from './usePanel';
import { Sources } from './Sources';
import { Guidance, Reveal, AddressCard, AddressInspector } from './Guidance';

type Send = ReturnType<typeof usePanel>['command'];
const accessText: Record<PanelView['access'], string> = {
  temporary: 'Access for this visit',
  site: 'Enabled on this site',
  permission_denied: 'Site access declined',
  permission_required: 'Access needed',
  permission_revoked: 'Access removed',
  unsupported_page: 'Unsupported page',
};
const stateText: Record<string, string> = {
  inspecting: 'Inspecting…',
  awaiting_user: 'Ready to highlight',
  showing_step: 'Showing highlight',
  paused: 'Paused',
  cancelled: 'Cancelled',
};
function Workspace({ v, send }: { v: PanelView; send: Send }) {
  const [goal, setGoal] = useState(v.task?.goal ?? ''),
    [mode, setMode] = useState<'guide' | 'automatic'>(v.task?.mode ?? 'guide');
  const [grantError, setGrantError] = useState('');
  const active = v.access === 'temporary' || v.access === 'site',
    snap = v.snapshot,
    t = v.task;
  const enabled = !!v.origin && v.prefs.sites.includes(v.origin);
  async function grant() {
    if (!v.origin) return;
    setGrantError('');
    try {
      const ok = await chrome.permissions.request({ origins: [pattern(v.origin)] });
      await send({ kind: ok ? 'siteGranted' : 'siteDenied' });
    } catch {
      setGrantError('Chrome could not grant access to this site.');
    }
  }
  return (
    <main>
      <section aria-label="Current page">
        <header className="row">
          <span className="eyebrow">CURRENT PAGE</span>
          <span className="badge" data-on={active}>
            {accessText[v.access]}
          </span>
        </header>
        <h2>{snap?.title || v.origin || 'No accessible page'}</h2>
        {v.origin && <p className="origin">{v.origin}</p>}
        {!active && (
          <p>
            {
              messages[
                v.access === 'unsupported_page'
                  ? 'unsupported_page'
                  : v.access === 'permission_revoked'
                    ? 'permission_revoked'
                    : 'permission_required'
              ]
            }
          </p>
        )}
        {v.issue && (
          <p role="status" className="notice">
            {messages[v.issue]}
          </p>
        )}
      </section>
      <Guidance v={v} send={send} goal={goal} setGoal={setGoal} />
      {t?.guide && snap?.address && (
        <section>
          <AddressCard address={snap.address} title="Current website" />
        </section>
      )}
      <AddressInspector v={v} send={send} />
      <section aria-label="Manual page inspector">
        <h2>Manual page inspector</h2>
        <div className="modes" aria-label="Task mode">
          {(['guide', 'automatic'] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'guide' ? 'Guide me' : 'Take me there'}
            </button>
          ))}
        </div>
        <p>
          {mode === 'guide'
            ? 'Choose a page control to outline it.'
            : 'Automatic navigation is planned. The inspector can outline a control; it cannot click or change the page for you.'}
        </p>
        <button
          disabled={!active || t?.state === 'inspecting'}
          onClick={() => send({ kind: 'inspect', goal, mode })}
        >
          Inspect page
        </button>
        {t && !t.guide && (
          <div className="progress">
            <strong data-testid="task-state" role="status">
              {stateText[t.state] ?? t.state}
            </strong>
            <small>
              {t.steps} verified {t.steps === 1 ? 'step' : 'steps'}
            </small>
          </div>
        )}
        {t && !t.guide && !t.cancelled && (
          <div className="actions">
            <button
              onClick={() => send({ kind: t.state === 'paused' ? 'resume' : 'pause' })}
              disabled={t.state === 'paused' && !active}
            >
              {t.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button onClick={() => send({ kind: 'cancel' })}>Cancel task</button>
          </div>
        )}
      </section>
      {snap && !t?.guide && (
        <section aria-label="Page controls">
          <div className="row">
            <h2>Page controls</h2>
            <span className="count">{snap.controls.length}</span>
          </div>
          <p>Choose a control to highlight it on the page.</p>
          {v.cue && (
            <Reveal
              position={v.cue.placement}
              show={() => send({ kind: 'reveal', ref: v.cue!.ref })}
            />
          )}
          {!snap.controls.length && <p>No visible links or buttons found.</p>}
          <ul className="controls">
            {snap.controls.map((c) => (
              <li key={c.ref}>
                <button
                  className="control"
                  disabled={t?.state === 'paused'}
                  aria-label={'Highlight ' + c.label}
                  onClick={() =>
                    send({
                      kind: 'highlight',
                      step: {
                        id: crypto.randomUUID(),
                        kind: 'highlight',
                        ref: c.ref,
                        expectedOrigin: snap.context.origin,
                        requiredAccess: 'inspect',
                        expectedOutcome: 'visible_outline',
                        confirmation: 'user_request',
                      },
                    })
                  }
                >
                  <span className="kind">{c.kind}</span>
                  <b>{c.label}</b>
                  <small>{c.destination ?? 'Destination unknown'}</small>
                </button>
              </li>
            ))}
          </ul>
          {snap.limited && <small>Inspection limit reached; more controls may exist.</small>}
          {snap.framesSkipped && <small>Embedded frames were not inspected.</small>}
          <button disabled={t?.state === 'paused'} onClick={() => send({ kind: 'clear' })}>
            Clear highlight
          </button>
        </section>
      )}
      <details>
        <summary>Access &amp; preferences</summary>
        <p>
          Site access lets SafeStep connect on future visits. Automatic checks are not built yet.
        </p>
        {enabled ? (
          <button onClick={() => send({ kind: 'siteRemoved' })}>Remove site access</button>
        ) : (
          <button disabled={!v.origin} onClick={grant}>
            Enable on this site
          </button>
        )}
        {grantError && <p role="alert">{grantError}</p>}
        <label className="check">
          <input
            type="checkbox"
            checked={v.prefs.largeText}
            onChange={(e) => send({ kind: 'textSize', large: e.target.checked })}
          />{' '}
          Larger text
        </label>
        <div className="actions">
          <button onClick={() => send({ kind: 'restore' })}>Restore page</button>
          <button onClick={() => send({ kind: 'forget' })}>Clear SafeStep data</button>
        </div>
      </details>
      <Sources domain={v.origin ? new URL(v.origin).hostname : null} />
      <details>
        <summary>
          Product features <span className="count">9</span>
        </summary>
        <ol>
          {registry.map((f) => (
            <li key={f.id}>
              {f.name}{' '}
              <small>{f.status === 'implemented' ? 'Available in Stage 2' : 'Planned'}</small>
            </li>
          ))}
        </ol>
      </details>
    </main>
  );
}
export function Panel() {
  const { view, error, command } = usePanel();
  return (
    <div className={view?.prefs.largeText ? 'large' : ''}>
      <div className="mast">
        <span className="mark" aria-hidden="true">
          S
        </span>
        <div>
          <h1>SafeStep</h1>
          <small>Page companion</small>
        </div>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {view ? (
        <Workspace key={view.tabId} v={view} send={command} />
      ) : (
        <p role="status" className="waiting">
          {error ? 'Waiting for a tab.' : 'Connecting to this tab…'}
        </p>
      )}
    </div>
  );
}
