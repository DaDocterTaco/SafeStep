import { useRef, useState } from 'react';
import { cleanupDescriptions,cleanupScope, type FeatureId, type PanelView } from '@safestep/contracts';
import { resolveGoal, workflows } from '../sites/profiles';
import { AddressCard, AddressInspector, Reveal } from './Guidance';
import { Reviews } from './Reviews';
import { ShoppingCard } from './Shopping';
import { Comparison } from './Comparison';
import { AmazonSellerStatus, ThreatCoverage } from './Protection';
import { currentReview } from './Explain';
import { CleanupAdvice } from './CleanupAdvice';
import type { usePanel } from './usePanel';

export type Send = ReturnType<typeof usePanel>['command'];
export function retainKeyboardFocus() {
  if (document.activeElement?.matches('button:focus-visible')) {
    document.querySelector<HTMLTextAreaElement>('#chat-composer')?.focus({ preventScroll: true });
  }
}
export type Conversation = NonNullable<PanelView['chat']>;
export type Turn = Conversation['turns'][number];
export type CardAction =
  | 'guide'
  | 'automatic'
  | 'pause'
  | 'stop'
  | 'takeover'
  | 'resume'
  | 'restore'
  | 'apply'
  | 'reveal'
  | 'retry'
  | 'refreshEvidence'
  | 'dismissEvidence'
  | 'localDownload'
  | 'returnCatalog'
  | 'confirm';
export const featureNames: Record<FeatureId, string> = {
  visual_guidance: 'Guide me on this page',
  url_identity: 'Check this address',
  site_trust: 'Check this website',
  download_guidance: 'Find a download',
  seller_assessment: 'Check this seller',
  product_assessment: 'Check this product',
  automatic_navigation: 'Guide an automatic task',
  page_cleanup: 'Preview cleanup',
  shopping_alternatives: 'Compare alternatives',
};

