import type { PageSnapshot } from '@safestep/contracts';
import { observeAddress } from '../sites/address';

const selector = 'a[href],button,[role="button"],[role="link"]';
const privateArea =
  'input,select,textarea,option,script,style,template,noscript,[contenteditable]:not([contenteditable="false"]),[hidden],[inert],[aria-hidden="true"]';
export function visible(el: HTMLElement) {
  if (
    !el.isConnected ||
    el.closest(privateArea) ||
    el.querySelector('input,textarea,select,[contenteditable]')
  )
    return false;
  return (
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    el.getBoundingClientRect().height > 0 &&
    el.getBoundingClientRect().width > 0
  );
}
// Unknown path segments can be account IDs, invite codes or bearer tokens. Describe only
// recognizable static route words. The browser's document/entry IDs track actual navigation.
const routeWords = new Set(
  'account settings help support profile home privacy security download downloads next preferences'.split(
    ' ',
  ),
);
export function publicRoute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/').filter(Boolean)) {
    if (!routeWords.has(part) || parts.length >= 6) {
      parts.push('…');
      break;
    }
    parts.push(part);
  }
  return '/' + parts.join('/');
}
export function clean(text: string, limit: number) {
  return text
    .slice(0, 1024)
    .replace(
      /https?:\/\/[^\s]+|(?:^|(?<=\s))\/[^\s]*|(?:[^\s/@]+@)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#][^\s]*/gi,
      (value) => {
        try {
          const bare = !value.startsWith('/') && !/^https?:/i.test(value);
          const u = new URL(bare ? 'https://' + value : value, location.origin);
          return (
            (value.startsWith('/') && !value.startsWith('//') ? '' : bare ? u.host : u.origin) +
            publicRoute(u.pathname)
          );
        } catch {
          return '…';
        }
      },
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}
function localDestination(el: HTMLElement) {
  if (!(el instanceof HTMLAnchorElement)) return null;
  try {
    const u = new URL(el.href);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password
      ? (u.origin + publicRoute(u.pathname)).slice(0, 512)
      : null;
  } catch {
    return null;
  }
}
function publicLabel(el: HTMLElement) {
  // Only visible text nodes; never use form values, HTML, or accessibility references into private fields.
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria, 96);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let str = '',
    inspected = 0;
  for (let n = walker.nextNode(); n && str.length < 96 && inspected++ < 64; n = walker.nextNode()) {
    const p = n.parentElement;
    if (
      p &&
      !p.closest(privateArea) &&
      p.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    )
      str += ' ' + (n.nodeValue ?? '').slice(0, 96);
  }
  return clean(str, 96) || 'Unlabelled control';
}
export function metadata(el: HTMLElement) {
  return {
    kind: (el.matches('a[href],[role="link"]') ? 'link' : 'button') as 'link' | 'button',
    label: publicLabel(el),
    destination: localDestination(el),
  };
}
export const controlSelector = selector;
type References = Map<string, { element: HTMLElement; signature: string }>;
export function readControls(previous?: References, expected: string | null = null) {
  const refs: References = new Map();
  const predecessors = new Map(
    Array.from(previous ?? [], ([ref, t]) => [t.element, { ref, signature: t.signature }] as const),
  );
  const controls: PageSnapshot['controls'] = [];
  let visited = 0,
    limited = false,
    framesSkipped = false;
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        return (node as Element).matches(privateArea)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (++visited > 1600 || controls.length >= 32) {
      limited = true;
      break;
    }
    if (n instanceof HTMLIFrameElement) {
      framesSkipped = true;
      continue;
    }
    if (!(n instanceof HTMLElement) || !n.matches(selector) || !visible(n)) continue;
    const ref = crypto.randomUUID(),
      meta = metadata(n);
    const signature = JSON.stringify(meta),
      prior = predecessors.get(n);
    refs.set(ref, { element: n, signature });
    // Every inspection issues new actionable refs. Continuity is proof of the same DOM
    // object and metadata, never a guess based on a similar label or selector.
    controls.push({
      ref,
      ...meta,
      address: observeAddress(
        n instanceof HTMLAnchorElement ? n.getAttribute('href') : null,
        document.baseURI,
        expected,
        n.innerText.slice(0, 512),
      ),
      ...(prior?.signature === signature ? { previousRef: prior.ref } : {}),
    });
  }
  return { refs, controls, limited, framesSkipped };
}
