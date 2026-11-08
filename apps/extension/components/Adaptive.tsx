import { useRef, useState } from 'react';
import { AssistHealth, type PanelView } from '@safestep/contracts';
import type { usePanel } from './usePanel';
type Send = ReturnType<typeof usePanel>['command'];
export function Adaptive({
  v,
  send,
  edit,
}: {
  v: PanelView;
  send: Send;
  edit: (goal: string) => void;
}) {
  const t = v.task,
    a = t?.adaptive,
    ref = useRef<HTMLHeadingElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const previewStart = useRef<HTMLButtonElement>(null),
    modeButton = useRef<HTMLButtonElement>(null);
  if (!a || !t) return null;
  const action = (
    key: 'next' | 'automatic' | 'pause' | 'takeover' | 'stop' | 'resume' | 'reveal' | 'confirm',
  ) => {
    ref.current?.focus({ preventScroll: true });
    void send({ kind: 'assistControl', action: key });
  };
  const active = !['completed', 'cancelled'].includes(t.state),
    clarify = a.intent?.action === 'clarify' || a.intent?.action === 'unsupported';
  return (
    <section aria-label="Adaptive navigation">
      <h2 ref={ref} tabIndex={-1} className="guide-heading">
        {a.download ? 'Download guide' : 'Navigation guide'}
      </h2>
      <p className="goal-summary">{t.goal}</p>
      <p role="status" data-testid="assist-state">
        <strong>{t.state.replaceAll('_', ' ')}</strong> · {a.status}
      </p>
      <small>
        {t.steps} verified steps ·{' '}
        {a.profile === 'experimental' ? 'Public-page guidance' : a.profile} ·{' '}
        {a.authorized ? 'Automatic navigation authorized' : 'User-guided'}
      </small>
      {a.intent && !clarify && (
        <p>
          Requested subject · {a.intent.subjects.map((x) => x.text).join(', ')}
          {a.intent.constraints.length
            ? ' · Constraints: ' + a.intent.constraints.map((x) => x.text).join(', ')
            : ''}
          {a.intent.excluded.length
            ? ' · Excluding ' + a.intent.excluded.map((x) => x.text).join(', ')
            : ''}
        </p>
      )}
      {a.searchQuery && (
        <p>
          Public search query · <strong>{a.searchQuery}</strong>
        </p>
      )}
      {t.state==='paused' && a.download && a.calls>0 && !a.status.startsWith('Goal edited.') &&
        <button onClick={()=>void send({kind:'assistControl',action:'localDownload'})}>Use local publisher steps</button>}
      {clarify &&
        a.intent?.choices.map((choice) => (
          <button key={choice} onClick={() => edit(t.goal + ' — ' + choice)}>
            {choice}
          </button>
        ))}
      {active && !clarify && (
        <div className="actions">
          {t.state === 'awaiting_confirmation' && a.status.startsWith('Confirm that') ? (
            <button onClick={() => action('confirm')}>Yes, this is it</button>
          ) : (
            <>
              {['awaiting_confirmation', 'paused'].includes(t.state) && (
                <button onClick={() => action(t.state === 'paused' ? 'resume' : 'next')}>
                  {t.state === 'paused' ? 'Resume guide' : 'Show me'}
                </button>
              )}
              {a.intent &&
                ['awaiting_confirmation', 'paused', 'showing_step'].includes(t.state) &&
                !a.authorized &&
                (preview === t.id + '/' + a.version ? (
                  <div className="approval">
                    <p>
                      Allow SafeStep to follow verified public controls on{' '}
                      <strong>{new URL(a.origin).hostname}</strong> for this goal
                      {a.searchQuery ? ' and submit the displayed search' : ''}. You can pause, take
                      over or stop. Files and account changes stay with you.
                    </p>
                    <button
                      ref={previewStart}
                      onClick={() => {
                        setPreview(null);
                        action('automatic');
                      }}
                    >
                      Start automatic
                    </button>
                    <button
                      onClick={() => {
                        setPreview(null);
                        requestAnimationFrame(() => modeButton.current?.focus());
                      }}
                    >
                      Back
                    </button>
                  </div>
                ) : (
                  <button
                    ref={modeButton}
                    onClick={() => {
                      setPreview(t.id + '/' + a.version);
                      requestAnimationFrame(() => previewStart.current?.focus());
                    }}
                  >
                    Take me there
                  </button>
                ))}
              {a.intent && !a.authorized && t.state === 'showing_step' && (
                <button onClick={() => action('reveal')}>Show this target</button>
              )}
            </>
          )}
          {t.state !== 'paused' && (
            <button onClick={() => action('pause')}>Pause navigation</button>
          )}
          {a.authorized && <button onClick={() => action('takeover')}>Take over</button>}
        </div>
      )}
      {active && <button onClick={() => action('stop')}>Stop navigation</button>}
    </section>
  );
}
export function Cleanup({ v, send }: { v: PanelView; send: Send }) {
  const c = v.cleanup,
    button = useRef<HTMLButtonElement>(null);
  return (
    <section aria-label="Page cleanup">
      <h2>Page cleanup</h2>
      <button
        ref={button}
        disabled={!['temporary', 'site'].includes(v.access)}
        onClick={() => send({ kind: 'clean', action: 'preview' })}
      >
        Preview cleanup
      </button>
      {c && (
        <>
          <p role="status">
            {c.items.length} recognized · {c.hidden} hidden
            {c.limited ? ' · inspection limit reached' : ''}
          </p>
          {c.uncertain && <small>Other dialogs need your review.</small>}
          {!!c.failed && <small>{c.failed} regions could not stay hidden.</small>}
          {c.items.map((x) => (
            <div key={x.id}>
              {x.reason.replaceAll('_', ' ')} · {x.hidden ? 'hidden' : 'visible'}{' '}
              {x.hidden && (
                <button
                  onClick={() => {
                    button.current?.focus();
                    void send({ kind: 'clean', action: 'restore_one', id: x.id });
                  }}
                >
                  Restore item
                </button>
              )}
            </div>
          ))}
          {!c.enabled && c.items.length > 0 && (
            <button
              onClick={() => {
                button.current?.focus();
                void send({ kind: 'clean', action: 'apply' });
              }}
            >
              Apply cleanup
            </button>
          )}
          {c.enabled && (
            <button
              onClick={() => {
                button.current?.focus();
                void send({ kind: 'clean', action: 'restore' });
              }}
            >
              Restore cleanup
            </button>
          )}
        </>
      )}
    </section>
  );
}
export function NavigationConnection() {
  const [health, setHealth] = useState('');
  return (
    <details>
      <summary>Navigation AI connection</summary>
      <button
        onClick={async () => {
          try {
            const r = await fetch('http://127.0.0.1:4317/v1/assist/health', {
              credentials: 'omit',
              cache: 'no-store',
              redirect: 'error',
              signal: AbortSignal.timeout(2500),
            });
            const h = AssistHealth.parse(await r.json());
            setHealth(
              (h.configured ? 'Configured' : 'Not configured') +
                ' · intent ' +
                (h.intentVerified ? 'verified' : 'unverified') +
                ' · next step ' +
                (h.stepVerified ? 'verified' : 'unverified') +
                ' · ' +
                h.perMinute +
                '/minute, ' +
                h.perSession +
                '/session.',
            );
          } catch {
            setHealth('Local AI service unavailable.');
          }
        }}
      >
        Check navigation AI
      </button>
      <small role="status">{health}</small>
    </details>
  );
}
