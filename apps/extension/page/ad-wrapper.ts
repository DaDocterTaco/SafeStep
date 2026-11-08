const slotSelector = 'ins.adsbygoogle[data-ad-client][data-ad-slot]';
const adHost = /^(?:[\w-]+\.)*(?:googlesyndication\.com|doubleclick\.net)$/i;

// Read only attributes in the host document. A creative's cross-origin
// document, destination and reputation are unknown to SafeStep.
export function isPublishedAdWrapper(el: HTMLElement) {
  if (!el.matches('div.promo-block,aside[aria-label="Advertisement" i]')) return false;
  const slots = el.querySelectorAll(slotSelector);
  if (slots.length !== 1 || el.querySelectorAll('*').length > 100 ||
      el.querySelector('a[href],button,input,select,textarea,form,nav,article,h1,h2,h3,[contenteditable],[role=dialog],[aria-modal=true]')) return false;
  const slot = slots[0]!;
  if (slot.getAttribute('data-ad-status') === 'unfilled' ||
      !/^ca-pub-\d+$/.test(slot.getAttribute('data-ad-client') ?? '') ||
      !/^\d+$/.test(slot.getAttribute('data-ad-slot') ?? '')) return false;
  const label = el.querySelector('em,small');
  if (!/^advertisement$/i.test(label?.textContent?.trim() ?? el.getAttribute('aria-label') ?? '')) return false;
  // The only content outside the publisher's ad slot must be its label and
  // inert metadata. Never hide an unrelated descendant or a publisher link.
  for (const node of el.querySelectorAll('*')) {
    if (node === slot || slot.contains(node) || node.contains(slot) || node === label ||
        node.matches('script,style,noscript')) continue;
    if (node.textContent?.trim() || node.matches('iframe,img,video,object,embed')) return false;
  }
  const frames = [...el.querySelectorAll('iframe')];
  if (!frames.length || frames.length > 8) return false;
  return frames.every(frame => {
    if (!slot.contains(frame) || frame.getAttribute('title')?.trim().toLowerCase() !== 'advertisement') return false;
    if (frame.hasAttribute('srcdoc')) return /^(?:localhost|127\.0\.0\.1)$/.test(location.hostname) && location.pathname==='/download-lab';
    if (!URL.canParse(frame.src)) return false;
    const u = new URL(frame.src);
    return u.protocol === 'https:' && !u.username && !u.password && adHost.test(u.hostname);
  });
}
