import {
  parseWire,
  ReviewPageRequest,
  sameBinding,
  type ReviewBinding,
  type ReviewPageReply,
} from '@safestep/contracts';
import { readReview } from './review-reader';
import { Outline } from './overlay';
import { placement } from '../sites/workflow';
type Read = ReturnType<typeof readReview>;
function signature(read: Read) {
  const d = read.data;
  return JSON.stringify([
    d.selection,
    d.address,
    d.status,
    d.limited,
    d.frames,
    d.fileState,
    d.observations,
    d.sources.map((s) => [s.kind, s.source, s.state, s.subject]),
    d.candidates.map((c) => [
      c.label,
      c.packageHint,
      c.publisherPath,
      c.address,
      c.reason,
      c.relation,
    ]),
  ]);
}
export function installReviewBridge() {
  let current: Read | undefined,
    sequence = -1,
    timer: ReturnType<typeof setTimeout> | undefined,
    expires: ReturnType<typeof setTimeout> | undefined;
  const outline = new Outline();
  function clear() {
    clearTimeout(timer);
    clearTimeout(expires);
    timer = undefined;
    current = undefined;
    outline.clear();
  }
  function changed() {
    const b = current?.data.binding;
    clear();
    if (b)
      void chrome.runtime.sendMessage({ channel: 'review-change', binding: b }).catch(() => {});
  }
  function valid(b: ReviewBinding) {
    return current && sameBinding(current.data.binding, b) && location.origin === b.origin;
  }
  function verify() {
    if (!current) return false;
    const next = readReview(current.data.binding, current.data.selection);
    if (signature(current) !== signature(next)) return false;
    const selected = current.data.selected,
      now = next.data.selected;
    if (selected && now) {
      const a = current.refs.get(selected),
        b = next.refs.get(now);
      return !!a && a.element === b?.element && a.href === b.href;
    }
    return selected === now;
  }
  const privateSelector =
    'input,select,textarea,[contenteditable],script,style,[data-safestep-outline]';
  new MutationObserver((records) => {
    if (!current) return;
    if (
      outline.host &&
      (!outline.host.isConnected ||
        !outline.host.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    ) {
      changed();
      return;
    }
    const changedRecords = records.filter((r) => {
      const el = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!el || el.closest(privateSelector)) return false;
      if (
        r.type === 'childList' &&
        [...r.addedNodes, ...r.removedNodes].every(
          (n) => n instanceof HTMLElement && n.hasAttribute('data-safestep-outline'),
        )
      )
        return false;
      return true;
    });
    if (!changedRecords.length) return;
    const selected = current.data.selected && current.refs.get(current.data.selected);
    if (
      selected &&
      (!selected.element.isConnected ||
        changedRecords.some((r) => r.target === selected.element && r.attributeName === 'href'))
    ) {
      changed();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (current && !verify()) changed();
    }, 90);
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
      'hidden',
      'style',
      'class',
      'id',
      'open',
      'inert',
      'aria-disabled',
      'disabled',
      'tabindex',
      'contenteditable',
    ],
  });
  const updatePlacement = () => {
    if (!current?.data.selected) return;
    const t = current.refs.get(current.data.selected);
    if (!t) return;
    const pos = placement(t.element);
    if (pos !== current.data.placement) {
      current.data.placement = pos;
      void chrome.runtime
        .sendMessage({ channel: 'review-change', binding: current.data.binding, placement: pos })
        .catch(() => {});
    }
  };
  window.addEventListener('scroll', updatePlacement, true);
  window.addEventListener('resize', updatePlacement);
  window.addEventListener('pagehide', changed);
  window.addEventListener('hashchange', changed);
  window.addEventListener('popstate', changed);
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js'))
    )
      return;
    const r = parseWire(ReviewPageRequest, raw);
    if (!r) return;
    const { binding: b, command: c } = r;
    const reply: ReviewPageReply = {
      channel: 'review-result',
      requestId: r.requestId,
      binding: b,
      ok: false,
      data: null,
    };
    try {
      if (location.origin !== b.origin || b.generation < sequence) throw Error();
      if (c.kind === 'close') {
        sequence = b.generation;
        clear();
      } else if (c.kind === 'read') {
        if (b.generation <= sequence) throw Error();
        sequence = b.generation;
        clear();
        current = readReview(b, c.selection);
        reply.data = current.data;
        const next = Math.min(
          ...current.data.sources.map((s) =>
            s.state !== 'stale' && s.expiresAt ? Date.parse(s.expiresAt) : Infinity,
          ),
        );
        if (Number.isFinite(next)) expires = setTimeout(changed, Math.max(0, next - Date.now()));
      } else if(c.kind==='hide'){
        if(!valid(b) || !current)throw Error();
        outline.clear();
        current.data.placement=null;
        reply.data=current.data;
      } else if (c.kind === 'verify') {
        if (!valid(b) || !current || !verify()) {
          if (valid(b)) changed();
          throw Error();
        }
        reply.data = current.data;
      } else {
        if (!valid(b) || !current || c.ref !== current.data.selected || !verify()) {
          if (valid(b)) changed();
          throw Error();
        }
        const target = current.refs.get(c.ref)!.element;
        if (c.scroll) {
          target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          if (!verify()) {
            changed();
            throw Error();
          }
        }
        outline.show(target);
        current.data.placement = placement(target);
        reply.data = current.data;
      }
      reply.ok = true;
    } catch {
      /* A new inspection is required. */
    }
    send(reply);
  });
}
