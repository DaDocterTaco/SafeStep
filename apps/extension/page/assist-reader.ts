import {
  bounds,
  articleMatchesQuery,
  profileForPage,
  publicPath,
  publicSearchQuery,
  safeLabel,
  samePublicTitle,
  type AssistSnapshot,
  type PublicRef,
  type AssistAction,
  wikiCitationSubject,
  wikiCurrentSection,
} from '@safestep/contracts';
import { wikipediaControl, wikipediaForm } from './public-search';
import {catalogSearchForm,catalogReadings,pilotControl,pilotCompletion,wikiAmbiguity} from './site-capabilities';
export const privateRegion =
  'form,input,textarea,select,[contenteditable]:not([contenteditable=false]),[hidden],[inert],[aria-hidden=true],iframe,script,style,pre,code[class*=interactive],template,[data-safestep-outline],[data-safestep-clean],[role=alert],[role=alertdialog],[role=dialog],[aria-modal=true],[data-private],[data-account],[data-personal],[data-shopping-evidence],[aria-label*=Sponsored i],aside[aria-label=Advertisement i],[data-ad-region],[aria-label*="signed in" i],[aria-label*="account menu" i],[aria-label*="order history" i],[aria-label*=payment i],[aria-label*=checkout i]';
const risky =
  /\b(save|submit|buy|checkout|pay|subscribe|log ?in|sign ?in|log ?out|delete|upload|download|consent|accept cookies|reject cookies|vote|send message|run code)\b/i;
