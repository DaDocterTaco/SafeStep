import type { GuideFacts, Placement, WorkflowId } from '@safestep/contracts';
import { visible } from '../page/reader';
import { observeAddress } from './address';
import { citationView, expectedNavigation, workflows } from './profiles';
import { adapterFor } from './index';

type Local = Omit<GuideFacts, 'ref'> & { element: HTMLElement | null; href: string | null };
export function placement(el: HTMLElement): Placement {
  const b = el.getBoundingClientRect();
  return b.bottom <= 0
    ? 'above'
    : b.top >= innerHeight
      ? 'below'
      : b.right <= 0 || b.left >= innerWidth
        ? 'beside'
        : 'visible';
}
const name = (el: Element) => el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 96);
// Vector hides its painted duplicate label from accessibility APIs; the associated
// checkbox is the keyboard control. Permit only this exact pair on the supported article.
export function guideVisible(el: HTMLElement) {
  if (visible(el)) return true;
  if (
    location.origin !== 'https://en.wikipedia.org' ||
    location.pathname !== '/wiki/Phishing' ||
    !(el instanceof HTMLLabelElement) ||
    el.id !== 'vector-page-tools-dropdown-label' ||
    !(el.control instanceof HTMLInputElement) ||
    el.control.id !== 'vector-page-tools-dropdown-checkbox' ||
    el.control.type !== 'checkbox' ||
    el.control.getAttribute('role') !== 'button' ||
    el.control.getAttribute('aria-label') !== 'Tools' ||
    el.parentElement?.closest('[hidden],[inert],[aria-hidden="true"],[contenteditable]') ||
    el.querySelector('input,select,textarea,[contenteditable]')
  )
    return false;
  return (
    el.isConnected &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    el.getBoundingClientRect().width > 0 &&
    el.getBoundingClientRect().height > 0
  );
}
// Select narrowly within an inspected public landmark. Too many candidates means ambiguous, never pick the first match.
function candidates(selector: string, label: string, parent: ParentNode = document) {
  const els = parent.querySelectorAll<HTMLElement>(selector);
  return els.length > 40
    ? [null, null]
    : Array.from(els).filter(
        (el) => guideVisible(el) && name(el)?.toLowerCase() === label.toLowerCase(),
      );
}
export function observeWorkflow(workflow: WorkflowId): Local {
  const host = workflows[workflow].host,
    u = new URL(location.href);
  const fact = (step: number, result: GuideFacts['result']): Local => ({
    workflow,
    version: 1,
    step,
    result,
    element: null,
    placement: null,
    link: null,
    href: null,
  });
  const target = (
    step: number,
    els: (HTMLElement | null)[],
    route?: (u: URL) => boolean,
  ): Local => {
    if (els.length !== 1 || !els[0]) return fact(step, els.length ? 'duplicate' : 'missing');
    const el = els[0],
      a = el instanceof HTMLAnchorElement ? el : null;
    const link = a
      ? observeAddress(a.getAttribute('href'), document.baseURI, host, a.innerText)
      : null;
    const href = a?.href ?? null;
    if (
      a &&
      (!link?.allowed || link.flags.includes('label_mismatch') || !route || !route(new URL(a.href)))
    )
      return { ...fact(step, 'unexpected_link'), link, href };
    return { ...fact(step, 'target'), element: el, placement: placement(el), link, href };
  };
  if (adapterFor(u.origin, 'visual_guidance')?.id !== workflow || u.username || u.password)
    return fact(1, 'unsupported');
  if (workflow === 'wikipedia_cite_apa') {
    if (u.pathname === '/wiki/Phishing' && candidates('#firstHeading', 'Phishing').length === 1) {
      const landmarks = document.querySelectorAll('#p-tb');
      if (landmarks.length > 1) return fact(2, 'duplicate');
      const cites = landmarks[0] ? candidates('#t-cite a', 'Cite this page', landmarks[0]) : [];
      if (cites.length)
        return target(2, cites, (v) => citationView(v) && !v.searchParams.has('action'));
      const inputs = document.querySelectorAll<HTMLInputElement>(
        'input#vector-page-tools-dropdown-checkbox[type=checkbox][role=button]',
      );
      if (inputs.length !== 1) return fact(1, inputs.length ? 'duplicate' : 'missing');
      if (inputs[0]!.checked) return fact(2, 'missing');
      const labels = candidates(
        'label#vector-page-tools-dropdown-label[for="vector-page-tools-dropdown-checkbox"]',
        'Tools',
      );
      return target(1, labels);
    }
    if (
      citationView(u) &&
      !u.searchParams.has('action') &&
      candidates('h1#firstHeading', 'Cite This Page').length === 1
    ) {
      const article = candidates('main h2', 'Citation styles for "Phishing"');
      if (article.length !== 1) return fact(3, article.length ? 'duplicate' : 'missing');
      const sections = candidates('h3#APA_style', 'APA style');
      if (sections.length !== 1 || !sections[0])
        return fact(3, sections.length ? 'duplicate' : 'missing');
      if (u.hash === '#APA_style' && placement(sections[0]) === 'visible')
        return fact(3, 'complete');
      return target(
        3,
        candidates('main a[href$="#APA_style"]', 'APA'),
        (v) => v.pathname === u.pathname && v.search === u.search && v.hash === '#APA_style',
      );
    }
  } else {
    if (u.pathname === '/') {
      const toggles = candidates('#main-navbar a.dropdown-toggle[role=button]', 'VLC');
      if (toggles.length !== 1 || !toggles[0])
        return fact(1, toggles.length ? 'duplicate' : 'missing');
      const toggle = toggles[0],
        menu = toggle.closest('li.dropdown');
      if (!menu) return fact(1, 'missing');
      const links = candidates('.dropdown-menu a', 'Download', menu);
      const valid = (v: URL) => v.pathname === '/vlc/' && !v.search && !v.hash;
      if (links.length || toggle.getAttribute('aria-expanded') === 'true')
        return target(2, links, valid);
      return target(1, [toggle], valid);
    }
    if (u.pathname === '/vlc/') {
      const headings = candidates('h1', 'Official Downloads of VLC media player');
      if (headings.length !== 1 || !headings[0])
        return fact(3, headings.length ? 'duplicate' : 'missing');
      const section = headings[0].closest('.container');
      return target(
        3,
        section ? candidates('.windows a', 'Windows', section) : [],
        (v) => expectedNavigation(workflow, 3, v.href) && !v.search && !v.hash,
      );
    }
    if (u.pathname === '/vlc/download-windows.html') {
      const headings = candidates('h1', 'VLC for Windows');
      return fact(
        3,
        headings.length === 1 ? 'complete' : headings.length ? 'duplicate' : 'missing',
      );
    }
  }
  return fact(1, 'unsupported');
}
export function sameObservation(a: Local, b: Local) {
  return (
    a.element === b.element &&
    a.result === b.result &&
    a.step === b.step &&
    a.href === b.href &&
    a.placement === b.placement &&
    JSON.stringify(a.link) === JSON.stringify(b.link)
  );
}
export function publicFacts(local: Local, ref: string | null): GuideFacts {
  const { element: _e, href: _h, ...facts } = local;
  return { ...facts, ref };
}
