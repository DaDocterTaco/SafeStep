import type {
  Candidate,
  FileProfile,
  Observation,
  ReviewBinding,
  ReviewData,
  Selection,
  Signal,
  SourceCoverage,
} from '@safestep/contracts';
import { observeAddress } from '../sites/address';
import { products, fixturePage, packageMatches } from '../sites/downloads';
import { isWinSCP } from '@safestep/contracts';
import { profileFor, workflows } from '../sites/profiles';
import { placement } from '../sites/workflow';
import { clean, visible } from './reader';
import {cleanupMemory} from './cleanup-memory';
import { isPublishedAdWrapper } from './ad-wrapper';

const privateArea =
  'input,textarea,select,option,script,style,template,noscript,[contenteditable]:not([contenteditable="false"]),[hidden],[inert],[aria-hidden="true"]';
const controls = 'a[href],button,[role="button"],[role="link"]';
const warningDialog =
  'dialog[open],[role=alertdialog],[role=dialog],[aria-modal=true],[role=alert]';
const noteworthy =
  controls +
  ',h1,h2,h3,p,b,small,span,strong,td,th,#downloadDetails,[itemprop=aggregateRating],' +
  warningDialog;
function publicPage() {
  const elements: HTMLElement[] = [],
    text = new Map<HTMLElement, string>();
  let visited = 0,
    limited = false,
    frames = false;
  const root = document.body ?? document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.firstChild(); node;) {
    if (++visited > 1600) {
      limited = true;
      break;
    }
    const el = node instanceof HTMLElement ? node : null;
    const skip =
      !!el &&
      (el.matches(privateArea) ||
        el instanceof HTMLIFrameElement ||
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    if (el instanceof HTMLIFrameElement) frames = true;
    if (el && !skip) {
      elements.push(el);
      const fixed = el.childElementCount < 30 && getComputedStyle(el).position === 'fixed';
      if (el.matches(noteworthy) || fixed) text.set(el, '');
    } else if (node.nodeType === Node.TEXT_NODE) {
      const part = (node.nodeValue ?? '').slice(0, 400);
      for (let p = node.parentElement; p && p !== root; p = p.parentElement) {
        const old = text.get(p);
        if (old !== undefined && old.length < 400) text.set(p, (old + ' ' + part).slice(0, 400));
      }
    }
    if (!skip && walker.firstChild()) {
      node = walker.currentNode;
      continue;
    }
    while (!walker.nextSibling()) {
      if (!walker.parentNode() || walker.currentNode === root)
        return { elements, text, limited, frames };
    }
    node = walker.currentNode;
  }
  return { elements, text, limited, frames };
}
type Page = ReturnType<typeof publicPage>;
export function operable(link: HTMLAnchorElement) {
  if (link.closest('[inert],[disabled],[aria-disabled="true" i]')) return false;
  if (link.tabIndex >= 0) return true;
  if (getComputedStyle(link).pointerEvents === 'none') return false;
  const box = link.getBoundingClientRect();
  const left = Math.max(0, box.left),
    right = Math.min(innerWidth, box.right);
  const top = Math.max(0, box.top),
    bottom = Math.min(innerHeight, box.bottom);
  // An off-screen target will be checked again when the user asks to reveal it.
  if (right <= left || bottom <= top) return true;
  return link.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
}
const words = (page: Page, el: Element | null) =>
  el instanceof HTMLElement ? (page.text.get(el) ?? '').replace(/\s+/g, ' ').trim() : '';
const label = (p: Page, el: HTMLElement) =>
  clean(el.getAttribute('aria-label') ?? words(p, el), 96);
