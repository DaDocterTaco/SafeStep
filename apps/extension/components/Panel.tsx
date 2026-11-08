import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { messages, wikiCitationSubject, type ChatAction, type FeatureId, type PanelView } from '@safestep/contracts';
import { usePanel } from './usePanel';
import {
  featureNames,
  activeManualStep,
  navigationCardStatesText,
  ResultCard,
  retainKeyboardFocus,
  type CardAction,
  type Send,
  type Turn,
} from './ChatCards';
import { AccessButton, SecondarySurface } from './ChatSettings';
import { CurrentSiteWarning, TargetProtection, useVisibleProtection } from './Protection';

const accessText: Record<PanelView['access'], string> = {
  temporary: 'Access for this visit',
  site: 'Site access enabled',
  permission_denied: 'Site access declined',
  permission_required: 'Access needed',
  permission_revoked: 'Access removed',
  unsupported_page: 'Unsupported page',
};
const sourceStatus = {
  checking: 'Checking protection',
  local: 'Address checked locally',
  private: 'Private page · outside lookup skipped',
  reports: 'Merchant reports found',
  limited: 'Limited source evidence',
  no_match: 'No matching reports in source',
  unavailable: 'Outside source unavailable',
  quota: 'Outside lookup limit reached',
};
function protectionText(v: PanelView) {
  const result = v.protection;
  if (result?.caution) return result.dismissed ? 'Warning dismissed' : 'Website warning';
  if(result && v.prefs.protection?.automaticUrlConsent===2){
    if(result.threatNotice) return result.threatNotice.startsWith('Checking Google')?'Checking public URL':'Limited URL coverage';
    if(result.threat?.status==='no_match')return result.threat.scope==='root'?'Homepage checked':'Page URL checked';
    if(result.threat)return 'Limited URL coverage';
  }
  if (result) return sourceStatus[result.status];
  if (!v.origin || v.access === 'unsupported_page') return 'Protection unavailable';
  return !v.prefs.protection || v.prefs.protection.scope === 'off'
    ? 'Auto protection off'
    : 'No current protection result';
}
type Suggestion = { feature: FeatureId; text: string };
function suggestions(v: PanelView): Suggestion[] {
  const host = v.origin ? new URL(v.origin).hostname : '';
  const route = v.snapshot?.context.route ?? '';
  const general: Suggestion = { feature: 'visual_guidance', text: 'Help me get somewhere' };
  const site: Suggestion = { feature: 'site_trust', text: 'Check this website' };
  const file: Suggestion = { feature: 'download_guidance', text: 'Find a download' };
  const seller: Suggestion = { feature: 'seller_assessment', text: 'Check this seller' };
  const product: Suggestion = { feature: 'product_assessment', text: 'Check this product' };
  const compare: Suggestion = { feature: 'shopping_alternatives', text: 'Compare alternatives' };
  if (
    v.shopping?.seller ||
    v.comparison?.baseline ||
    host.endsWith('.resell.store') ||
    ((host === 'localhost' || host === '127.0.0.1') && /shopping-lab|comparison-lab/.test(route))
  )
    return [seller, product, compare];
  if (host === 'addons.mozilla.org' || v.shopping?.product) return [product, compare, site];
  if (host === 'www.videolan.org' || host === 'www.7-zip.org' || host === 'winscp.net') return [file, site, general];
  if (host === 'en.wikipedia.org' && route.includes('Phishing'))
    return [{ feature: 'visual_guidance', text: 'Find an APA citation' }, site, general];
  if ((host === 'localhost' || host === '127.0.0.1') && route.includes('settings-lab'))
    return [
      { feature: 'visual_guidance', text: 'Find my username settings' },
      site,
      { feature: 'page_cleanup', text: 'Preview cleanup' },
    ];
  return [general, site, file];
}

