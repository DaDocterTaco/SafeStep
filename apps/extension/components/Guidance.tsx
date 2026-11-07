import { useState } from 'react';
import type { AddressObservation, PanelView, Placement, WorkflowId } from '@safestep/contracts';
import { explainAddress, flagText } from '../sites/address-copy';
import { resolveGoal, workflows, workflowIds } from '../sites/profiles';
import type { usePanel } from './usePanel';
type Send = ReturnType<typeof usePanel>['command'];
export function AddressCard({ address: a, title }: { address: AddressObservation; title: string }) {
  return (
    <div className="address" aria-label={title}>
      <strong>{title}</strong>
      <div className="hostname">
        {a.host ?? 'Destination unknown'}
        {a.port ? ':' + a.port : ''}
      </div>
      <p>{explainAddress(a)}</p>
      {a.domain && <small>Registered domain: {a.domain}</small>}
      {a.expected && <small>Expected: {a.expected}</small>}
      {a.flags.map((flag) => (
        <p className="flag" key={flag}>
          {flagText[flag]}
        </p>
      ))}
      <small>Local address check only. Site safety and later redirects are unknown.</small>
    </div>
  );
}
export function Reveal({ position, show }: { position: Placement; show: () => void }) {
  if (position === 'visible') return null;
  return (
    <div className="location">
      <p>
        {position === 'below'
          ? 'The outlined control is below the visible page.'
          : position === 'above'
            ? 'The outlined control is above the visible page.'
            : 'The outlined control is outside the visible area.'}
      </p>
      <button type="button" onClick={show}>
        Show me
      </button>
    </div>
  );
}
export function Guidance({
  v,
  send,
  goal,
  setGoal,
}: {
  v: PanelView;
  send: Send;
  goal: string;
  setGoal: (g: string) => void;
}) {
  const [feedback, setFeedback] = useState(''),
    [choices, choose] = useState(false);
  const active = ['temporary', 'site'].includes(v.access),
    task = v.task,
    g = task?.guide,
    f = v.snapshot?.guide;
  const start = (id: WorkflowId) => {
    setGoal(workflows[id].goal);
    choose(false);
    setFeedback('');
    void send({ kind: 'guide', workflow: id });
  };
  function help() {
    const id = resolveGoal(goal);
    if (id === 'clarify' || id === 'unsupported') {
      if (task && !['completed', 'paused', 'cancelled'].includes(task.state))
        void send({ kind: 'pause' });
      setFeedback(
        id === 'clarify'
          ? 'Which task would you like help with?'
          : 'That task isn’t supported. Choose one of these two tasks.',
      );
      choose(true);
    } else start(id);
  }
  return (
    <section aria-label="Guided task">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          help();
        }}
      >
        <label htmlFor="goal" className="eyebrow">
          YOUR GOAL
        </label>
        <input
          id="goal"
          maxLength={240}
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value);
            setFeedback('');
          }}
          placeholder="What would you like to find?"
        />
        <button className="primary" disabled={!active}>
          Help me
        </button>
      </form>
      <button
        type="button"
        className="task-picker"
        aria-expanded={choices}
        onClick={() => choose(!choices)}
      >
        Choose a supported task
      </button>
      {feedback && <p role="status">{feedback}</p>}
      {choices && (
        <div className="choices">
          {workflowIds.map((id) => (
            <button key={id} disabled={!active} onClick={() => start(id)}>
              {workflows[id].name}
            </button>
          ))}
        </div>
      )}
      <small>Goals are matched locally. You click each step.</small>
      {g && task && (
        <div className="guide-progress" aria-live="polite">
          <span className="eyebrow">
            STEP {g.step} OF 3 · {workflows[g.workflow].name}
          </span>
          <strong data-testid="task-state">
            {task.state === 'completed'
              ? 'Completed'
              : task.state === 'showing_step'
                ? 'Showing highlight'
                : task.state === 'inspecting'
                  ? 'Inspecting…'
                  : task.state === 'cancelled'
                    ? 'Cancelled'
                    : 'Paused'}
          </strong>
          {task.state === 'completed' && <p>{workflows[g.workflow].done}</p>}
          {task.state === 'showing_step' && f?.result === 'target' && (
            <>
              <p data-testid="instruction">{workflows[g.workflow].steps[f.step - 1]}</p>
              {f.ref && f.placement && (
                <Reveal
                  position={f.placement}
                  show={() => void send({ kind: 'reveal', ref: f.ref! })}
                />
              )}
            </>
          )}
          {task.state === 'paused' && (
            <p data-testid="recovery">
              {f?.result === 'unsupported'
                ? 'This task is supported only on the specified page. Start at ' +
                  workflows[g.workflow].start +
                  '.'
                : f?.result === 'missing'
                  ? 'I can’t find the next control on this page. Check the page, then resume or restart.'
                  : f?.result === 'duplicate'
                    ? 'More than one control matches. I paused rather than guessing.'
                    : f?.result === 'unexpected_link'
                      ? 'Paused: this link does not lead to the expected destination. Check its address below.'
                      : 'Guidance is paused. Resume to check the current page again.'}
            </p>
          )}
          {!task.cancelled && task.state !== 'completed' && (
            <div className="actions">
              <button
                disabled={!active}
                onClick={() => send({ kind: task.state === 'paused' ? 'resume' : 'pause' })}
              >
                {task.state === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button onClick={() => send({ kind: 'cancel' })}>Cancel task</button>
            </div>
          )}
          <button disabled={!active} onClick={() => start(g.workflow)}>
            Restart task
          </button>
          {(task.state === 'showing_step' ||
            (task.state === 'paused' && f?.result === 'unexpected_link')) &&
            f?.link && <AddressCard address={f.link} title="Suggested link" />}
        </div>
      )}
    </section>
  );
}
export function AddressInspector({ v, send }: { v: PanelView; send: Send }) {
  const [profile, setProfile] = useState<WorkflowId | ''>(''),
    [ref, setRef] = useState('');
  const snap = v.snapshot;
  const selected = snap?.controls.find((c) => c.ref === ref);
  return (
    <details>
      <summary>Check page and link addresses</summary>
      <label>
        Expected website
        <select value={profile} onChange={(e) => setProfile(e.target.value as WorkflowId | '')}>
          <option value="">Use the current site if recognized</option>
          {workflowIds.map((id) => (
            <option key={id} value={id}>
              {workflows[id].host}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!['temporary', 'site'].includes(v.access)}
        onClick={() =>
          send({
            kind: 'inspect',
            goal: 'Inspect page addresses',
            mode: 'guide',
            ...(profile ? { profile } : {}),
          })
        }
      >
        Inspect addresses
      </button>
      {v.task?.guide && <small>Inspecting addresses here switches to the page inspector.</small>}
      {snap?.address && <AddressCard title="Current page address" address={snap.address} />}
      {!!snap?.controls.length && (
        <label>
          Page link or control
          <select value={selected ? ref : ''} onChange={(e) => setRef(e.target.value)}>
            <option value="">Choose a control</option>
            {snap.controls.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected?.address && <AddressCard title="Selected destination" address={selected.address} />}
      {snap && (
        <small>
          Observed on this document at {new Date(snap.capturedAt).toLocaleTimeString()}.
        </small>
      )}
    </details>
  );
}