function isSponsored(el: HTMLElement, p: Page) {
  const preceding = el.previousElementSibling;
  return (
    !!el.closest('[aria-label="Advertisement" i],[aria-label="Sponsored" i],[aria-label="Ad" i]') ||
    /^(advertisement|sponsored)\b/i.test(el.getAttribute('aria-label') ?? '') ||
    (!!preceding?.matches('small,span,strong,b') &&
      /^(ad|advertisement|sponsored)$/i.test(words(p, preceding)))
  );
}
function sources(fixture: boolean, at: string, host: string): SourceCoverage[] {
  const variant = fixture ? new URL(location.href).searchParams.get('source') : null;
  return (['business_reviews', 'homepage_threat'] as const).map((kind) => {
    const sim =
      !!variant && ['match', 'clear', 'stale', 'wrong', 'zero', 'no-coverage'].includes(variant);
    const state: SourceCoverage['state'] = !sim
      ? 'unavailable'
      : variant === 'stale'
        ? 'stale'
        : variant === 'wrong'
          ? kind === 'business_reviews'
            ? 'wrong_business'
            : 'no_coverage'
          : variant === 'no-coverage'
            ? 'no_coverage'
            : kind === 'business_reviews'
              ? variant === 'zero'
                ? 'zero_reviews'
                : 'matched'
              : variant === 'match'
                ? 'matched'
                : 'no_match';
    return {
      kind,
      source: sim ? 'labelled_fixture' : 'unavailable',
      state,
      subject: kind === 'homepage_threat' ? 'https://' + host + '/' : host,
      observedAt: at,
      expiresAt: sim
        ? new Date(Date.parse(at) + (state === 'stale' ? -60000 : 60000)).toISOString()
        : null,
    };
  });
}
type FileScan = {
  version: string;
  eligible: Set<HTMLElement>;
  primary: HTMLElement[];
  uncertain: boolean;
};
function winSCPScan(p: Page, id: FileProfile, result: FileScan) {
  const heading = p.elements.filter(e => /^H[12]$/.test(e.tagName) &&
    /^(?:Download latest WinSCP \d+(?:\.\d+){1,3}|WinSCP \d+(?:\.\d+){1,3} Download)$/i.test(words(p,e)));
  if (heading.length !== 1) { result.uncertain = heading.length > 1; return; }
  result.version = words(p,heading[0]!).match(/\d+(?:\.\d+){1,3}/)![0];
  let inRelease = false, section = '';
  for (const e of p.elements) {
    if (e === heading[0]) { inRelease = true; continue; }
    if (/^H[12]$/.test(e.tagName)) inRelease = false;
    if (e.tagName === 'H3') section = words(p,e);
    if (!(e instanceof HTMLAnchorElement)) continue;
    const destination = new URL(e.href);
    if (destination.origin !== 'https://winscp.net' || !destination.pathname.startsWith('/download/')) continue;
    result.primary.push(e);
    if (!inRelease) continue;
    const name = label(p,e);
    const matches = id === 'winscp_portable'
      ? /^portable executables$/i.test(section) && /\bdownload\b/i.test(name) && /\bportable\b/i.test(name)
      : name.toLowerCase().startsWith('download winscp ' + result.version.toLowerCase()) &&
        /\bWinSCP\s+(\d+(?:\.\d+){1,3})\b/i.exec(name)?.[1] === result.version;
    if (matches) result.eligible.add(e);
  }
}
function winSCPHint(url: URL | null) {
  if (url?.origin !== 'https://winscp.net' || !url.pathname.startsWith('/download/')) return '';
  const name = url.pathname.split('/')[2] ?? '';
  if (/^(?:putty|pageant)/i.test(name)) return 'Separate PuTTY product';
  if (/experimental/i.test(name)) return 'Experimental build';
  if (/Automation\.zip$/i.test(name)) return 'Automation library';
  if (/Source\.zip$/i.test(name)) return 'Source code';
  if (/\.msi$/i.test(name)) return 'MSI installation package';
  if (/Portable\.zip$/i.test(name)) return 'Portable executables';
  if (/Setup\.exe$/i.test(name)) return 'Windows installer';
  return '';
}
function reachableFile(link: HTMLAnchorElement) {
  if (!operable(link) || getComputedStyle(link).pointerEvents === 'none') return false;
  const blocker = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  for (let p=blocker; p && p !== document.body; p=p.parentElement) {
    const box=p.getBoundingClientRect();
    if (!p.contains(link) && getComputedStyle(p).position==='fixed' && box.width>=innerWidth*0.85 && box.height>=innerHeight*0.85) return false;
  }
  const r=link.getBoundingClientRect(), x=(Math.max(r.left,0)+Math.min(r.right,innerWidth))/2,
    y=(Math.max(r.top,0)+Math.min(r.bottom,innerHeight))/2;
  return r.right<=0 || r.bottom<=0 || r.left>=innerWidth || r.top>=innerHeight || link.contains(document.elementFromPoint(x,y));
}
function fileScope(p: Page, id: FileProfile): FileScan {
  const result: FileScan = { version: '', eligible: new Set(), primary: [], uncertain: false };
  const heads = p.elements.filter((e) => e.tagName === 'H1');
  if (isWinSCP(id)) {
    winSCPScan(p, id, result);
  } else if (id === 'vlc_windows_x64') {
    if (heads.filter((h) => words(p, h) === 'VLC for Windows').length !== 1) return result;
    const details = p.elements.filter((e) => e.id === 'downloadDetails');
    const v =
      details.length === 1
        ? /\bVersion\s+(\d+(?:\.\d+){1,3})\s*[•·|]\s*Windows\s+(?:64\s*bit|x64)\b/i.exec(
            words(p, details[0]!),
          )
        : null;
    if (!v) return result;
    result.version = v[1]!;
    result.primary = p.elements.filter(
      (e) =>
        e.id === 'downloadButton2' &&
        e instanceof HTMLAnchorElement &&
        visible(e) &&
        label(p, e) === 'Download VLC',
    );
    result.primary.forEach((e) => result.eligible.add(e));
  } else {
    const hs = heads.filter((e) => words(p, e) === 'Download');
    if (hs.length !== 1) return result;
    const header = hs[0]!.nextElementSibling,
      table = header?.nextElementSibling;
    const versionHeading =
      /^Download 7-Zip (\d+\.\d+(?:\.\d+)?) (?:\([^)]{1,32}\) )?for Windows\s*:?$/i;
    const release = versionHeading.exec(words(p, header));
    if (!release || !(table instanceof HTMLTableElement) || !p.elements.includes(table))
      return result;
    result.version = release[1]!;
    const versionOrder = (a: string, b: string) => {
      const av = a.split('.').map(Number),
        bv = b.split('.').map(Number);
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        const diff = (av[i] ?? 0) - (bv[i] ?? 0);
        if (diff) return diff;
      }
      return 0;
    };
    if (
      p.elements.some(
        (e) =>
          e !== header &&
          e.tagName === 'P' &&
          e.parentElement === header?.parentElement &&
          versionHeading.test(words(p, e)) &&
          versionOrder(versionHeading.exec(words(p, e))![1]!, result.version) >= 0,
      )
    ) {
      result.uncertain = true;
      return result;
    }
    if (table.rows.length > 24) {
      result.uncertain = true;
      return result;
    }
    for (const row of Array.from(table.rows).slice(1)) {
      const cells = row.cells,
        a = cells[0]?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [];
      if (!cells[0] || !p.elements.includes(cells[0])) {
        result.uncertain = true;
        continue;
      }
      const matching =
        words(p, cells[1] ?? null) === '.exe' &&
        /^64-bit Windows x64$/i.test(words(p, cells[2] ?? null)) &&
        /^7-Zip installer for Windows$/i.test(words(p, cells[3] ?? null));
      for (const el of a) {
        if (!p.elements.includes(el) || !visible(el)) continue;
        result.primary.push(el);
        if (matching && label(p, el) === 'Download') result.eligible.add(el);
      }
    }
  }
  return result;
}
export function readReview(binding: ReviewBinding, selection: Selection) {
  const u = new URL(location.href),
    p = publicPage(),
    at = new Date().toISOString(),
    fixture = fixturePage(u, selection.kind);
  const profile =
    (selection.kind === 'website' ? selection.expected : undefined) ?? profileFor(u.origin);
  const expected = profile
    ? workflows[profile].host
    : u.origin === 'https://www.7-zip.org'
      ? 'www.7-zip.org'
      : null;
  const address = observeAddress(u.href, document.baseURI, expected);
  const observations: Observation[] = [],
    candidates: Candidate[] = [],
    refs = new Map<string, { element: HTMLElement; href: string | null }>();
  let limited = p.limited;
  const note = (code: Signal, detail = '') => {
    if (observations.some((o) => o.code === code && o.detail === detail)) return;
    if (observations.length >= 16) {
      limited = true;
      return;
    }
    observations.push({ id: 'e' + (observations.length + 1), code, detail: detail.slice(0, 160) });
  };
  note('host', address.host ?? '');
  if (address.scheme === 'http') note('http');
  for (const flag of address.flags)
    if (
      ['user_info', 'international', 'embedded_expected_domain', 'similar_spelling'].includes(flag)
    )
      note(flag as Signal);
  for (const el of p.elements) {
    if (el instanceof HTMLAnchorElement && visible(el)) {
      const a = observeAddress(el.getAttribute('href'), document.baseURI, expected, words(p, el));
      for (const code of [
        'label_mismatch',
        'user_info',
        'embedded_expected_domain',
        'similar_spelling',
      ] as const)
        if (a.flags.includes(code)) note(code, a.host ?? '');
    }
    if ((el.matches(controls) && isSponsored(el, p)) || isPublishedAdWrapper(el)) note('sponsored');
    if (el.matches('[itemprop=aggregateRating]')) note('self_claim');
    if (!p.text.has(el)) continue;
    if (el.matches(warningDialog) || getComputedStyle(el).position === 'fixed') {
      const str = words(p, el);
      if (
        /(?:device|computer|system).{0,25}(infected|compromised)|virus (?:found|detected)|immediate action required/i.test(
          str,
        ) &&
        /download|install|\bpay\b|\bcall\b|contact.{0,12}support/i.test(str)
      )
        note('urgent_dialog');
    }
  }
  const coverage = sources(fixture, at, address.host ?? '');
  const hidden=selection.kind==='website'?cleanupMemory():null;
  if(hidden){limited=true;for(const o of hidden.observations)if(o.code!=='host')note(o.code,o.detail);}
  let fileState: ReviewData['fileState'] = null,
    selected: string | null = null,
    pos: ReviewData['placement'] = null;
  if (selection.kind === 'download') {
    const id = selection.profile;
    const supported = isWinSCP(id) ? (u.href === 'https://winscp.net/eng/downloads.php' ||
      (id === 'winscp_windows_setup' && u.href === products[id].page) || (fixture && u.search === '?product=winscp' && !u.hash)) :
      (u.origin + u.pathname === products[id].page && !u.username && !u.password) || fixture;
    if (!supported) fileState = 'unsupported';
    else {
      const scan = fileScope(p, id);
      const others = p.elements.filter(
        (e) =>
          e.matches(controls) &&
          visible(e) &&
          (/download|installer|package/i.test(label(p, e)) || isSponsored(e, p)),
      );
      // Check every bounded current row for duplicates before limiting the alternatives
      // shown to the user. Linux/source packages must not crowd out the x64 EXE.
      const list = [
        ...new Set([
          ...scan.eligible,
          ...others.filter((e) => isSponsored(e, p)),
          ...scan.primary,
          ...others,
        ]),
      ];
      if (list.length > 12 || scan.uncertain) limited = true;
      for (const el of list.slice(0, 12)) {
        const anchor = el instanceof HTMLAnchorElement ? el : null,
          href = anchor?.getAttribute('href') ?? null;
        const a = observeAddress(href, document.baseURI, null, words(p, el)),
          sponsored = isSponsored(el, p);
        const eligible = scan.eligible.has(el);
        const unusable = eligible && !!anchor && !(isWinSCP(id) ? reachableFile(anchor) : operable(anchor));
        const allowed =
          !!anchor &&
          !!a.host &&
          eligible &&
          !unusable &&
          !sponsored &&
          !a.flags.includes('label_mismatch') &&
          packageMatches(id, new URL(anchor.href), scan.version);
        const relation: Candidate['relation'] = allowed
          ? 'publisher_link'
          : sponsored || eligible
            ? 'warning_pattern'
            : a.host
              ? 'other_option'
              : 'unknown';
        const reason: Signal = allowed
          ? isWinSCP(id) ? 'publisher_winscp' : id === 'vlc_windows_x64'
            ? 'publisher_vlc'
            : 'publisher_7zip'
          : sponsored
            ? 'sponsored'
            : unusable
              ? 'missing'
              : !a.host
                ? 'unknown_link'
                : eligible
                  ? 'wrong_destination'
                  : 'other_option';
        const row = el.closest('tr'),
          system = words(p, row?.cells[2] ?? null),
          format = words(p, row?.cells[1] ?? null);
        const architecture = /arm64/i.test(system)
          ? 'ARM64'
          : /x86|32-bit/i.test(system)
            ? 'x86'
            : /x64/i.test(system)
              ? 'x64'
              : '';
        const platform = /Windows/i.test(system)
          ? 'Windows'
          : /Linux/i.test(system)
            ? 'Linux'
            : /macOS/i.test(system)
              ? 'macOS'
              : '';
        const suffix = /^\.(?:exe|msi|7z|tar\.xz|zip)$/.test(format) ? format : '';
        const packageHint = allowed
          ? products[id].package + ' · ' + scan.version
          : isWinSCP(id) ? winSCPHint(anchor ? new URL(anchor.href) : null)
          : row
            ? [platform, architecture, suffix].filter(Boolean).join(' ')
            : '';
        const ref = crypto.randomUUID();
        refs.set(ref, { element: el, href: anchor?.href ?? null });
        candidates.push({
          ref,
          label: label(p, el) || 'Control',
          packageHint,
          publisherPath: allowed ? anchor!.pathname : null,
          address: a,
          relation,
          reason,
        });
      }
      const matches = candidates.filter((c) => c.relation === 'publisher_link');
      fileState = p.limited
        ? 'incomplete'
        : scan.uncertain || scan.eligible.size > 12
          ? 'ambiguous'
          : matches.length === 1
            ? 'identified'
            : matches.length > 1
              ? 'ambiguous'
              : 'missing';
      if (fileState === 'identified') {
        selected = matches[0]!.ref;
        pos = placement(refs.get(selected)!.element);
        note(matches[0]!.reason);
      } else
        note(
          fileState === 'incomplete'
            ? 'limited'
            : fileState === 'missing'
              ? 'missing'
              : 'duplicate',
        );
      for (const c of candidates) note(c.reason, c.address.host ?? '');
    }
  }
  if (limited || p.frames) note('limited');
  const localWarning = observations.some((o) =>
    [
      'user_info',
      'label_mismatch',
      'embedded_expected_domain',
      'similar_spelling',
      'urgent_dialog',
      'sponsored',
    ].includes(o.code),
  );
  const record = coverage[1]!;
  const threat =
    record.subject === 'https://' + address.host + '/' &&
    record.expiresAt &&
    Date.parse(record.expiresAt) > Date.parse(at)
      ? record.state
      : 'unavailable';
  const status: ReviewData['status'] =
    threat === 'matched'
      ? 'reported_threat'
      : localWarning
        ? 'warning_signs'
        : threat === 'no_match' && !limited && !p.frames
          ? 'no_known_warning_in_checked_sources'
          : 'limited_information';
  const data: ReviewData = {
    ...(hidden?{cleanup:{at:hidden.at,count:hidden.count}}:{}),
    binding,
    selection,
    at,
    fixture,
    address,
    limited,
    frames: p.frames,
    observations,
    sources: [coverage[0]!, coverage[1]!],
    status,
    fileState,
    candidates,
    selected,
    placement: pos,
  };
  return { data, refs };
}
