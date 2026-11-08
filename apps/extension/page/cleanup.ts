import { cueMutation } from './cue-owned';
import {
  CleanPage,
  parseWire,
  sameBinding,
  type CleanupView,
  type CleanAdviceInput,
  type ReviewBinding,
} from '@safestep/contracts';
import { Outline } from './overlay';
import { isPublishedAdWrapper } from './ad-wrapper';
import { readReview } from './review-reader';
import { rememberCleanup, resetCleanupMemory } from './cleanup-memory';
type Item = {
  id: string;
  el: HTMLElement;
  pair: HTMLElement | null;
  reason: 'advertisement' | 'promotion' | 'promo_pair';
  signal: CleanAdviceInput['candidates'][number]['signal'];
};
const protectedRegion =
  'article,form,nav,header,footer,[role~=navigation i],[role~=form i],[role~=banner i],[role~=contentinfo i],[contenteditable],[data-shopping-evidence],[id*=review i],[class*=review i],[id*=seller i],[id*=product i],[data-private],[role~=alert i],[role~=alertdialog i],[data-security],[data-consent],[aria-label*=consent i],[aria-label*=captcha i],[aria-label*="privacy choices" i],[aria-label*="cookie preferences" i],[aria-label*="security warning" i],[aria-label*=checkout i],[aria-label*=payment i],[role~=region i][aria-labelledby],[data-safestep-outline],[data-safestep-instruction],[data-safestep-dock]';
