import {
  automaticThreatSubject,
  BridgeRequest,
  Fault,
  parseWire,
  type BridgeReply,
  type PageSnapshot,
} from '@safestep/contracts';
import { readControls, visible, metadata, controlSelector, clean, publicRoute } from './reader';
import { Outline } from './overlay';
import { observeAddress } from '../sites/address';
import { profileFor, workflows } from '../sites/profiles';
import {
  guideVisible,
  observeWorkflow,
  placement,
  publicFacts,
  sameObservation,
} from '../sites/workflow';

export function installBridge() {
  const outline = new Outline();
  const nav = (window as Window & { navigation?: EventTarget & { currentEntry?: { id: string } } })
    .navigation;
  const entry = () => nav?.currentEntry?.id ?? publicRoute(location.pathname);
  let generation = -1,
    snapshot: PageSnapshot | null = null,
    route = entry();
  let refs: ReturnType<typeof readControls>['refs'] = new Map();
  let guided: ReturnType<typeof observeWorkflow> | null = null,
    scheduled = 0;
  let manualCue: { ref: string; placement: ReturnType<typeof placement> } | null = null;
  function discard() {
    snapshot = null;
    guided = null;
    manualCue = null;
    refs.clear();
    outline.clear();
  }
  function invalidate(reason: 'page' | 'element_missing' = 'page') {
    const old = snapshot;
    discard();
    route = entry();
    if (old)
      void chrome.runtime
        .sendMessage({
          v: 2,
          channel: 'changed',
          tabId: old.context.tabId,
          documentId: old.context.documentId,
          revision: old.context.revision,
          epoch: generation,
          reason,
        })
        .catch(() => {});
  }
  function checkRoute() {
    if (entry() !== route) invalidate();
  }
  function verifyGuide() {
    if (!guided || !snapshot) return;
    const current = observeWorkflow(guided.workflow);
    if (!sameObservation(guided, current) || (outline.host && !outline.host.isConnected)) {
      invalidate();
      return;
    }
    if (current.placement && current.placement !== guided.placement && snapshot.guide?.ref) {
      guided = current;
      snapshot.guide.placement = current.placement;
      void chrome.runtime
        .sendMessage({
          v: 2,
          channel: 'changed',
          tabId: snapshot.context.tabId,
          documentId: snapshot.context.documentId,
          revision: snapshot.context.revision,
          epoch: generation,
          reason: 'placement',
          cue: { ref: snapshot.guide.ref, placement: current.placement },
        })
        .catch(() => {});
    }
  }
  function scheduleGuide() {
    if (scheduled || (!guided && !manualCue)) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      verifyGuide();
      if (manualCue && snapshot) {
        const t = refs.get(manualCue.ref);
        if (!t || !visible(t.element)) {
          invalidate('element_missing');
          return;
        }
        const pos = placement(t.element);
        if (pos !== manualCue.placement) {
          manualCue.placement = pos;
          void chrome.runtime
            .sendMessage({
              v: 2,
              channel: 'changed',
              tabId: snapshot.context.tabId,
              documentId: snapshot.context.documentId,
              revision: snapshot.context.revision,
              epoch: generation,
              reason: 'placement',
              cue: manualCue,
            })
            .catch(() => {});
        }
      }
    });
  }
  window.addEventListener('change', scheduleGuide, true);
  window.addEventListener('click', scheduleGuide, true);
  window.addEventListener('scroll', scheduleGuide, true);
  window.addEventListener('resize', scheduleGuide);
  const own = (n: Node) => n instanceof HTMLElement && n.hasAttribute('data-safestep-outline');
  const relevant = (n: Node) =>
    n instanceof Element &&
    (n.matches(controlSelector + ',base') || !!n.querySelector(controlSelector + ',base'));
  new MutationObserver((records) => {
    checkRoute();
    if (!snapshot) return;
    if (guided) {
      scheduleGuide();
      return;
    }
    if (outline.host && !outline.host.isConnected) {
      invalidate();
      return;
    }
    if ([...refs.values()].some(({ element }) => !element.isConnected)) {
      invalidate('element_missing');
      return;
    }
    if (
      records.some((r) => {
        if (own(r.target)) return false;
        const el = r.target instanceof Element ? r.target : r.target.parentElement;
        if (el?.matches('base')) return true;
        if (el?.closest(controlSelector)) return true;
        if (r.type === 'attributes') return !!el?.querySelector(controlSelector);
        return [...r.addedNodes, ...r.removedNodes].some((n) => !own(n) && relevant(n));
      })
    )
      invalidate();
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'href',
      'role',
      'aria-label',
      'aria-hidden',
      'aria-expanded',
      'checked',
      'for',
      'id',
      'hidden',
      'class',
      'style',
      'disabled',
      'inert',
      'contenteditable',
    ],
  });
  window.addEventListener('pagehide', () => {
    if (guided) discard();
    else invalidate();
  });
  window.addEventListener('popstate', checkRoute);
  window.addEventListener('hashchange', checkRoute);
  nav?.addEventListener('currententrychange', checkRoute);
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js'))
    )
      return;
    const r = parseWire(BridgeRequest, raw);
    if (!r) return;
    const reply: BridgeReply = {
      v: 2,
      channel: 'bridge',
      requestId: r.requestId,
      tabId: r.tabId,
      documentId: r.documentId,
      epoch: r.epoch,
      origin: r.origin,
      ok: false,
      error: null,
      snapshot: null,
    };
    try {
      checkRoute();
      if (location.origin !== r.origin || r.epoch < generation) throw new Fault('stale_document');
      const c = r.command;
      if (c.kind === 'fence') {
        generation = r.epoch;
        discard();
      } else if (c.kind === 'snapshot') {
        if (r.epoch === generation) throw new Fault('stale_document');
        const ctx = snapshot?.context;
        const wf = c.workflow,
          profile = wf ?? c.profile ?? profileFor(location.origin);
        const expected = profile ? workflows[profile].host : null;
        const local = wf ? observeWorkflow(wf) : null;
        const read = local
          ? { refs: new Map(), controls: [], limited: false, framesSkipped: false }
          : readControls(
              ctx &&
                ctx.documentId === r.documentId &&
                ctx.tabId === r.tabId &&
                ctx.revision === c.previousRevision
                ? refs
                : undefined,
              expected,
            );
        generation = r.epoch;
        discard();
        route = entry();
        refs = read.refs;
        guided = local;
        const ref = local?.element ? crypto.randomUUID() : null;
        if (local?.element && ref)
          refs.set(ref, {
            element: local.element,
            signature: JSON.stringify(metadata(local.element)),
          });
        snapshot = {
          context: {
            tabId: r.tabId,
            frameId: 0,
            documentId: r.documentId,
            revision: crypto.randomUUID(),
            origin: location.origin,
            route: publicRoute(location.pathname),
            access: c.access,
            capabilities: ['inspect', 'highlight', 'clear'],
          },
          title: clean(document.title, 160),
          capturedAt: new Date().toISOString(),
          address: observeAddress(location.href, document.baseURI, expected),
          ...(local ? { guide: publicFacts(local, ref) } : {}),
          controls: read.controls,
          limited: read.limited,
          framesSkipped: read.framesSkipped,
        };
        reply.snapshot = snapshot;
      } else {
        if (
          r.epoch !== generation ||
          !snapshot ||
          snapshot.context.revision !== c.revision ||
          snapshot.context.documentId !== r.documentId ||
          snapshot.context.tabId !== r.tabId
        )
          throw new Fault('stale_document');
        if (c.kind === 'clear') {
          outline.clear();
          manualCue = null;
        } else {
          const t = refs.get(c.ref);
          if (
            !t ||
            !(guided ? guideVisible(t.element) : visible(t.element)) ||
            JSON.stringify(metadata(t.element)) !== t.signature ||
            (guided && !sameObservation(guided, observeWorkflow(guided.workflow)))
          ) {
            invalidate('element_missing');
            throw new Fault('element_missing');
          }
          const link=t.element instanceof HTMLAnchorElement ? t.element : t.element.closest('a[href]');
          const href=link instanceof HTMLAnchorElement ? link.href : null;
          const eligible=href && automaticThreatSubject(href,'target');
          const destination=href===null?null:eligible && eligible.scope==='page'?eligible.url:'excluded';
          if(c.kind==='destination'){
            reply.controlDestination=destination;
            reply.ok=true;
            send(reply);
            return;
          }
          if(c.checkedDestination!==undefined && c.checkedDestination!==destination)throw new Fault('stale_document');
          if (c.kind === 'reveal')
            t.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          outline.show(t.element);
          reply.placement = placement(t.element);
          if (!guided) manualCue = { ref: c.ref, placement: reply.placement };
          scheduleGuide();
        }
      }
      reply.ok = true;
    } catch (e) {
      reply.error = e instanceof Fault ? e.code : 'blocked_by_policy';
    }
    send(reply);
  });
}