function ActionDock({ v, send, active }: { v: PanelView; send: Send; active?: Turn }) {
  const t = v.task;
  const running = !!t && !['completed', 'failed', 'cancelled'].includes(t.state);
  const canRestore = !!(
    v.cleanup?.enabled ||
    v.cleanup?.hidden ||
    v.cue ||
    v.review?.selected
  );
  const outstanding = active?.state === 'routing' || active?.state === 'working';
  if (!running && !canRestore && !outstanding) return null;
  const control = (action: 'stop' | 'takeover' | 'pause' | 'resume') => {
    retainKeyboardFocus();
    if (action === 'stop' && outstanding && v.chat && (!t || t.id !== active?.taskId)) {
      void send({ kind: 'chat', action: { op: 'cancel', conversationId: v.chat.id } });
      return;
    }
    if (active && v.chat && t && t.id === active.taskId) {
      void send({
        kind: 'chat',
        action: { op: 'act', conversationId: v.chat.id, turnId: active.id, action },
      });
      return;
    }
    if (t?.adaptive) void send({ kind: 'assistControl', action });
    else if (t && action !== 'takeover') void send({ kind: action === 'stop' ? 'cancel' : action });
    else if (outstanding && v.chat)
      void send({ kind: 'chat', action: { op: 'cancel', conversationId: v.chat.id } });
  };
  return (
    <section className="action-dock" aria-label="Action controls">
      {running && t.state !== 'paused' && <button onClick={() => control('pause')}>Pause</button>}
      {running && t.state === 'paused' && !active?.taskId && (
        <button onClick={() => control('resume')}>Resume guide</button>
      )}
      {t?.adaptive?.authorized && <button onClick={() => control('takeover')}>Take over</button>}
      {(running || outstanding) && (
        <button className="stop" onClick={() => control('stop')}>
          Stop
        </button>
      )}
      {canRestore && <button onClick={() => void send({ kind: 'restore' })}>Restore page</button>}
    </section>
  );
}
function Workspace({ v: received, send, error }: { v: PanelView; send: Send; error: string }) {
  const v = { ...received, protection: useVisibleProtection(received.protection) };
  const [surface, setSurface] = useState<'Settings' | 'Help' | null>(null);
  const [draft, setDraft] = useState(''),
    [inputMessage, setInputMessage] = useState('');
  const [editId, setEditId] = useState<string | null>(null),
    [jump, setJump] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null),
    pinned = useRef(true);
  const record = v.chat,
    turns = record?.turns ?? [],
    active = turns.find((t) => !t.historical && t.id === record?.activeTurnId);
  const last = turns.at(-1),
    composing = useRef(false);
  const currentSite = v.origin ? new URL(v.origin).hostname : 'No accessible page';
  const pinnedWarning = v.protection?.caution && !v.protection.dismissed && v.protection.origin === v.origin;
  const canSubmit = !!draft.trim() && draft.length <= 240;
  const isPending = active?.state === 'routing';
  const sendChat = (action: ChatAction) => send({ kind: 'chat', action });
  const focusComposer = () => {
    const from = document.activeElement;
    requestAnimationFrame(() => {
      if (document.activeElement === from || document.activeElement === document.body)
        textarea.current?.focus({ preventScroll: true });
    });
  };
  function toggle(next: 'Settings' | 'Help', button: HTMLButtonElement) {
    trigger.current = button;
    if (surface === next) {
      close();
      return;
    }
    setSurface(next);
  }
  function close() {
    const opener = trigger.current;
    const closing = document.querySelector('.secondary');
    setSurface(null);
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        opener?.isConnected &&
        (!focused || focused === document.body || closing?.contains(focused))
      )
        opener.focus({ preventScroll: true });
    });
  }
  function shortcut(feature: FeatureId, text: string) {
    setSurface(null);
    setInputMessage('');
    setEditId(null);
    void sendChat({ op: 'shortcut', feature, text, conversationId: record?.id });
    focusComposer();
  }
  async function submit(raw = draft, replyTo?: string) {
    const text = raw.trim();
    if (!text || raw.length > 240) {
      setInputMessage(
        raw.length > 240
          ? 'Use 240 characters or fewer. Your text is still here.'
          : 'Enter a request.',
      );
      focusComposer();
      return;
    }
    setInputMessage('');
    setDraft('');
    setEditId(null);
    setSurface(null);
    const reply =
      replyTo ??
      (editId && active?.id === editId
        ? editId
        : active?.state === 'clarifying'
          ? active.id
          : undefined);
    await sendChat({
      op: 'submit',
      text,
      conversationId: record?.id,
      ...(reply ? { replyTo: reply } : {}),
    });
  }
  function clear() {
    void sendChat({ op: 'clear', conversationId: record?.id });
    setDraft('');
    setEditId(null);
    setInputMessage('');
    setSurface(null);
    focusComposer();
  }
  const previousContext = useRef(v.epoch + '|' + (v.origin ?? ''));
  useEffect(() => {
    const key = v.epoch + '|' + (v.origin ?? '');
    if (previousContext.current !== key) {
      setEditId(null);
      setInputMessage('');
      previousContext.current = key;
    }
  }, [v.origin, v.epoch]);
  const previousLast = useRef<string | null>(null);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    if (!last) {
      previousLast.current = null;
      pinned.current = true;
      setJump(false);
      return;
    }
    const update = last.id + '|' + last.state + '|' + last.text;
    if (previousLast.current === update) return;
    previousLast.current = update;
    if (!pinned.current) {
      setJump(true);
      return;
    }
    const el = viewport.querySelector<HTMLElement>('[data-turn="' + last.id + '"]');
    if (el)
      viewport.scrollTop +=
        el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 10;
  }, [last?.id, last?.state, last?.text]);
  function latest() {
    if (!scroll.current) return;
    const el = scroll.current.querySelector<HTMLElement>('[data-turn="' + last?.id + '"]');
    if (el) {
      scroll.current.scrollTop +=
        el.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 10;
      el.focus({ preventScroll: true });
    }
    pinned.current = true;
    setJump(false);
  }
  function doAct(turn: Turn, action: CardAction) {
    if (!record || turn.id !== record.activeTurnId || turn.historical) return;
    retainKeyboardFocus();
    void sendChat({ op: 'act', conversationId: record.id, turnId: turn.id, action });
  }
  const quick: Suggestion[] = active?.suggestions?.length
    ? active.suggestions.map((feature) => ({ feature, text: featureNames[feature] }))
    : suggestions(v);
  const shortcuts = (
    <div className="suggestions" aria-label="Suggested requests">
      {quick.slice(0, 3).map((s) => (
        <button
          key={s.feature}
          data-feature={s.feature}
          onClick={() => shortcut(s.feature, s.text)}
        >
          {s.text}
        </button>
      ))}
    </div>
  );
  return (
    <main
      className={'chat-shell' + (v.prefs.largeText ? ' large' : '')}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && surface) {
          e.preventDefault();
          close();
        }
      }}
    >
      <header className="chat-header">
        <div className="chat-top">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <h1>SafeStep</h1>
          <nav aria-label="Panel tools">
            {!surface && (v.access==='site'||v.access==='temporary') &&
              <button aria-label="Tuck panel" title="Tuck panel" onClick={()=>void send({kind:'tuck',taskId:v.task?.id??null})}>Tuck</button>}
            <button
              aria-expanded={surface === 'Help'}
              onClick={(e) => toggle('Help', e.currentTarget)}
            >
              Help
            </button>
            <button
              aria-expanded={surface === 'Settings'}
              onClick={(e) => toggle('Settings', e.currentTarget)}
            >
              Settings
            </button>
          </nav>
        </div>
        <div className="site-line">
          {!pinnedWarning && <strong>{currentSite}</strong>}
          <span className={'site-status' + (v.protection?.caution ? ' caution' : '')}>
            <i aria-hidden="true" />
            {protectionText(v)}
          </span>
        </div>
      </header>
      <CurrentSiteWarning v={v} send={send} />
      <TargetProtection v={v} send={send}/>
      {surface && (
        <SecondarySurface
          surface={surface}
          v={v}
          send={send}
          close={close}
          choose={shortcut}
          clear={clear}
        />
      )}
      <div className="transcript-frame" hidden={!!surface}>
        <div
          className="transcript"
          id="chat-transcript"
          ref={scroll}
          onScroll={() => {
            const el = scroll.current;
            if (el) {
              pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop < 36;
              if (pinned.current) setJump(false);
            }
          }}
          role="log"
          aria-label="Conversation"
          aria-live="off"
          tabIndex={0}
        >
          {!turns.length && (
            <div className="chat-welcome">
              <h2>Help on this page</h2>
            </div>
          )}
          {!turns.length && shortcuts}
          {turns.map((turn, index) => {
            const current = turn === active && !turn.historical && turn.origin === v.origin;
            const previous = turns[index - 1];
            const goalTurn = !!active && turns[index+1]?.id===active.id && turn.role==='user' && activeManualStep(v,active);
            const manual = current && activeManualStep(v,turn);
            const subject = goalTurn ? wikiCitationSubject(turn.text) : null;
            const edit = () => { setEditId(turn.id); setDraft(turn.original ?? ''); focusComposer(); };
            return (
              <div key={turn.id}>
                {previous &&
                  (turn.origin !== previous.origin ||
                    (turn.documentId &&
                      previous.documentId &&
                      turn.documentId !== previous.documentId)) && (
                    <p className="page-divider">
                      Page changed ·{' '}
                      {turn.origin ? new URL(turn.origin).hostname : 'Unavailable page'}
                    </p>
                  )}
                <article
                  data-turn={turn.id}
                  tabIndex={turn.id === last?.id ? -1 : undefined}
                  data-role={turn.role}
                  data-state={turn.state}
                  className={'turn ' + turn.role + (goalTurn ? ' compact-goal' : '')}
                >
                  <strong className={manual || goalTurn ? 'sr-only' : 'turn-speaker'}>
                    {turn.role === 'user' ? 'You' : 'SafeStep'}
                  </strong>
                  {turn.historical && (
                    <small className="history-label">Earlier on this page or task</small>
                  )}
                  {goalTurn ? <details><summary>{subject ? subject+' article and APA citation' : turn.text.replace(/[.!?]$/,'')}</summary>
                    <p>{turn.text}</p></details> : !manual && (!current || !navigationCardStatesText(v, turn)) &&
                    <p className="turn-text">{turn.text}</p>}
                  {current && (
                    <>
                      {(turn.state === 'unsupported' || turn.state === 'unavailable') && shortcuts}
                      {turn.state === 'awaiting_access' &&
                        (v.access === 'temporary' || v.access === 'site' ? (
                          <button onClick={() => doAct(turn, 'retry')}>
                            Continue this request
                          </button>
                        ) : (
                          <AccessButton v={v} send={send} />
                        ))}
                      {turn.state === 'clarifying' && (
                        <div className="card-buttons">
                          {turn.choices?.map((choice) => (
                            <button key={choice} onClick={() => void submit(choice, turn.id)}>
                              {choice}
                            </button>
                          ))}
                        </div>
                      )}
                      <ResultCard
                        v={v}
                        send={send}
                        turn={turn}
                        act={(action) => doAct(turn, action)}
                        edit={edit}
                      />
                      {turn.original && !manual && turn.state !== 'routing' && (
                        <button
                          className="edit-request"
                          onClick={() => {
                            setEditId(turn.id);
                            setDraft(turn.original ?? '');
                            focusComposer();
                          }}
                        >
                          Edit request
                        </button>
                      )}
                    </>
                  )}
                </article>
              </div>
            );
          })}
        </div>
        {jump && (
          <button className="jump-latest" aria-controls="chat-transcript" onClick={latest}>
            New messages · Jump to latest
          </button>
        )}
      </div>
      <ActionDock v={v} send={send} active={active} />
      <div className="composer-wrap">
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {!['temporary', 'site'].includes(v.access) && (
          <p className="composer-notice">
            {accessText[v.access]} ·{' '}
            {messages[v.access === 'unsupported_page' ? 'unsupported_page' : 'permission_required']}
          </p>
        )}
        {v.issue && (
          <p className="composer-notice" role="status">
            {messages[v.issue]}
          </p>
        )}
        <form
          aria-label="Request composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="chat-composer">Your request</label>
          <div className="composer-field">
            <textarea
              id="chat-composer"
              rows={2}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setInputMessage('');
              }}
              aria-invalid={draft.length > 240}
              aria-describedby={draft.length >= 216 ? 'chat-length' : undefined}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !composing.current &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button className="primary send" disabled={!canSubmit} type="submit">
              Send
            </button>
          </div>
          {draft.length >= 216 && (
            <small id="chat-length" className={draft.length > 240 ? 'input-error' : ''}>
              {draft.length}/240
              {draft.length > 240 ? ' · Shorten this request before sending.' : ''}
            </small>
          )}
          {inputMessage && (
            <p role="alert" className="input-error">
              {inputMessage}
            </p>
          )}
        </form>
        {isPending && (
          <p className="composer-notice">Routing this request. Sending a new one replaces it.</p>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {active && activeManualStep(v,active) && v.guideTarget ? v.guideTarget.sentence : active?.text}
      </span>
    </main>
  );
}
export function Panel() {
  const { view, error, command } = usePanel();
  if (!view)
    return (
      <main className="waiting">
        <h1>SafeStep</h1>
        <p role="status">{error || 'Connecting to this tab…'}</p>
      </main>
    );
  return <Workspace key={view.tabId} v={view} send={command} error={error} />;
}