export function labelOf(el: HTMLElement) {
  if (el.closest(privateRegion)) return '';
  let s = el.getAttribute('aria-label') ?? '';
  if (!s && el.hasAttribute('aria-labelledby')) {
    const ids = el.getAttribute('aria-labelledby')!.trim().split(/\s+/);
    if (ids.length <= 3) {
      const labels = ids.map((id) => document.getElementById(id));
      if (
        labels.every(
          (item) =>
            item &&
            item.matches('h1,h2,h3,h4,span,label') &&
            !item.closest(privateRegion) &&
            item.checkVisibility({ checkVisibilityCSS: true }),
        )
      ) {
        s = labels.map((item) => publicText(item!)).join(' ');
      }
    }
  }
  if (!s) s = publicText(el);
  s = s
    .replace(/[¶#]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return s && safeLabel(s) ? s : '';
}
function publicText(el: HTMLElement) {
  let s = '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(), i = 0; n && i++ < 36 && s.length < 100; n = w.nextNode())
    if (
      !n.parentElement?.closest(privateRegion) &&
      n.parentElement?.checkVisibility({ checkVisibilityCSS: true })
    )
      s += ' ' + (n.nodeValue ?? '').slice(0, 100 - s.length);
  return s;
}
export function walkPublic(root: Element, limit: number, visit: (e: HTMLElement) => void) {
  let el: Element | null = root,
    n = 0;
  const stack: Element[] = [];
  while (el && n++ < limit) {
    const e: Element = el,
      next: Element | null = e === root ? null : e.nextElementSibling;
    if (
      e instanceof HTMLElement &&
      !e.matches(privateRegion) &&
      (e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        getComputedStyle(e).display === 'contents')
    ) {
      visit(e);
      if (e.firstElementChild) {
        if (next) stack.push(next);
        el = e.firstElementChild;
        continue;
      }
    }
    el = next ?? stack.pop() ?? null;
  }
  return { visited: Math.min(n, limit), limited: !!el };
}
export function inViewport(e: HTMLElement) {
  const r = e.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.top < innerHeight &&
    r.right > 0 &&
    r.left < innerWidth
  );
}
function observedControl(el: HTMLElement) {
  const profile = profileForPage(new URL(location.href));
  if (
    profile === 'wikipedia' &&
    el.matches(
      '#p-search form#searchform input[type=search][name=search], #p-search > a.search-toggle, main form#search input[type=search][name=search]',
    ) &&
    el.isConnected &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  ) {
    const search = wikipediaControl(el);
    if (search) return search;
  }
  if (
    !el.isConnected ||
    el.closest(privateRegion + ', [disabled],[aria-disabled=true i]') ||
    !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) ||
    !el.getBoundingClientRect().width
  )
    return null;
  const label = labelOf(el);
  if (!label) return null;
  const u = new URL(location.href);
  if (!publicPath(u, profile)) return null;
  const publisherLink =
    profile === 'publisher' &&
    el instanceof HTMLAnchorElement &&
    !!publicPath(new URL(el.href), profile);
  if (risky.test(label) && !(publisherLink && !risky.test(label.replace(/\bdownload\b/gi, ''))))
    return null;
  if (el.matches('h1,h2,h3,h4'))
    return { label, role: 'heading' as const, action: 'reveal_target' as const, path: null };
  if (el instanceof HTMLAnchorElement) {
    if (
      !el.hasAttribute('href') ||
      el.hasAttribute('download') ||
      el.hasAttribute('onclick') ||
      el.hasAttribute('ping') ||
      el.relList.contains('external') ||
      (el.target && el.target !== '_self') ||
      document.querySelector('base[target]:not([target="_self"])')
    )
      return null;
    const dest = new URL(el.href);
    if (dest.origin !== u.origin || dest.href === u.href) return null;
    const path = publicPath(dest, profile);
    if (!path) return null;
    return { label, role: 'link' as const, action: 'activate_readonly_link' as const, path };
  }
  if (
    el.matches('details > summary:first-of-type') &&
    el.parentElement?.tagName === 'DETAILS' &&
    !el.hasAttribute('onclick') &&
    !el.querySelector('a,button,input,form')
  )
    return {
      label,
      role: 'button' as const,
      action: 'toggle_known_navigation' as const,
      path: null,
      expanded: (el.parentElement as HTMLDetailsElement).open,
    };
  if (
    profile === 'practice' &&
    el instanceof HTMLButtonElement &&
    el.type === 'button' &&
    el.matches('[data-assist-menu="sections"]') &&
    u.pathname === '/assist-lab/docs'
  )
    return {
      label,
      role: 'button' as const,
      action: 'toggle_known_navigation' as const,
      path: null,
      expanded: el.getAttribute('aria-expanded') === 'true',
    };
  return null;
}
// Only a named public landmark or its own heading supplies context. Never
// summarize nearby free text or read input values. Context participates in
// the signature, so moving an otherwise identical control retires the ref.
function publicContext(el: HTMLElement) {
  for (let p = el.parentElement, i = 0; p && i < 16; p = p.parentElement, i++) {
    if (!p.matches('section,article,nav,main,[role=navigation],[role=main]')) continue;
    if (p.closest(privateRegion)) return;
    let heading: Element | undefined;
    for (let n = 0; n < Math.min(12, p.children.length); n++) {
      const h = p.children[n]!;
      if (h !== el && h.matches('h1,h2,h3,h4') && h.checkVisibility({ checkVisibilityCSS: true })) {
        heading = h;
        break;
      }
    }
    const label = (
      p.getAttribute('aria-label') || (heading instanceof HTMLElement ? labelOf(heading) : '')
    ).trim();
    if (label && safeLabel(label)) return label.slice(0, 64);
  }
}
function eligible(el: HTMLElement,goal='') {
  const control = pilotControl(el,goal) ?? observedControl(el);
  if (!control || control.role === 'search') return control;
  const context = publicContext(el);
  return context && context !== control.label ? { ...control, context } : control;
}
export type LocalRef = { el: HTMLElement; fact: PublicRef; signature: string; goal?:string };
export const signature = (el: HTMLElement,goal='') => {
  const e = eligible(el,goal);
  return e ? JSON.stringify(e) : null;
};
export function hit(el: HTMLElement) {
  const r = el.getBoundingClientRect(),
    l = Math.max(0, r.left),
    t = Math.max(0, r.top),
    w = Math.min(innerWidth, r.right) - l,
    h = Math.min(innerHeight, r.bottom) - t;
  if (w <= 0 || h <= 0 || getComputedStyle(el).pointerEvents === 'none') return false;
  return [
    [0.5, 0.5],
    [0.2, 0.6],
    [0.8, 0.4],
  ].some(([x, y]) => el.contains(document.elementFromPoint(l + w * x!, t + h * y!)));
}
function sectionId(e: HTMLElement) {
  const link = e.querySelector<HTMLAnchorElement>('a[href^="#"]'),
    named = link && document.getElementById(link.hash.slice(1));
  const item = e.id
    ? e
    : named?.contains(e)
      ? named
      : e.parentElement?.matches('section[id]')
        ? e.parentElement
        : null;
  return item && /^[a-z0-9_.-]+$/i.test(item.id) && document.getElementById(item.id) === item
    ? item.id
    : null;
}
export function revealSection(e: HTMLElement) {
  const id = sectionId(e);
  if (id) {
    const dest = new URL(location.href);
    dest.hash = id;
    if (publicPath(dest, profileForPage(dest)) && location.hash !== dest.hash)
      history.replaceState(history.state, '', dest.href);
  }
  e.scrollIntoView({ block: 'center', behavior: 'instant' });
}
function headingSection(goal: string, profile: AssistSnapshot['profile'], path: string) {
  const pos = goal.split(/\b(?:not|without|instead of|except)\b/i)[0]!.toLowerCase(),
    slug = path.split('#')[0]!;
  if (profile === 'mdn') {
    const method = /\b(?:array(?:\.prototype)?\.)?(map|filter)\b/.exec(pos)?.[1];
    if (
      method &&
      /\bexamples?\b/.test(pos) &&
      slug === '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/' + method
    )
      return { title: 'Array.prototype.' + method + '()', section: 'Examples' };
  }
  if (profile === 'python') {
    if (/virtual environment|venv/.test(pos) && slug === '/3/tutorial/venv.html')
      return {
        title: 'Virtual Environments and Packages',
        section: 'Creating Virtual Environments',
      };
    if (/exception/.test(pos) && slug === '/3/tutorial/errors.html')
      return { title: 'Errors and Exceptions', section: 'Handling Exceptions' };
  }
  if (profile === 'practice') {
    if (/\busername\b/.test(pos) && slug === '/settings-lab/username')
      return { title: 'Username settings', section: 'Username' };
    if (/\bexamples?\b/.test(pos) && slug === '/assist-lab/method')
      return { title: 'Practice method', section: 'Examples' };
  }
  return null;
}
function publicRoots(profile: AssistSnapshot['profile']) {
  const roots = [
    ...new Set(
      [
        ...(profile === 'wikipedia' ? [document.querySelector('#p-search[role=search]'),document.querySelector('#vector-page-tools-dropdown'),
          document.querySelector('#vector-page-tools'),document.querySelector('#vector-page-tools-pinned-container')] : []),
        document.querySelector('main, [role=main], .document'),
        document.querySelector(
          profile === 'wikipedia'
            ? '#vector-toc'
            : profile === 'experimental'||profile==='catalog'
              ? 'nav[aria-label="Primary" i],nav[aria-label="Main" i],nav[aria-label="Main navigation" i]'
              : 'nav[aria-label],aside,nav',
        ),
        ...(profile === 'publisher' ? [document.querySelector('#main-navbar'), document.body] : []),
      ].filter((e): e is Element => !!e),
    ),
  ];
  if (!roots.length) roots.push(document.body);
  if (!roots.length) throw Error('Public reading regions unavailable.');
  return roots;
}
// A heading's block can be much wider than its letters. Sample the rendered
// text itself so a visible patch of empty space does not establish completion.
function headingTextVisible(el: HTMLElement) {
  if (!inViewport(el)) return false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(), i = 0; n && i++ < 36; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest(privateRegion) || !/\p{L}/u.test(n.nodeValue ?? '')) continue;
    range.selectNodeContents(n);
    for (const rect of Array.from(range.getClientRects()).slice(0, 8)) {
      const left = Math.max(0, rect.left),
        right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top),
        bottom = Math.min(innerHeight, rect.bottom);
      if (right - left < 2 || bottom - top < 2) continue;
      for (const fraction of [0.5, 0.25, 0.75]) {
        const front = document.elementFromPoint(
          left + (right - left) * fraction,
          (top + bottom) / 2,
        );
        if (front && el.contains(front) && front.contains(parent)) return true;
      }
    }
  }
  return false;
}
function verifiedPublicHeading(goal: string, url: URL, profile: 'experimental' | 'wikipedia' | 'storefront') {
  const query = publicSearchQuery(goal);
  if (!query) return null;
  const normalize = (s: string) =>
    s
      .toLocaleLowerCase('en')
      .replace(/['’]s\b/g, '')
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter(
        (t) =>
          ![
            'of',
            'the',
            'and',
            'a',
            'an',
            'on',
            'in',
            'to',
            'for',
            's',
            'section',
            'article',
            'page',
            'wikipedia',
          ].includes(t),
      ) ?? [];
  const requested = normalize(query),
    h1s = document.getElementsByTagName('h1');
  if (!requested.length || h1s.length !== 1) return null;
  const title = h1s[0]!,
    text = labelOf(title),
    subject = normalize(text);
  if (!text || title.closest(privateRegion)) return null;
  let route: string;
  try {
    route = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
  } catch {
    return null;
  }
  const identity = normalize(route);
  const matches = (a: string[], b: string[]) =>
    a.length > 0 && b.length > 0 && a.every((t) => b.includes(t)) && b.every((t) => a.includes(t));
  // Require the observed H1 and an attributable article/route. A link label,
  // an arbitrary search result or the model's “done” cannot establish arrival.
  if (!matches(subject, identity) || !samePublicTitle(text, route)) return null;
  if (samePublicTitle(text, query) && headingTextVisible(title)) return text;
  if (profile === 'wikipedia' && !url.hash) return null;
  if (!url.hash || !subject.some((t) => requested.includes(t))) return null;
  let id: string;
  try {
    id = decodeURIComponent(url.hash.slice(1));
  } catch {
    return null;
  }
  const section = document.getElementById(id);
  if (!section || document.querySelectorAll('#' + CSS.escape(id)).length !== 1) return null;
  const heading = section.matches('h2,h3,h4') ? section : section.querySelector('h2,h3,h4');
  if (
    !(heading instanceof HTMLElement) ||
    heading.closest(privateRegion) ||
    !headingTextVisible(heading)
  )
    return null;
  const part = labelOf(heading),
    sectionWords = normalize(part);
  if (
    !sectionWords.length ||
    !sectionWords.some((t) => requested.includes(t)) ||
    !requested.every((t) => subject.includes(t) || sectionWords.includes(t))
  )
    return null;
  return (text + ' · ' + part).slice(0, 160);
}
export function scanAssist(goal: string, terms: string[] = [], previous?: Map<string, LocalRef>) {
  const url = new URL(location.href),
    profile = profileForPage(url),
    path = publicPath(url, profile);
  if (!path) throw Error('This page has no approved public navigation scope.');
  if (['experimental', 'wikipedia', 'publisher','catalog','storefront'].includes(profile)) {
    const sensitive = document.querySelectorAll('input[type=password],input[autocomplete^="cc-"]');
    if (
      sensitive.length > 16 ||
      Array.from(sensitive).some((e) =>
        e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      )
    )
      throw Error('Private sign-in or payment controls prevent reliable public inspection here.');
  }
  const registry = new Map<string, LocalRef>(),
    controls: PublicRef[] = [],
    headings: PublicRef[] = [];
  const roots = publicRoots(profile);
  const article = profile === 'wikipedia' ? publicSearchQuery(goal) : null;
  const signatures = new Map<string, number>();
  const seen = new Set<HTMLElement>(),
    query = terms.map((t) => t.toLowerCase());
  let budget = terms.length ? bounds.lookupScan : bounds.scan,
    limited = false,
    partialWalk = false,
    extra = 0;
  if (profile === 'wikipedia'||profile==='catalog') {
    const shape = profile==='catalog'?catalogSearchForm():wikipediaForm(),
      el = shape?.field,
      fact = el && (profile==='catalog'?pilotControl(el,goal):wikipediaControl(el));
    if (el && fact) {
      const sig = JSON.stringify(fact),
        old = previous && [...previous.values()].find((v) => v.el === el && v.signature === sig);
      const ref = { ...fact, ref: old?.fact.ref ?? crypto.randomUUID(), visible: inViewport(el) };
      controls.push(ref);
      registry.set(ref.ref, { el, fact: ref, signature: sig,goal });
      seen.add(el);
    }
  }
  if(profile==='wikipedia' && wikiCitationSubject(goal)){
    const targets=[document.getElementById('vector-page-tools-dropdown-checkbox'),
      ...document.querySelectorAll<HTMLElement>('#t-cite a[href],main h3#APA_style')];
    for(const el of targets){
      const f=el && eligible(el,goal);
      if(!el || !f || seen.has(el))continue;
      const sig=JSON.stringify(f),old=previous && [...previous.values()].find(v=>v.el===el&&v.signature===sig);
      const ref={...f,ref:old?.fact.ref??crypto.randomUUID(),visible:inViewport(el)};
      (f.role==='heading'?headings:controls).push(ref);registry.set(ref.ref,{el,fact:ref,signature:sig,goal});seen.add(el);
    }
  }
  if(profile==='catalog'){
    // A long catalog can put Show more beyond the generic scan. Reserve only
    // positively registered, currently eligible site controls for this goal.
    for(const el of [...document.querySelectorAll<HTMLElement>('main button,main a[href]')].slice(0,360)){
      const base=pilotControl(el,goal);
      if(!base || !['inspect_catalog_filter','load_catalog_results','handoff_storefront'].includes(base.action) ||
         controls.length>=12 || seen.has(el))continue;
      const f=eligible(el,goal);
      if(!f)continue;
      const sig=JSON.stringify(f),old=previous && [...previous.values()].find(v=>v.el===el&&v.signature===sig);
      const ref={...f,ref:old?.fact.ref??crypto.randomUUID(),visible:inViewport(el)};
      controls.push(ref);registry.set(ref.ref,{el,fact:ref,signature:sig,goal});seen.add(el);
    }
  }
  for (const root of roots) {
    const scan = walkPublic(root, budget, (e) => {
      if (seen.has(e) || !e.matches('a[href],button,summary,h1,h2,h3,h4,label#vector-page-tools-dropdown-label')) return;
      seen.add(e);
      const f = eligible(e,goal);
      if (!f) return;
      // Account for duplicates throughout the observed region, including controls
      // beyond the batch returned to the planner.
      const sig = JSON.stringify(f);
      signatures.set(sig, (signatures.get(sig) ?? 0) + 1);
      const heading = f.role === 'heading',
        target = heading ? headings : controls;
      const matching = query.some(
        (t) =>
          f.label.toLowerCase().includes(t) ||
          f.path?.toLowerCase().includes(t) ||
          ('context' in f && typeof f.context === 'string' && f.context.toLowerCase().includes(t)),
      );
      // Prioritize an observed exact article when many unrelated result links
      // fill the first batch. This never constructs a destination from a goal.
      if (
        !heading &&
        article &&
        !articleMatchesQuery(path,article) &&
        f.path &&
        articleMatchesQuery(f.path, article) &&
        target.length >= bounds.controls
      ) {
        const replace = target.findIndex(
          (c) =>
            c.action === 'activate_readonly_link' &&
            c.path &&
            !articleMatchesQuery(c.path, article),
        );
        if (replace >= 0) {
          registry.delete(target[replace]!.ref);
          target.splice(replace, 1);
          limited = true;
        }
      }
      if (heading && matching && target.length >= bounds.headings) {
        const replace = target.findIndex(
          (h, i) => i > 0 && !query.some((t) => h.label.toLowerCase().includes(t)),
        );
        if (replace >= 0) {
          registry.delete(target[replace]!.ref);
          target.splice(replace, 1);
          limited = true;
        }
      }
      if(!heading && f.action==='handoff_storefront' && target.length>=bounds.controls){
        const replace=target.findIndex(c=>c.action==='activate_readonly_link');
        if(replace>=0){registry.delete(target[replace]!.ref);target.splice(replace,1);limited=true;}
      }
      if (
        (heading && target.length >= bounds.headings) ||
        (!heading && target.length >= bounds.controls && (!matching || extra >= bounds.extra))
      ) {
        limited = true;
        return;
      }
      if (!heading && target.length >= bounds.controls) extra++;
      const prior =
        previous && [...previous.values()].find((r) => r.el === e && r.signature === sig);
      const fact = { ...f, ref: prior?.fact.ref ?? crypto.randomUUID(), visible: inViewport(e) };
      target.push(fact);
      registry.set(fact.ref, { el: e, fact, signature: sig,goal });
    });
    budget -= scan.visited;
    limited ||= scan.limited;
    partialWalk ||= scan.limited || (budget <= 0 && root !== roots.at(-1));
    if (budget <= 0) break;
  }
  // Named section verification is an observation, independent of a model's "done".
  const currentSection=profile==='wikipedia'?wikiCurrentSection(goal):null;
  if(currentSection) {
    const wanted=[...document.querySelectorAll<HTMLElement>('main h2, main h3')].slice(0,180)
      .filter(e=>samePublicTitle(labelOf(e),currentSection));
    const el=wanted.length===1?wanted[0]:undefined;
    if(el && !headings.some(h=>registry.get(h.ref)?.el===el)){
      const f=eligible(el,goal);
      if(f){
        if(headings.length>=bounds.headings)registry.delete(headings.pop()!.ref);
        const sig=JSON.stringify(f),prior=previous && [...previous.values()].find(v=>v.el===el&&v.signature===sig);
        const ref={...f,ref:prior?.fact.ref??crypto.randomUUID(),visible:inViewport(el)};
        headings.push(ref);registry.set(ref.ref,{el,fact:ref,signature:sig,goal});
      }
    }
  }
  const expected = headingSection(goal, profile, path);
  let complete: string | null = pilotCompletion(goal,url,headingTextVisible);
  const ambiguity=profile==='wikipedia'?wikiAmbiguity(goal,url):undefined;
  if (!complete && !ambiguity && (profile === 'wikipedia' || profile === 'experimental'||profile==='storefront') &&
    !(profile==='wikipedia' && (wikiCitationSubject(goal)||wikiCurrentSection(goal))))
    complete = verifiedPublicHeading(goal, url, profile);
  if (expected) {
    const main = roots[0]!;
    const hs: HTMLElement[] = [];
    walkPublic(main, bounds.lookupScan, (e) => {
      if (e.matches('h1,h2,h3') && hs.length < 150) hs.push(e);
    });
    const normal = (e: HTMLElement) =>
      labelOf(e)
        .replace(/^[\d.\s]+/, '')
        .trim();
    const h1 = hs.filter((e) => e.tagName === 'H1' && normal(e) === expected.title);
    const section = hs.filter((e) => e.tagName !== 'H1' && normal(e) === expected.section);
    const fragmentNeeded = profile === 'mdn' || profile === 'python';
    if (
      h1.length === 1 &&
      section.length === 1 &&
      headingTextVisible(section[0]!) &&
      (!fragmentNeeded || (sectionId(section[0]!) && url.hash === '#' + sectionId(section[0]!)))
    )
      complete = expected.title + ' · ' + expected.section;
    // Reserve a heading fact for a locally matched section beyond the normal heading cap.
    const e = section[0];
    if (
      e &&
      section.length === 1 &&
      h1.length === 1 &&
      !headings.some((h) => registry.get(h.ref)?.el === e)
    ) {
      if (headings.length === 12) {
        registry.delete(headings.pop()!.ref);
      }
      const f = eligible(e,goal);
      if (f) {
        const sig = JSON.stringify(f),
          old = previous && [...previous.values()].find((v) => v.el === e && v.signature === sig);
        const fact = { ...f, ref: old?.fact.ref ?? crypto.randomUUID(), visible: inViewport(e) };
        headings.push(fact);
        registry.set(fact.ref, { el: e, fact, signature: sig,goal });
      }
    }
  }
  for (const [id, v] of registry) if ((signatures.get(v.signature) ?? 1) > 1) registry.delete(id);
  return {
    snapshot: {
      profile,
      path,
      controls: controls.filter((v) => registry.has(v.ref)),
      headings: headings.filter((v) => registry.has(v.ref)),
      limited,
      complete,
        ...(profile==='catalog'?catalogReadings(goal):{}),
        ...(ambiguity?{ambiguity}:{}),
    } satisfies AssistSnapshot,
    registry,
    partialWalk,
    roots,
  };
}
export function requireUniqueTarget(local: LocalRef, scan: ReturnType<typeof scanAssist>) {
  if (scan.registry.get(local.fact.ref)?.el !== local.el)
    throw Error('The target changed or more than one control matches.');
  if (!scan.partialWalk) return;
  // Discovery counts all visited elements. For an otherwise truncated walk,
  // inspect only potential equivalents of this particular target in our
  // approved public landmarks. A still-incomplete proof cannot authorize it.
  const tags = local.fact.role === 'heading' ? ['h1', 'h2', 'h3', 'h4'] : [local.el.localName];
  const seen = new Set<Element>();
  let remaining = bounds.lookupScan;
  for (const root of scan.roots) {
    for (const tag of tags) {
      const elements = root.getElementsByTagName(tag);
      for (let i = 0; ; i++) {
        const el = elements.item(i);
        if (!el) break;
        if (remaining-- === 0)
          throw Error('Could not verify a unique target within the inspection limit.');
        if (seen.has(el)) continue;
        seen.add(el);
        if (el !== local.el && el instanceof HTMLElement && signature(el,local.goal) === local.signature)
          throw Error('More than one matching target.');
      }
    }
  }
  if (!seen.has(local.el)) throw Error('The target left the inspected region.');
}
export function validateTarget(
  local: LocalRef,
  action: AssistAction,
  registry: Map<string, LocalRef>,
  scroll = false,
) {
  const { el, fact } = local;
  if (action !== fact.action || signature(el,local.goal) !== local.signature)
    throw Error('The target changed. Inspect again.');
  if ([...registry.values()].filter((x) => x.signature === local.signature).length !== 1)
    throw Error('More than one matching target.');
  if (scroll && !inViewport(el)) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (signature(el,local.goal) !== local.signature || ((scroll || inViewport(el)) && !hit(el)))
    throw Error('The target is covered or unavailable.');
  return el;
}