export function NavigationCard({
  v,
  turn,
  act,
}: {
  v: PanelView;
  turn: Turn;
  act: (action: CardAction) => void;
}) {
  const task = v.task;
  const [approval, setApproval] = useState<string | null>(null);
  const start = useRef<HTMLButtonElement>(null);
  const mode = useRef<HTMLButtonElement>(null);
  const adaptive = task?.adaptive;
  const guide = task?.guide;
  const id = turn.id + '/' + (task?.id ?? '') + '/' + (adaptive?.version ?? 0);
  const origin = v.origin ? new URL(v.origin).hostname : 'this page';
  const preflight = turn.state === 'preview_ready' || turn.state === 'awaiting_user';
  const live = !!turn.taskId && task && turn.taskId === task.id;
  const fixed = resolveGoal(turn.original ?? '');
  const manualGuide = !adaptive && (fixed === 'wikipedia_cite_apa' || fixed === 'videolan_windows_page');
  const complete = live && ['completed', 'cancelled', 'failed'].includes(task.state);
  const instruction = live && guide ? v.snapshot?.guide : undefined;
  const paused = live && task.state === 'paused';
  const canChoose =
    !complete &&
    (preflight ||
      (live &&
        ['awaiting_confirmation', 'showing_step', 'paused', 'awaiting_user'].includes(task.state)));
  return (
    <section aria-label="Navigation action" className="action-card">
      <h3>{turn.feature === 'download_guidance' ? 'Download guidance' : 'Page guidance'}</h3>
      {live && (
        <p role="status" data-testid="assist-state">
          {adaptive?.status ?? task.state.replaceAll('_', ' ')}
        </p>
      )}
      {live && guide && instruction?.result === 'target' && (
        <p data-testid="instruction">{workflows[guide.workflow].steps[instruction.step - 1]}</p>
      )}
      {instruction?.ref && instruction.placement && (
        <Reveal position={instruction.placement} show={() => act('reveal')} />
      )}
      {live && guide && task.state === 'completed' && <p>{workflows[guide.workflow].done}</p>}
      {live && adaptive && adaptive.intent && (
        <dl className="card-facts">
          <dt>Requested</dt>
          <dd>{task.goal}</dd>
          {adaptive.intent.constraints.length > 0 && (
            <>
              <dt>Requirements</dt>
              <dd>{adaptive.intent.constraints.map((s) => s.text).join(', ')}</dd>
            </>
          )}
          {adaptive.intent.excluded.length > 0 && (
            <>
              <dt>Excluded</dt>
              <dd>{adaptive.intent.excluded.map((s) => s.text).join(', ')}</dd>
            </>
          )}
          {adaptive.searchQuery && (
            <>
              <dt>Public search</dt>
              <dd>{adaptive.searchQuery}</dd>
            </>
          )}
        </dl>
      )}
      {canChoose && (
        <div className="card-buttons">
          {live && adaptive?.status.startsWith('Confirm that') ? (
            <button onClick={() => act('confirm')}>Yes, this is it</button>
          ) : (
            (!live || task.state !== 'showing_step') && (
              <button onClick={() => act(paused ? 'resume' : 'guide')}>
                {paused ? 'Resume guide' : 'Show me'}
              </button>
            )
          )}
          {!adaptive?.authorized &&
            !guide &&
            !manualGuide &&
            (approval === id ? (
              <div className="approval">
                <p>
                  Allow SafeStep to follow verified public controls on <strong>{origin}</strong> for
                  this request?
                </p>
                <p>
                  {adaptive?.searchQuery ? 'The displayed search may be submitted. ' : ''}You can
                  stop at any time. You choose the final download.
                </p>
                <button
                  ref={start}
                  className="primary"
                  onClick={() => {
                    setApproval(null);
                    act('automatic');
                  }}
                >
                  Start automatic
                </button>
                <button
                  onClick={() => {
                    setApproval(null);
                    requestAnimationFrame(() => mode.current?.focus());
                  }}
                >
                  Back
                </button>
              </div>
            ) : (
              <button
                ref={mode}
                onClick={() => {
                  setApproval(id);
                  requestAnimationFrame(() => start.current?.focus());
                }}
              >
                Take me there
              </button>
            ))}
        </div>
      )}
      {live && adaptive && task.state === 'showing_step' && !adaptive.authorized && (
        <button onClick={() => act('reveal')}>Show this target</button>
      )}
      {live && adaptive?.returnUrl && task.state==='showing_step' && (
        <p>Earlier public results: {adaptive.returnUrl}<br/>
          <button onClick={()=>act('returnCatalog')}>Return to these results</button></p>
      )}
      {live &&
        adaptive?.download &&
        paused &&
        adaptive.calls > 0 &&
        !adaptive.status.startsWith('Goal edited.') && (
          <button onClick={() => act('localDownload')}>Use local publisher steps</button>
        )}
    </section>
  );
}

