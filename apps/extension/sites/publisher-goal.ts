import {
  privateText,
  isWinSCP,
  winSCPRequest,
  type AssistSnapshot,
  type FileProfile,
  type Intent,
  type Step,
} from '@safestep/contracts';
import { fixturePage, products } from './downloads';
import { resolveGoal } from './profiles';

type Choice =
  | { kind: 'clarify' | 'unsupported'; message: string; choices: FileProfile[] }
  | { kind: 'ready'; profile: FileProfile }
  | { kind: 'unrelated' };
const ids: FileProfile[] = ['vlc_windows_x64', 'seven_zip_windows_x64_exe'];
const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(vlc|videolan|7[ -]?zip)['’]s\b/g,'$1')
    .replace(/[‐‑–—]/g, '-');

export function publisherChoice(raw: string, origin: string | null, chosen?: FileProfile): Choice {
  if (resolveGoal(raw) === 'videolan_windows_page') return { kind: 'unrelated' };
  const words = normalize(raw);
  if (/\bwinscp\b/.test(words) || origin === 'https://winscp.net' || (chosen && isWinSCP(chosen))) {
    if (!/\b(?:download|installer|setup|portable|package|executables?)\b/.test(words)) return {kind:'unrelated'};
    const options: FileProfile[] = ['winscp_windows_setup', 'winscp_portable'];
    if (chosen && !isWinSCP(chosen)) return {kind:'unsupported',message:'The chosen package does not match this publisher.',choices:[]};
    const fixture = !!origin && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
    if (privateText(raw) || (!fixture && origin !== 'https://winscp.net'))
      return {kind:'unsupported',message:'Open the official winscp.net download page and use a public package request.',choices:[]};
    const choice = winSCPRequest(raw);
    if (choice === 'unsupported') return {kind:'unsupported',message:'This guide identifies the standard Windows installer or portable ZIP. Other applications, architectures and packages need a different guide.',choices:[]};
    if (choice === 'clarify' || (chosen && chosen !== choice && !/^find a download[.!?]?$/.test(words)))
      return {kind:'clarify',message:'Which WinSCP package and platform do you want? Keep any version or other requirements in your request.',choices:[]};
    if (!chosen && /^find a download[.!?]?$/.test(words)) return {kind:'clarify',message:'Which WinSCP package would you like?',choices:options};
    return {kind:'ready',profile:chosen ?? choice};
  }
  if (
    /\b(?:vlc|videolan|7[ -]?zip)\b/.test(words) &&
    (/^\s*(?:please\s+)?install\b/.test(words) ||
      /\b(?:for|on)\s+(?:macos|linux|android|ios|arm64)\b/.test(words))
  )
    return {
      kind: 'unsupported',
      message:
        'That request has a different product, package or constraint. The available guides find Windows x64 EXE files. Installation stays with you.',
      choices: [],
    };
  if (!/\b(?:download|installer|installation file|executable)\b/.test(words) &&
      !(/\b(?:vlc|videolan|7[ -]?zip)\b/.test(words) && /\bexe\s+(?:control|button|link)\b/.test(words)))
    return { kind: 'unrelated' };
  if (privateText(raw))
    return {
      kind: 'unsupported',
      message: 'Please remove private information from the request.',
      choices: [],
    };
  const named = ids.filter((id) =>
    (id === 'vlc_windows_x64' ? /\b(?:vlc|videolan)\b/ : /\b7[ -]?zip\b/).test(words),
  );
  const current = ids.find((id) => origin === new URL(products[id].page).origin);
  const available = named.length ? named : current ? [current] : ids;
  if (
    /\b(?:android|macos|mac|ios|linux|arm(?:64)?|x86|32[ -]?bit|portable|msi|dmg|source code|nightly|beta|previous version|older version|firefox|chrome|winrar)\b|\b(?:not|except|exclude|instead|without)\b/.test(
      words,
    )
  )
    return {
      kind: 'unsupported',
      message:
        'That request has a different product, package or constraint. The available publisher guides cover VLC and 7-Zip Windows x64 EXE packages. Your original request is preserved.',
      choices: [],
    };
  const unknownWords = words
    .replace(/7[ -]?zip/g, 'sevenzip')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter(
      (w) =>
        !/^(?:a|an|the|what|where|which|is|are|i|my|me|can|could|you|would|like|need|want|to|please|help|find|show|take|guide|get|locate|right|correct|intended|actual|official|download|downloads|button|control|link|installer|install|installation|file|executable|package|application|program|app|for|on|from|of|this|site|website|page|windows|win64|x64|64|bit|bits|exe|vlc|videolan|media|player|sevenzip|and|available|latest|current|version|english|there|navigate)$/.test(
          w,
        ),
    );
  if (unknownWords.length || named.length > 1 || /\bversion\s+\d/.test(words))
    return {
      kind: 'clarify',
      message:
        'Which application, operating system and package do you mean? Keep any version or other requirements in your request.',
      choices: [],
    };
  if (chosen && !available.includes(chosen))
    return {
      kind: 'unsupported',
      message: 'This package does not match the product you requested.',
      choices: [],
    };
  const profile = chosen ?? (available.length === 1 ? available[0] : undefined);
  if (
    !profile ||
    (!chosen &&
      !(/\b(?:windows|win64)\b/.test(words) && /\b(?:x64|win64|64[ -]?bit)\b/.test(words)))
  )
    return {
      kind: 'clarify',
      message: 'Confirm the application and Windows x64 EXE package you want to find.',
      choices: available,
    };
  if (
    !origin ||
    (origin !== new URL(products[profile].page).origin &&
      !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin))
  )
    return {
      kind: 'unsupported',
      message:
        'Open the official ' +
        products[profile].publisher +
        ' website, invoke SafeStep there, and submit this same request.',
      choices: [],
    };
  return { kind: 'ready', profile };
}