const mainRegion = 'main,[role~=main i]';
const essential = mainRegion + ',input,textarea,select,[data-safestep-warning],[data-protection-warning],[role=status],[aria-live=assertive],[data-comparison-subject],[data-selected-variant],' + protectedRegion;
function protect(e: HTMLElement, known = false) {
  const adWrapper = isPublishedAdWrapper(e);
  if (
    e === document.body ||
    e === document.documentElement ||
    e.contains(document.activeElement) ||
    Outline.protected(e) ||
    e.matches(essential) ||
    (!adWrapper && (e.matches('iframe') || e.querySelector('iframe'))) ||
    e.querySelector(essential + ',h1,h2,h3,section[aria-label]')
  )
    return true;
  if (
    e.closest(protectedRegion) ||
    (!adWrapper && e.closest(mainRegion) && e.querySelector('p,article,section,figure,table'))
  )
    return true;
  if (!known && e.closest('dialog,[role=dialog],[aria-modal=true]')) return true;
  const controls=e.querySelectorAll('button,a[href],[role=button],[role=link]');
  if(controls.length>20)return true;
  for(const el of controls){
    const text=[el.getAttribute('aria-label'),el.getAttribute('href'),el.textContent?.slice(0,160)].join(' ');
    if(/\b(?:accept|decline|reject|agree|consent|account|pay|buy|cart|checkout|save|submit|unsubscribe|remove|secure|warning|sign in|log in|review|seller|feedback|add to (?:bag|basket))\b/i.test(text))return true;
  }
  const label = [
    e.id,
    e.className,
    e.getAttribute('aria-label') ?? '',
    (e.innerText ?? '').slice(0, 300),
  ].join(' ');
  return /captcha|checkout|password|payment|consent|cookie preference|security warning|virus detected|seller feedback|product ratings|review evidence|privacy choices/i.test(
    label,
  );
}
export function installCleanup() {
  const token = crypto.randomUUID(),
    attr = 'data-safestep-clean',
    lock = 'data-safestep-clean-lock';
  let b: ReviewBinding | null = null,
    style: HTMLStyleElement | null = null,
    enabled = false,
    limited = false,
    uncertain = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let group = new Map<string, Item>(),
    held = new Map<string, Item>(),
    ignored = new WeakSet<HTMLElement>(),
    failed = 0;
  let selectedIds:Set<string>|undefined;
  const fixturePair = (el: HTMLElement) =>
    location.pathname === '/cleanup-lab' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) &&
    el.id === 'practice-offer' &&
    el.getAttribute('data-nonessential') === 'promotion';
  function signalFor(e:HTMLElement,pair:HTMLElement|null):Item['signal']|null{
    if(pair && fixturePair(e))return 'recognized_popup_pair';
    if(isPublishedAdWrapper(e))return 'publisher_ad_frame';
    const label=e.matches('aside,[role=complementary]')?(e.getAttribute('aria-label')??'').trim().toLowerCase():'';
    if(/^(?:advertisement|advertising)$/.test(label)||e.matches('[data-ad-region="advertisement"]'))return 'labelled_advertisement';
    if(/^(?:sponsored|sponsored content|sponsored links)$/.test(label))return 'labelled_sponsored';
    if(/^(?:promotion|promotional banner)$/.test(label))return 'labelled_promotion';
    return e.matches('[data-nonessential="banner"][role=complementary]')?'recognized_banner':null;
  }
  function scan() {
    limited = false;
    uncertain = false;
    const found = new Map<string, Item>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node: Node | null,
      i = 0;
    while ((node = walker.nextNode())) {
      if (++i > 1600 || found.size >= 30) {
        limited = true;
        break;
      }
      if (
        !(node instanceof HTMLElement) ||
        node.closest('[data-safestep-outline],[data-safestep-instruction],[data-safestep-dock],form,iframe,script,style')
      )
        continue;
      const e = node;
      if (groupHasHeld(e)) continue;
      const pair = fixturePair(e) ? document.getElementById('practice-backdrop') : null;
      const signal=signalFor(e,pair);
      const ad=signal==='labelled_advertisement'||signal==='labelled_sponsored'||signal==='publisher_ad_frame';
      if (!signal) {
        if (e.matches('dialog[open],[role=dialog],[aria-modal=true],ins.adsbygoogle[data-vignette-loaded],iframe[id^=google_vignette]') && e.checkVisibility())
          uncertain = true;
        continue;
      }
      if (Outline.protected(e) || e.contains(document.activeElement)) ignored.add(e);
      if (
        !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        protect(e, !!pair) ||
        (pair &&
          (!pair.matches('[data-promo-backdrop]') ||
            pair.childElementCount ||
            protect(pair, true))) ||
        ignored.has(e)
      )
        continue;
      const prev = [...group.values()].find((x) => x.el === e && x.signal===signal && x.pair===pair),
        id = prev?.id ?? crypto.randomUUID();
      found.set(id, {
        id,
        el: e,
        pair,
        reason: pair ? 'promo_pair' : ad ? 'advertisement' : 'promotion',
        signal,
      });
    }
    group = found;
  }
  function groupHasHeld(e: HTMLElement) {
    return [...held.values()].some((i) => i.el === e || i.pair === e);
  }
  function unhide(i: Item) {
    for (const e of [i.el, i.pair]) if (e?.getAttribute(attr) === token) e.removeAttribute(attr);
    if (i.pair && document.body.getAttribute(lock) === token) document.body.removeAttribute(lock);
    held.delete(i.id);
  }
  function hiddenAsGroup(i: Item) {
    if (
      !i.el.isConnected ||
      signalFor(i.el,i.pair)!==i.signal ||
      i.el.getAttribute(attr) !== token ||
      protect(i.el, !!i.pair) ||
      getComputedStyle(i.el).display !== 'none'
    )
      return false;
    const pair = i.pair;
    if (!pair) return true;
    if (
      !fixturePair(i.el) ||
      pair !== document.getElementById('practice-backdrop') ||
      !pair.isConnected ||
      !pair.matches('[data-promo-backdrop]') ||
      pair.childElementCount ||
      pair.getAttribute(attr) !== token ||
      protect(pair, true)
    )
      return false;
    const css = getComputedStyle(pair);
    if (
      css.display !== 'none' &&
      (css.position !== 'fixed' || css.visibility !== 'hidden' || css.pointerEvents !== 'none')
    )
      return false;
    const bodyStyle = getComputedStyle(document.body);
    return (
      ![bodyStyle.overflowX, bodyStyle.overflowY].some((v) => v === 'hidden' || v === 'clip') &&
      (!document.body.classList.contains('practice-promo-lock') ||
        document.body.getAttribute(lock) === token)
    );
  }
  function cleanup() {
    clearTimeout(timer);
    timer = undefined;
    for (const i of [...held.values()]) unhide(i);
    style?.remove();
    style = null;
    enabled = false;
    ignored = new WeakSet();
    failed = 0;
    group.clear();
    selectedIds=undefined;
    resetCleanupMemory();
  }
  function apply() {
    if (!b) return;
    for (const i of [...held.values()]) {
      if (!hiddenAsGroup(i)) {
        if (i.el.isConnected) {
          // A replacement backdrop must go through fresh recognition with the popup.
          if (!i.pair || i.pair === document.getElementById('practice-backdrop')) ignored.add(i.el);
          failed = Math.min(30, failed + 1);
        }
        unhide(i);
      }
    }
    if (!held.size) resetCleanupMemory();
    else rememberCleanup(null, held.size);
    scan();
    if (!group.size) return;
    const prior = readReview(b, { kind: 'website' }).data;
    if (!style) {
      style = document.createElement('style');
      style.textContent =
        '[' +
        attr +
        '="' +
        token +
        '"]{display:none!important}[data-promo-backdrop][' +
        attr +
        '="' +
        token +
        '"]{visibility:hidden!important;pointer-events:none!important}body.practice-promo-lock[' +
        lock +
        '="' +
        token +
        '"]{overflow:auto!important}';
      document.head.append(style);
    }
    for (const i of group.values()) {
      if(selectedIds && !selectedIds.has(i.id))continue;
      if (held.size >= 30 || i.el.hasAttribute(attr) || i.pair?.hasAttribute(attr)) continue;
      for (const e of [i.el, i.pair]) e?.setAttribute(attr, token);
      if (i.pair && document.body.classList.contains('practice-promo-lock'))
        document.body.setAttribute(lock, token);
      if (!hiddenAsGroup(i)) {
        ignored.add(i.el);
        failed = Math.min(30, failed + 1);
        unhide(i);
      } else held.set(i.id, i);
    }
    if (held.size) rememberCleanup(prior, held.size);
    scan();
  }
  function state(): CleanupView | null {
    return b
      ? {
          binding: b,
          items: [
            ...[...held.values()].map((i) => ({ id: i.id, reason: i.reason, signal:i.signal, hidden: true })),
            ...[...group.values()]
              .slice(0, 30 - held.size)
              .map((i) => ({ id: i.id, reason: i.reason, signal:i.signal, hidden: false })),
          ],
          hidden: held.size,
          failed,
          uncertain,
          limited: limited || group.size + held.size > 30,
          enabled,
        }
      : null;
  }
  function notify() {
    const view = state();
    if (b && view)
      void chrome.runtime
        .sendMessage({ channel: 'clean-notice', binding: b, view })
        .catch(() => {});
  }
  new MutationObserver((records) => {
    if (
      !enabled ||
      timer ||
      !records.some((r) => {
        if(cueMutation(r))return false;
        const e = r.target instanceof Element ? r.target : r.target.parentElement;
        if (r.attributeName === attr)
          return e instanceof HTMLElement && groupHasHeld(e) && e.getAttribute(attr) !== token;
        if (r.attributeName === lock)
          return (
            !![...held.values()].find((i) => i.pair) &&
            document.body.classList.contains('practice-promo-lock') &&
            document.body.getAttribute(lock) !== token
          );
        if (
          style &&
          !style.isConnected &&
          r.type === 'childList' &&
          [...r.removedNodes].includes(style)
        )
          return true;
        return (
          e &&
          !e.closest('[data-safestep-outline],[data-safestep-instruction],[data-safestep-dock],style,input,textarea') &&
          !(
            r.type === 'childList' &&
            [...r.addedNodes, ...r.removedNodes].every(
              (n) =>
                n === style ||
                (n instanceof HTMLElement && n.matches('[data-safestep-outline],[data-safestep-instruction],[data-safestep-dock],style')),
            )
          )
        );
      })
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      if (enabled) {
        apply();
        notify();
      }
    }, 500);
  }).observe(document, { subtree: true, childList: true, attributes: true });
  window.addEventListener('pagehide', () => {
    cleanup();
    b = null;
  });
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js'))
    )
      return;
    const r = parseWire(CleanPage, raw);
    if (!r) return;
    let view: CleanupView | null = null;
    if (
      r.binding.origin === location.origin &&
      (r.cmd === 'preview' || (b && sameBinding(b, r.binding)))
    ) {
      if (r.cmd === 'preview') {
        b = r.binding;
        scan();
      } else if (r.cmd === 'apply') {
        if(r.ids){
          scan();
          if(new Set(r.ids).size!==r.ids.length || r.ids.some(id=>!group.has(id))){
            send({channel:'clean-result',binding:r.binding,requestId:r.requestId,view:null});return;
          }
        }
        selectedIds=r.ids?new Set(r.ids):undefined;
        enabled = true;
        apply();
      } else if (r.cmd === 'restore') {
        cleanup();
        scan();
      } else {
        const i = held.get(r.id!);
        if (i) {
          ignored.add(i.el);
          unhide(i);
          if (!held.size) resetCleanupMemory();
          else rememberCleanup(null, held.size);
          scan();
        }
      }
      view = state();
    }
    send({ channel: 'clean-result', binding: r.binding, requestId: r.requestId, view });
  });
}