export function ResultCard({
  v,
  turn,
  send,
  act,
}: {
  v: PanelView;
  turn: Turn;
  send: Send;
  act: (action: CardAction) => void;
}) {
  if (turn.historical || v.chat?.activeTurnId !== turn.id || turn.origin !== v.origin) return null;
  const retainedAssessment =
    turn.operationId &&
    ((turn.feature === 'seller_assessment' &&
      v.shopping?.seller?.data.binding.operationId === turn.operationId) ||
      (turn.feature === 'product_assessment' &&
        v.shopping?.product?.data.binding.operationId === turn.operationId));
  if (
    turn.state === 'clarifying' ||
    turn.state === 'awaiting_access' ||
    (turn.state === 'unavailable' && !retainedAssessment) ||
    turn.state === 'unsupported' ||
    turn.state === 'error' ||
    turn.state === 'stale'
  )
    return null;
  const feature = turn.feature;
  const evidenceCommand: Send = (command) => {
    if (
      command.kind === 'review' ||
      command.kind === 'shop' ||
      command.kind === 'reviewDismiss' ||
      command.kind === 'shopDismiss'
    ) {
      const action =
        command.kind === 'reviewDismiss' || command.kind === 'shopDismiss'
          ? 'dismissEvidence'
          : 'refreshEvidence';
      retainKeyboardFocus();
      return send({
        kind: 'chat',
        action: { op: 'act', conversationId: v.chat!.id, turnId: turn.id, action },
      });
    }
    return send(command);
  };
  if (
    feature === 'visual_guidance' ||
    feature === 'automatic_navigation' ||
    feature === 'download_guidance'
  ) {
    if (turn.taskId && turn.taskId !== v.task?.id) return null;
    return (
      <>
        <NavigationCard v={v} turn={turn} act={act} />
        {feature === 'download_guidance' &&
          v.review?.selection.kind === 'download' &&
          (!turn.operationId || turn.operationId === v.review.binding.operationId) && (
            <Reviews v={v} send={evidenceCommand} resultOnly />
          )}
      </>
    );
  }
  if (feature === 'url_identity') return <AddressInspector v={v} send={send} />;
  if (
    feature === 'site_trust' &&
    v.review?.selection.kind === 'website' &&
    (!turn.operationId || turn.operationId === v.review.binding.operationId)
  )
    return <Reviews v={v} send={evidenceCommand} resultOnly />;
  if (feature === 'seller_assessment' || feature === 'product_assessment') {
    const kind = feature === 'seller_assessment' ? 'seller' : 'product';
    const result = v.shopping?.[kind];
    if (!result || (turn.operationId && result.data.binding.operationId !== turn.operationId))
      return kind === 'seller' ? <AmazonSellerStatus v={v} /> : null;
    return (
      <><ShoppingCard
        key={result.data.binding.operationId}
        view={result}
        send={evidenceCommand}
        dismiss={() => act('dismissEvidence')}
        request={turn.original}
        compare={()=>{
          void currentReview(result.data).then(current=>{if(current)return send({kind:'chat',action:{
            op:'shortcut',conversationId:v.chat!.id,feature:'shopping_alternatives',text:'Compare alternatives for this item',
          }});});
        }}
      />
      {result.data.inspectedUrl && result.data.binding.tabId===v.tabId &&
        <ThreatCoverage view={v} subject={result.data.inspectedUrl} documentId={result.data.binding.documentId}/>}</>
    );
  }
  if (
    feature === 'shopping_alternatives' &&
    v.comparison &&
    (!turn.operationId || turn.operationId === v.comparison.id)
  )
    return (
      <Comparison v={v} send={send} original={turn.original} initialMode={turn.comparisonMode} />
    );
  if (feature === 'page_cleanup' && v.cleanup) {
    const c = v.cleanup;
    const scope=cleanupScope(turn.original??'');
    return (
      <section aria-label="Page cleanup" className="action-card">
        <h3>Cleanup preview</h3>
        <p role="status">
          {c.items.length} recognized · {c.hidden} hidden
          {c.limited ? ' · inspection limit reached' : ''}
        </p>
        {c.uncertain && <p>An unrecognized dialog is still visible. Review its choices yourself.</p>}
        {!c.items.length && <p>No eligible distraction was found in the inspected regions.</p>}
        {!!c.failed && <p>{c.failed} regions could not stay hidden.</p>}
        {c.items.map((item) => (
          <p key={item.id}>
            {item.signal?cleanupDescriptions[item.signal]:item.reason.replaceAll('_', ' ')} · {item.hidden ? 'hidden' : scope.allowed.includes(item.reason)?'visible':'keep visible for this request'}
            {item.hidden && (
              <button
                onClick={() => void send({ kind: 'clean', action: 'restore_one', id: item.id })}
              >
                Restore item
              </button>
            )}
          </p>
        ))}
        {!c.enabled && c.items.length > 0 && (
          <CleanupAdvice key={c.binding.operationId+':'+c.items.map(i=>i.id).join(',')} preview={c} turnId={turn.id} goal={turn.original??''} applyAll={()=>act('apply')} send={send}/>
        )}
      </section>
    );
  }
  if (feature === 'site_trust' && v.snapshot?.address)
    return <AddressCard title="Website address" address={v.snapshot.address} />;
  return null;
}
