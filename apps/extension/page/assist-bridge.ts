import {
  AssistPage,
  bounds,
  parseWire,
  sameBinding,
  publicSearchQuery,
  publicStepInstruction,
  manualStepWords,
  profileForPage,
  catalogGoal,
  type AssistBinding,
  type AssistPageReply,
  type PublicRef,
} from '@safestep/contracts';
import {
  hit,
  inViewport,
  requireUniqueTarget,
  revealSection,
  scanAssist,
  signature,
  validateTarget,
  type LocalRef,
} from './assist-reader';
import { Outline } from './overlay';
import {cueMutation} from './cue-owned';
import { wikipediaForm, submitWikipediaSearch } from './public-search';
import {catalogSearchForm,catalogSearchPath} from './site-capabilities';
export function installAssistBridge() {
  const ring = new Outline(),
    spent = new Set<string>();
  let current: {
      b: AssistBinding;
      goal: string;
      terms: string[];
      registry: Map<string, LocalRef>;
      selected?: LocalRef;
      dispatched?: boolean;
      path: string;
    } | null = null,
    last = 0;
  let check: ReturnType<typeof setTimeout> | undefined;
  let manualListeners: AbortController | undefined;
  const close = () => {
    manualListeners?.abort();
    manualListeners = undefined;
    clearTimeout(check);
    check = undefined;
    current = null;
    ring.clear();
  };
  function note(event: 'changed' | 'user_target' | 'revealed') {
    if (current)
      void chrome.runtime
        .sendMessage({ channel: 'assist-notice', binding: current.b, event })
        .catch(() => {});
  }
  const invalidate = () => {
    note('changed');
    close();
  };
  function showManual(local:LocalRef, el:HTMLElement) {
    const context=current;
    if (!context) return;
    manualListeners?.abort();
    const listeners = new AbortController();
    manualListeners = listeners;
    const profile = profileForPage(new URL(location.href)) ?? '';
    const searching = local.fact.action === 'submit_public_search';
    const query = profile === 'catalog' ? catalogGoal(context.goal).query : publicSearchQuery(context.goal);
    const searchForm = () => profile === 'catalog' ? catalogSearchForm() : wikipediaForm();
    let composing=false, ready=false, visibility:'visible'|'offscreen'|'occluded'='visible', lastState='';
    const active = () => !listeners.signal.aborted && current===context && context.selected===local && !context.dispatched && el.isConnected;
    const publish = () => {
      if (!active()) return;
      const key = ready+'/'+visibility;
      if (key===lastState) return;
      lastState=key;
      void chrome.runtime.sendMessage({channel:'assist-notice',binding:context.b,event:'presentation',
        ref:local.fact.ref,ready,visibility}).catch(()=>{});
    };
    const read = () => {
      if (!active() || !searching) return;
      const form = searchForm();
      if (!form || form.field !== el || !query) { invalidate(); return; }
      ready = !composing && form.field.value.trim()===query;
    };
    read();
    if (!active()) return;
    ring.show(el, manualStepWords(local.fact,profile,context.goal,ready).cue, {onVisibility(value) {visibility=value;publish();}});
    publish();
    if (!searching) return;
    const refresh = () => {
      read();
      if (!active()) return;
      ring.updateInstruction(manualStepWords(local.fact,profile,context.goal,ready).cue);
      publish();
    };
    const opts = {signal:listeners.signal};
    el.addEventListener('input', refresh, opts);
    el.addEventListener('compositionstart', () => {composing=true;refresh();}, opts);
    el.addEventListener('compositionend', () => {composing=false;refresh();}, opts);
  }
  window.addEventListener(
    'click',
    (event) => {
      const selected = current?.selected;
      if (
        !event.isTrusted ||
        !current ||
        current.dispatched ||
        !selected ||
        !event.composedPath().includes(selected.el)
      )
        return;
      // Focusing a public search box is not a submission. Its separate
      // submit listener checks the exact form and approved query.
      if (selected.fact.action === 'submit_public_search') return;
      if (
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.defaultPrevented
      ) {
        invalidate();
        return;
      }
      try {
        const fresh = scanAssist(current.goal, current.terms, current.registry);
        if (fresh.snapshot.path !== current.path) throw Error('The page changed.');
        requireUniqueTarget(selected, fresh);
        validateTarget(selected, selected.fact.action, fresh.registry);
      } catch {
        invalidate();
        return;
      }
      // The page can replace the highlighted node during a trusted click
      // before Chrome reports its destination. The coordinator verifies the
      // selected destination and bounds the wait even when a click does nothing.
      if (
        selected.fact.action === 'activate_readonly_link' ||
        selected.fact.action === 'toggle_known_navigation' ||
        selected.fact.action === 'apply_catalog_filter' || selected.fact.action === 'handoff_storefront' ||
        selected.fact.action === 'handoff_catalog' || selected.fact.action === 'load_catalog_results' ||
        selected.fact.action === 'inspect_catalog_filter'
      )
        current.dispatched = true;
      note('user_target');
    },
    true,
  );
  window.addEventListener('pagehide', close);
  window.addEventListener(
    'submit',
    (event) => {
      if (current?.selected?.fact.action !== 'submit_public_search' || !event.isTrusted) return;
      const catalog=profileForPage(new URL(location.href))==='catalog';
      const form = catalog?catalogSearchForm():wikipediaForm();
      if (
        !form ||
        event.target !== form.form ||
        form.field.value.trim() !== (catalog?catalogGoal(current.goal).query:publicSearchQuery(current.goal))
      )
        invalidate();
      else {
        current.dispatched = true;
        note('user_target');
      }
    },
    true,
  );
  const observer = new MutationObserver((records) => {
    const target = current?.selected;
    if (!current || current.dispatched) return;
    if (records.every(cueMutation)) return;
    if (
      target &&
      (!target.el.isConnected ||
        signature(target.el,current.goal) !== target.signature ||
        !ring.host?.isConnected)
    ) {
      invalidate();
      return;
    }
    if (!check) {
      const context = current;
      check = setTimeout(() => {
        check = undefined;
        if (current !== context || context.dispatched) return;
        let fresh;
        try {
          fresh = scanAssist(context.goal, context.terms, context.registry);
          if (context.selected) requireUniqueTarget(context.selected, fresh);
        } catch {
          invalidate();
          return;
        }
        if (
          context.path !== fresh.snapshot.path ||
          (context.selected
            ? fresh.registry.get(context.selected.fact.ref)?.el !== context.selected.el
            : context.registry.size !== fresh.registry.size ||
              [...context.registry].some(([id, v]) => fresh.registry.get(id)?.el !== v.el)) ||
          (context.selected && inViewport(context.selected.el) && !hit(context.selected.el))
        )
          invalidate();
      }, bounds.changeDebounceMs);
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js'))
    )
      return;
    const r = parseWire(AssistPage, raw);
    if (!r) return;
    const { binding: b, cmd: c } = r,
      reply: AssistPageReply = {
        channel: 'assist-result',
        requestId: r.requestId,
        binding: b,
        ok: false,
        snapshot: null,
        error: null,
      };
    try {
      if (location.origin !== b.origin || b.generation < last)
        throw Error('Stale document or operation.');
      if (c.op === 'clear') {
        last = b.generation;
        close();
      } else if (c.op === 'inspect') {
        if (b.generation <= last) throw Error('Expired inspection.');
        const scan = scanAssist(c.goal, c.terms);
        last = b.generation;
        close();
        current = {
          b,
          goal: c.goal,
          terms: c.terms,
          registry: scan.registry,
          path: scan.snapshot.path,
        };
        reply.snapshot = scan.snapshot;
      } else {
        if (
          !current ||
          current.dispatched ||
          !sameBinding(b, current.b) ||
          b.windowId !== current.b.windowId ||
          b.goalVersion !== current.b.goalVersion
        )
          throw Error('Stale revision.');
        if (c.op === 'verify_snapshot') {
          // Read-only. Reuse references only while the exact same bound DOM
          // elements and signatures are still present. A visually identical
          // replacement gets a new reference and must be inspected anew.
          if (current.selected) throw Error('This inspection already selected a target.');
          const fresh = scanAssist(current.goal, current.terms, current.registry);
          if (fresh.snapshot.path !== current.path || fresh.registry.size !== current.registry.size ||
            [...current.registry].some(([ref, prior]) => fresh.registry.get(ref)?.el !== prior.el))
            throw Error('The controls changed during disclosure.');
          reply.snapshot = fresh.snapshot;
          reply.ok = true;
          send(reply);
          return;
        }
        const local = current.registry.get(c.ref);
        if (!local) throw Error('The target is unavailable.');
        const now = scanAssist(current.goal, current.terms, current.registry);
        if (
          current.path !== now.snapshot.path ||
          (current.selected?.fact.ref !== c.ref &&
            (current.registry.size !== now.registry.size ||
              [...current.registry].some(([ref, v]) => now.registry.get(ref)?.el !== v.el))) ||
          now.registry.get(c.ref)?.el !== local.el
        )
          throw Error('The page controls changed. Inspect again.');
        requireUniqueTarget(local, now);
        const e = validateTarget(local, c.action, now.registry, c.op === 'act' || c.scroll);
        if (c.op === 'act') {
          manualListeners?.abort();
          if (spent.has(c.actionId) || spent.size >= 64) throw Error('Action already claimed.');
          spent.add(c.actionId);
          current.selected = local;
          // Action-induced mutations and a section's own fragment are verified
          // by a new inspection. This snapshot can issue no further actions.
          current.dispatched = true;
          if (c.action === 'reveal_target') {
            revealSection(e);
            current.path = location.pathname + location.hash;
          } else if (c.action === 'submit_public_search') {
            if(profileForPage(new URL(location.href))==='catalog'){
              const path=catalogSearchPath(current.goal);
              if(!path || e!==catalogSearchForm()?.field || path!==local.fact.path)
                throw Error('The approved marketplace search changed.');
              location.assign(new URL(path,location.origin).href);
            }else{
              const query = publicSearchQuery(current.goal);
              if (!query) throw Error('Confirm the public search query first.');
              submitWikipediaSearch(e, query);
            }
          } else if(c.action==='identify_article_export'){
            throw Error('The current article export control is for the user to activate.');
          } else if(c.action==='handoff_storefront'||c.action==='handoff_catalog'){
            throw Error('A different storefront needs a fresh user choice and access.');
          } else if (
            c.action === 'activate_readonly_link' &&
            e instanceof HTMLAnchorElement &&
            ['wikipedia', 'experimental', 'publisher','catalog'].includes(
              profileForPage(new URL(location.href)),
            )
          ) {
            // Follow the freshly validated public href without invoking unknown page handlers.
            location.assign(e.href);
          } else if (e.localName === 'summary' && e.parentElement instanceof HTMLDetailsElement) {
            e.parentElement.open = !e.parentElement.open;
          } else e.click();
        } else {
          current.selected = local;
          if (c.scroll) {
            if (c.action === 'reveal_target') {
              current.dispatched = true;
              revealSection(e);
              current.path = location.pathname + location.hash;
            }
          }
          if (c.manual) showManual(local,e);
          else {
            manualListeners?.abort();
            ring.show(e, publicStepInstruction(local.fact));
          }
        }
      }
      reply.ok = true;
    } catch (e) {
      reply.error = e instanceof Error ? e.message.slice(0, 120) : 'Target unavailable.';
    }
    send(reply);
  });
}