export function publisherGoal(raw: string): Intent {
  // Retain source spans for local WinSCP goals, including the negative
  // package and final-action clauses, when no model session is available.
  if (/\bwinscp\b/i.test(raw)) {
    const exclusions = [...raw.matchAll(/\b(?:do not|don't|not|without|except|excluding|avoid|never)\s+([^,.;!?]+)/gi)];
    if (exclusions.length) {
      const end = exclusions[0]!.index!;
      return { action:'find_document',subjects:[{text:raw.slice(0,end),start:0,end}],constraints:[],
        excluded:exclusions.map(m=>{const start=m.index!+m[0].length-m[1]!.length;
          return {text:m[1]!,start,end:start+m[1]!.length};}),question:'',choices:[] };
    }
  }
  return {
    action: 'find_document',
    subjects: [{ text: raw, start: 0, end: raw.length }],
    constraints: [],
    excluded: [],
    question: '',
    choices: [],
  };
}
export function isPublisherTerminal(url: URL, profile: FileProfile) {
  if (isWinSCP(profile)) {
    if (fixturePage(url,'download')) return url.search === '?product=winscp' && !url.hash;
    return url.href === 'https://winscp.net/eng/downloads.php' ||
      (profile === 'winscp_windows_setup' && url.href === 'https://winscp.net/eng/download.php');
  }
  return (
    !url.username &&
    !url.password &&
    (url.href === products[profile].page ||
      (fixturePage(url, 'download') &&
        url.searchParams.get('product') === (profile === 'vlc_windows_x64' ? 'vlc' : '7zip')))
  );
}
export function publisherInformationTarget(url: URL, profile: FileProfile) {
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== new URL(products[profile].page).origin
  )
    return false;
  return (
    url.href === products[profile].page ||
    (profile === 'vlc_windows_x64' && url.pathname === '/vlc/')
  );
}
export function publisherStep(snapshot: AssistSnapshot, profile: FileProfile): Step {
  const terminal = new URL(products[profile].page);
  const candidates = snapshot.controls.filter(
    (c) =>
      c.action === 'activate_readonly_link' &&
      c.path &&
      publisherInformationTarget(new URL(c.path, terminal.origin), profile),
  );
  // Prefer the publisher's exact information page when it is actually present. A
  // broader /vlc/ step is usable only when it is a unique inspected link.
  const toPackage = candidates.filter((c) => c.path === terminal.pathname);
  const available = toPackage.length ? toPackage : candidates;
  if (available.length === 1) {
    const c = available[0]!;
    return { kind: 'next_candidate', ref: c.ref, action: c.action, citations: [c.ref] };
  }
  return available.length
    ? {
        kind: 'clarify',
        question: 'Multiple publisher links match this step. Which visible route do you intend?',
      }
    : { kind: 'cannot_continue', reason: 'missing_target' };
}
