import { cueMutation } from './cue-owned';
import {
  parseWire,
  ShopPageRequest,
  sameBinding,
  type ShoppingData,
  type ShoppingKind,
  type ReviewBinding,
} from '@safestep/contracts';
import { Outline } from './overlay';
import { readShopping, pageSignature, sourceTarget } from './shop-reader';
type Slot = {
  b: ReviewBinding;
  signature: string;
  abort: AbortController;
  data?: ShoppingData;
  element?: HTMLElement | null;
  timer?: ReturnType<typeof setTimeout>;
};
export function installShopBridge() {
  const slots = new Map<ShoppingKind, Slot>(),
    last = new Map<ShoppingKind, number>(),
    outline = new Outline();
  let painted: ShoppingKind | null = null,
    scheduled: ReturnType<typeof setTimeout> | undefined;
  function close(k: ShoppingKind, inform = false) {
    const s = slots.get(k);
    if (!s) return;
    slots.delete(k);
    s.abort.abort();
    clearTimeout(s.timer);
    if (painted === k) {
      outline.clear();
      painted = null;
    }
    if (inform)
      void chrome.runtime
        .sendMessage({ channel: 'shop-change', kind: k, binding: s.b })
        .catch(() => {});
  }
  function valid(k: ShoppingKind, s: Slot) {
    return (
      slots.get(k) === s &&
      location.origin === s.b.origin &&
      s.signature === pageSignature(k) &&
      (!s.data?.target || (s.element?.isConnected && s.element === sourceTarget(s.data))) &&
      (painted !== k || !!outline.host?.isConnected) &&
      (!s.data || Date.now() < Date.parse(s.data.captured) + 300000)
    );
  }
  const check = () => {
    for (const [k, s] of slots) if (!valid(k, s)) close(k, true);
  };
  new MutationObserver((records) => {
    records=records.filter(r=>!cueMutation(r));
    if(!records.length)return;
    for (const k of [...slots.keys()])
      if (
        records.some((r) => {
          const t = r.target instanceof Element ? r.target : r.target.parentElement;
          return (
            t?.closest('#shop-listing,#' + k + '-section') &&
            !t.closest('[data-safestep-outline],[data-safestep-instruction],[data-safestep-dock],input,textarea,script,style,[contenteditable]')
          );
        })
      )
        close(k, true);
    if (
      !slots.size ||
      scheduled ||
      !records.some((r) => {
        const t = r.target instanceof Element ? r.target : r.target.parentElement;
        return (
          t && !t.closest('[data-safestep-outline],[data-safestep-instruction],[data-safestep-dock],input,textarea,script,style,[contenteditable]')
        );
      })
    )
      return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      check();
    }, 65);
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  for (const event of ['pagehide', 'popstate', 'hashchange'])
    window.addEventListener(event, () => {
      for (const k of [...slots.keys()]) close(k, true);
    });
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js'))
    )
      return;
    const req = parseWire(ShopPageRequest, raw);
    if (!req) return;
    const { binding: b, kind: k, command: c } = req;
    void (async () => {
      let data: ShoppingData | null = null,
        ok = false;
      try {
        if (b.origin !== location.origin || b.generation < (last.get(k) ?? -1)) throw Error();
        const s = slots.get(k);
        if (c.op === 'close') {
          last.set(k, b.generation);
          close(k);
        } else if (c.op === 'read') {
          if (b.generation === (last.get(k) ?? -1)) throw Error();
          close(k);
          last.set(k, b.generation);
          const slot: Slot = { b, abort: new AbortController(), signature: pageSignature(k) };
          slots.set(k, slot);
          const result = await readShopping(
            b,
            k,
            AbortSignal.any([slot.abort.signal, AbortSignal.timeout(8500)]),
            async (subject) =>
              (await chrome.runtime.sendMessage({
                channel: 'shop-reserve',
                binding: b,
                kind: k,
                subject,
              })) === true,
          );
          if (!valid(k, slot)) {
            if (slots.get(k) === slot) close(k, true);
            throw Error();
          }
          slot.data = result;
          slot.element = result.target ? sourceTarget(result) : null;
          slot.timer = setTimeout(() => close(k, true), 300000);
          data = result;
        } else {
          if (!s?.data || !sameBinding(s.b, b) || !valid(k, s)) {
            if (s && sameBinding(s.b, b)) close(k, true);
            throw Error();
          }
          if (c.op === 'reveal') {
            if (c.ref !== s.data.target || !s.element) throw Error();
            s.element.scrollIntoView({ block: 'center', behavior: 'instant' });
            if (!valid(k, s)) throw Error();
            outline.show(s.element,k==='seller'?'Review the seller feedback link':'Review the product evidence link');
            painted = k;
          }
          data = s.data;
        }
        ok = true;
      } catch {
        /* caller must inspect again */
      }
      send({ channel: 'shop-result', requestId: req.requestId, binding: b, ok, data });
    })();
    return true;
  });
}
