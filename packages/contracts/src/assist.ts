import { z } from 'zod';
import { bindingSchema, FileProfile } from './review.js';
import { GenerationLimit } from './explanation.js';
import {wikiCitationPage,wikiCitationSubject,wikiCurrentSection,publicCatalogPath,storeListing,tenantOrigin} from './site-navigation.js';
export const assistProfiles = z.enum([
  'mdn',
  'python',
  'practice',
  'wikipedia',
  'publisher',
  'catalog',
  'storefront',
  'experimental',
]);
export type AssistProfile = z.infer<typeof assistProfiles>;
export const actions = z.enum([
  'reveal_target',
  'activate_readonly_link',
  'toggle_known_navigation',
  'submit_public_search',
  'apply_catalog_filter',
  'handoff_storefront',
  'load_catalog_results',
  'inspect_catalog_filter',
  'handoff_catalog',
]);
export type AssistAction = z.infer<typeof actions>;
export const bounds = {
  controls: 32,
  extra: 16,
  headings: 12,
  scan: 1600,
  lookupScan: 3200,
  lookups: 2,
  steps: 8,
  calls: 10,
  noProgress: 2,
  changeDebounceMs: 160,
  wall: 180000,
  requestBytes: 24576,
  responseBytes: 8192,
};
const id = z.uuid(),
  short = z.string().min(1).max(100);
export function privateText(s: string) {
  return /(?:https?:\/\/[^\s]*[?@#]|\b(?:password|passcode|access[_ -]?token|bearer|api[_ -]?key|secret|sessionid|authorization)\s*[:= ]\s*\S|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:[A-Za-z0-9+/_=-]{28,})|\b(?:\d[ -]?){12,}\b|[\u0000-\u0008\u000b-\u001f])/i.test(
    s,
  );
}
export function safeLabel(s: string) {
  return (
    !privateText(s) &&
    !/[<>]|https?:\/\/|\b(?:javascript|data|file):|ignore (?:all |previous |prior )*instructions|system prompt/i.test(
      s,
    )
  );
}
const goal = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((s) => !privateText(s));
const span = z.strictObject({
  text: z.string().min(1).max(240),
  start: z.number().int().min(0).max(239),
  end: z.number().int().min(1).max(240),
});
export const Intent = z.strictObject({
  action: z.enum(['find_document', 'find_section', 'navigate_settings', 'clarify', 'unsupported']),
  subjects: z.array(span).max(12),
  constraints: z.array(span).max(12),
  excluded: z.array(span).max(8),
  question: z.string().max(160),
  choices: z.array(z.string().min(1).max(90)).max(3),
});
export type Intent = z.infer<typeof Intent>;
const ignored = new Set(
  'a an the me my i on at in for to of about from please take show find get go help information details tutorial section sections example examples how want would like could you navigate change open reach read bring around see and using use not without instead except never but do no don t dont s avoid only'.split(
    ' ',
  ),
);
const tokens = (s: string): string[] =>
  s.toLowerCase().match(/[\p{L}\d]+(?:[._-][\p{L}\d]+)*/gu) ?? [];
export function checkedIntent(raw: unknown, request: string) {
  const intent = Intent.safeParse(raw);
  if (!intent.success || !goal.safeParse(request).success) return null;
  const d = intent.data,
    spans = [...d.subjects, ...d.constraints, ...d.excluded];
  if (
    spans.some((p) => p.start >= p.end || request.slice(p.start, p.end) !== p.text) ||
    !safeLabel(d.question) ||
    d.choices.some((c) => !safeLabel(c))
  )
    return null;
  if (d.action === 'clarify' || d.action === 'unsupported') {
    const words = new Set(tokens(request));
    return d.question &&
      d.choices.every((c) => tokens(c).every((t) => words.has(t) || ignored.has(t)))
      ? d
      : null;
  }
  if (
    /\b(?:buy|purchase|install|submit|save|delete|subscribe|pay|post|sign in|log in)\b/i.test(
      request.split(/\b(?:not|without|except)\b/i)[0]!,
    ) ||
    (/\bdownload\b/i.test(request) &&
      !/\b(?:find|locate|show|identify|look for|get to|take me to)\b/i.test(request))
  )
    return null;
  if (/\bchange (?:my |the )?name\b/i.test(request)) return null;
  if (!d.subjects.length || d.question || d.choices.length) return null;
  const covered = new Set(spans.flatMap((p) => tokens(p.text)));
  if (tokens(request).some((t) => !ignored.has(t) && !covered.has(t))) return null;
  const re = /\b(?:not|without|except|avoid|never|don['’]?t)\s+((?:(?!\.(?:\s|$))[^,;!?]){1,105})/gi;
  const negativeRanges: {start:number;end:number}[] = [];
  for (const m of request.matchAll(re)) {
    const start = m.index! + m[0].length - m[1]!.length,
      end = start + m[1]!.length;
    const negative = tokens(m[1]!).filter((t) => !ignored.has(t));
    negativeRanges.push({start,end});
    if (
      negative.some(
        (t) =>
          !d.excluded.some((p) => p.end > start && p.start < end && tokens(p.text).includes(t)),
      ) ||
      [...d.subjects,...d.constraints].some((p) => p.end > start && p.start < end)
    )
      return null;
  }
  if (d.excluded.some(p => !negativeRanges.some(r => p.start >= r.start && p.end <= r.end))) return null;
  return d;
}
export const AssistBinding = bindingSchema.extend({
  windowId: z.number().int().nonnegative(),
  goalVersion: z.number().int().positive(),
  taskId: id,
});
export type AssistBinding = z.infer<typeof AssistBinding>;
export function profileForPage(u: URL): AssistProfile {
  if (u.origin === 'https://developer.mozilla.org') return 'mdn';
  if (u.origin === 'https://docs.python.org') return 'python';
  if (u.origin === 'https://en.wikipedia.org') return 'wikipedia';
  if (u.origin === 'https://resell.store') return 'catalog';
  if(tenantOrigin(u))return 'storefront';
  if (['https://www.videolan.org', 'https://www.7-zip.org', 'https://7-zip.org'].includes(u.origin))
    return 'publisher';
  if (
    u.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
    /^\/(?:assist-lab|settings-lab|cleanup-lab|download-lab)(?:\/|$)/.test(u.pathname)
  )
    return 'practice';
  return 'experimental';
}
// Only the explicit, leading Wikipedia article request is scaffolding.
// A title such as “Wikipedia article about X” on its own stays literal.
export function wikipediaArticlePrefix(goal: string) {
  const match = /^(?:from (?:the |Wikipedia['’]s )?(?:main page|home ?page|home)[,:]?\s+)?(?:please\s+)?(?:show me(?: how to find| where to find)?|find|help me find|take me to|locate|open)\s+(?:(?:the|an|a)\s+)?(Wikipedia(?:['’]s)?\s+article)\s+(?:about|on|for)\s+(?=\S)/i.exec(goal);
  if (!match) return null;
  const start = match[0].toLowerCase().indexOf(match[1]!.toLowerCase());
  return { start, end: start + match[1]!.length, topicStart: match[0].length };
}
export function publicSearchQuery(goal: string): string | null {
  const citation=wikiCitationSubject(goal);
  if(citation && safeLabel(citation)) return citation;
  if(wikiCurrentSection(goal))return null;
  const positive = goal.split(/\b(?:not|without|except|avoid|never|instead of)\b/i)[0]!;
  const prefix = wikipediaArticlePrefix(positive);
  const topic = prefix ? positive.slice(prefix.topicStart) : positive;
  const query = (prefix ? topic : topic
    .replace(
      /^(?:please\s+)?(?:(?:help me\s+)?(?:find|locate|show|open|search(?: for)?|take me to|tell me about)|(?:i (?:want|would like) to (?:find|see)))\s+(?:me\s+)?/i,
      '',
    )
    .replace(
      /^(?:(?:the |some )?(?:information|details|article|page|section) (?:about|on|for)\s+|about\s+|information (?:about|on)\s+)/i,
      '',
    )
    ).replace(/[\s,.!?]+$/, '')
    .trim();
  return query &&
    query.length <= 90 &&
    safeLabel(query) &&
    /^[\p{L}\p{N}][\p{L}\p{N} ’'.()-]*$/u.test(query)
    ? query
    : null;
}
export function wikipediaSearchProvenance(value: string) {
  return /^acrw1_-?\d{1,2}$/.test(value);
}
export function wikipediaSearchUrl(u: URL, expectedQuery?: string) {
  if (
    u.origin !== 'https://en.wikipedia.org' ||
    u.pathname !== '/w/index.php' ||
    u.hash ||
    u.username ||
    u.password
  )
    return false;
  const keys = [...u.searchParams.keys()];
  const query = u.searchParams.get('search');
  const advanced=u.searchParams.get('profile')==='advanced' && u.searchParams.get('fulltext')==='1';
  // Manual submission of the positively identified hydrated Wikipedia form
  // may include its short public provenance value. Never include it in the
  // canonical model path, and never accept another field or duplicate.
  const fields = [...u.searchParams].every(([key, value]) =>
    key === 'title' || key === 'search' ||
    (key === 'ns0' && value === '1') || (key === 'wprov' && wikipediaSearchProvenance(value)) ||
    (advanced && (key==='profile'||key==='fulltext'))
  );
  return (
    fields &&
    new Set(keys).size === keys.length &&
    u.searchParams.get('title') === 'Special:Search' &&
    query !== null && publicSearchQuery(query) === query &&
    (expectedQuery === undefined || query === expectedQuery)
  );
}
// Preserve the direction and order of a title. Treat the common possessive
// spelling "Earth's atmosphere" as "atmosphere of Earth". Sorting all the
// words would also equate "Rule of Rome by Gaul" with the opposite article.
export function samePublicTitle(left: string, right: string) {
  const normalize = (s: string) => {
    const text = s.toLowerCase().replace(/_/g, ' ').replace(/’/g, "'").trim();
    const possessive = /^(.+?)('s|s')\s+(.+)$/.exec(text);
    const title = possessive
      ? possessive[3] + ' of ' + possessive[1] + (possessive[2] === "s'" ? 's' : '')
      : text;
    return (title.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word, i) =>
      i !== 0 || !['a', 'an', 'the'].includes(word),
    ).join(' ');
  };
  const a = normalize(left);
  return !!a && a === normalize(right);
}
export function articleMatchesQuery(path: string, query: string) {
  if (!path.startsWith('/wiki/') || !query) return false;
  try {
    return samePublicTitle(decodeURIComponent(path.slice(6).split('#')[0]!), query);
  } catch {
    return false;
  }
}
function publicHost(u: URL) {
  return (
    u.protocol === 'https:' &&
    !u.port &&
    !u.username &&
    !u.password &&
    u.hostname.includes('.') &&
    !/^(?:\d+\.){3}\d+$|^\[|(?:^|\.)(?:localhost|local|test|internal|onion)$/i.test(u.hostname) &&
    !privateText(u.hostname)
  );
}
export function publicPath(u: URL, profile: AssistProfile): string | null {
  const path = u.pathname + u.hash;
  if (profileForPage(u) !== profile) return null;
  if(profile==='catalog')return publicCatalogPath(u);
  if(profile==='storefront'){
    if(!u.search && u.pathname==='/' && (!u.hash||u.hash==='#reviews'))return u.pathname+u.hash;
    return storeListing(u)?u.pathname:null;
  }
  if (profile === 'practice' && u.pathname === '/download-lab') {
    if (
      u.username ||
      u.password ||
      u.hash ||
      [...u.searchParams].some(([k, v]) => k !== 'product' || !['vlc', '7zip'].includes(v)) ||
      [...u.searchParams].length > 1
    )
      return null;
    return '/download-lab';
  }
  if (profile === 'practice') {
    // The labelled local Username fixture intentionally uses a settings/account
    // path. Only these exact served fixtures are eligible for this exception.
    const allowed =
      /^\/(?:settings-lab(?:\/(?:account|username))?|assist-lab(?:\/(?:docs|method|topic\d+))?|cleanup-lab)\/?$/i.test(
        u.pathname,
      );
    return allowed &&
      !u.username &&
      !u.password &&
      !u.search &&
      path.length <= 220 &&
      (!u.hash || (/^#[a-z0-9_.-]+$/i.test(u.hash) && !privateText(u.hash)))
      ? path
      : null;
  }
  if (profile === 'wikipedia') {
    if(wikiCitationPage(u))return u.pathname+u.search+u.hash;
    if (wikipediaSearchUrl(u)) return '/wiki/Special:Search';
    if (u.username || u.password || u.search || path.length > 220) return null;
    if (path === '/wiki/Special:Search') return path;
    try {
      // Only publicly named article routes; exclude special, user and other namespaces.
      const name = decodeURIComponent(path);
      return /^\/wiki\/[\p{L}\p{N}_'’()., -]+(?:#[\p{L}\p{N}_'’()., -]+)?$/u.test(name) &&
        !privateText(name)
        ? path
        : null;
    } catch {
      return null;
    }
  }
  if (profile === 'publisher') {
    if (u.username || u.password || u.search || (u.hash && !/^#[a-z0-9_-]{1,48}$/i.test(u.hash))) return null;
    const allowed =
      u.hostname === 'www.videolan.org'
        ? /^\/(?:vlc\/(?:download-(?:windows|macosx|linux|ubuntu|android|ios)\.html|features\.html|releases\/\d+(?:\.\d+){1,3}\.html)?|support\/(?:faq\.html)?|security\/(?:[\w-]+\.html)?|news\.html|index\.html)?(?:#[a-z0-9_-]+)?$/i
        : /^\/(?:download\.html)?$/;
    return allowed.test(path) ? path : null;
  }
  if (
    profile === 'experimental' &&
    /(?:^|[\/_-])(?:api|rpc|graphql|webhooks?|actions?|commands?|register|confirm|erase|remove|reset|withdraw|transfer|send|block|follow|unfollow|reserve|bid|vote|download)(?:[\/_.#-]|$)/i.test(
      path,
    )
  )
    return null;
  const opaque = path
    .split(/[\/#]/)
    .some(
      (s) =>
        privateText(s) &&
        !(
          (profile === 'mdn' || profile === 'python') &&
          /^[a-z]{2,20}(?:[-_][a-z]{2,20})+$/.test(s)
        ),
    );
  if (
    u.username ||
    u.password ||
    u.search ||
    path.length > 220 ||
    !/^\/[a-z0-9_/().~-]*(?:#[a-z0-9_.~-]+)?$/i.test(path) ||
    opaque ||
    /(?:^|[\/_-])(?:login|logout|sign-?in|sign-?out|account|accounts|admin|auth|oauth|session|profile|users?|private|billing|orders?|dashboard|settings|search|playground|download|checkout|payment|consent|delete|execute|edit|subscribe|message|token|cart|buy|pay|submit|vote|upload|unsubscribe|redirect)(?:[\/_.#-]|$)|\.(?:zip|exe|msi|pdf|xpi|gz|whl|dmg|pkg|deb|apk|7z|rar|iso|docx?|xlsx?|csv|bin|msix|tar|bz2)(?:$|#)/i.test(
      path,
    )
  )
    return null;
  if (profile === 'mdn') return u.pathname.startsWith('/en-US/docs/') ? path : null;
  if (profile === 'python')
    return /^\/3\/(?:$|[a-z0-9_/-]+\.html$)/i.test(u.pathname) ? path : null;
  const fixture =
    u.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(u.hostname) &&
    /^\/public-guide-lab(?:\/|$)/.test(path);
  return fixture || publicHost(u) ? path : null;
}
const path = z
  .string()
  .max(220)
  .regex(/^[A-Za-z0-9/_.()#:%'~,?=+&\-]*$/);
export const publicRef = z.strictObject({
  ref: id,
  label: short.refine(safeLabel),
  role: z.enum(['link', 'button', 'heading', 'search']),
  path: path.nullable(),
  action: actions,
  visible: z.boolean(),
  context: z.string().min(1).max(64).refine(safeLabel).optional(),
  expanded: z.boolean().optional(),
  targetOrigin:z.string().max(110).optional(),
});
export type PublicRef = z.infer<typeof publicRef>;
export const AssistSnapshot = z.strictObject({
  profile: assistProfiles,
  path,
  headings: z.array(publicRef).max(12),
  controls: z.array(publicRef).max(48),
  limited: z.boolean(),
  complete: z.string().max(160).nullable(),
  catalogItems:z.number().int().min(0).max(256).optional(),
  catalogNotice:z.enum(['Condition filters are coming soon.','Size filters are coming soon.']).optional(),
  ambiguity:z.array(short.refine(safeLabel)).max(4).optional(),
});
export type AssistSnapshot = z.infer<typeof AssistSnapshot>;
const assistBase = {
  operationId: id,
  bindingToken: id,
  binding: AssistBinding,
  goal,
  profile: assistProfiles,
  download: FileProfile.optional(),
};
export const IntentInput = z.strictObject({ ...assistBase, kind: z.literal('intent') });
export const StepInput = z.strictObject({
  ...assistBase,
  kind: z.literal('step'),
  intent: Intent,
  snapshot: AssistSnapshot,
  previous: z.array(z.string().max(100)).max(8),
});
export type IntentInput = z.infer<typeof IntentInput>;
export type StepInput = z.infer<typeof StepInput>;
export function validAssistInput(i: IntentInput | StepInput) {
  if (!URL.canParse(i.binding.origin)) return false;
  const origin = new URL(i.binding.origin);
  if (origin.origin !== i.binding.origin || !['http:', 'https:'].includes(origin.protocol))
    return false;
  const allowedLocal =
    origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    i.download &&
    !(i.profile === 'practice' && allowedLocal) &&
    !(
      i.profile === 'publisher' &&
      origin.origin ===
        (i.download === 'vlc_windows_x64' ? 'https://www.videolan.org' : 'https://www.7-zip.org')
    )
  )
    return false;
  if (
    i.operationId !== i.binding.operationId ||
    i.bindingToken !== i.binding.revision ||
    !safeLabel(i.goal) ||
    (i.profile === 'experimental' && !publicHost(origin) && !allowedLocal) ||
    profileForPage(new URL(i.binding.origin + (i.profile === 'practice' ? '/assist-lab' : ''))) !==
      i.profile
  )
    return false;
  if (i.kind === 'intent') return true;
  if (
    !checkedIntent(i.intent, i.goal) ||
    ['clarify', 'unsupported'].includes(i.intent.action) ||
    i.snapshot.profile !== i.profile ||
    ((i.snapshot.catalogItems!==undefined || i.snapshot.catalogNotice!==undefined) && i.profile!=='catalog') ||
    (i.snapshot.ambiguity!==undefined && i.profile!=='wikipedia') ||
    i.previous.some((s) => !safeLabel(s)) ||
    (i.snapshot.complete && !safeLabel(i.snapshot.complete))
  )
    return false;
  const refs = [...i.snapshot.controls, ...i.snapshot.headings];
  if (
    new Set(refs.map((r) => r.ref)).size !== refs.length ||
    refs.some((r) =>
      r.action==='handoff_catalog'
        ? !(i.profile==='storefront' && r.role==='link' && r.targetOrigin==='https://resell.store' && r.path==='/discover')
      : r.targetOrigin || r.action==='handoff_storefront'
        ? !(i.profile==='catalog' && r.role==='link' && r.action==='handoff_storefront' && !!r.targetOrigin && !!r.path &&
          URL.canParse(r.targetOrigin+r.path) && new URL(r.targetOrigin+r.path).origin===r.targetOrigin &&
          storeListing(new URL(r.targetOrigin+r.path)))
      : r.role === 'link'
        ? r.action !== 'activate_readonly_link' || r.path === null
        : r.role==='button' && r.action==='apply_catalog_filter' ? i.profile!=='catalog' || !r.path
        : r.role==='button'&&['load_catalog_results','inspect_catalog_filter'].includes(r.action)?i.profile!=='catalog'||r.path!==null
        : (r.path !== null && !(r.role==='search' && i.profile==='catalog') &&
          !(i.profile==='wikipedia' && r.action==='toggle_known_navigation' && r.label==='Open Wikipedia search' && r.path==='/wiki/Special:Search')) ||
          (r.role === 'search'
            ? r.action !== 'submit_public_search' || !['wikipedia','catalog'].includes(i.profile)
            : r.role === 'heading'
              ? r.action !== 'reveal_target'
              : r.action !== 'toggle_known_navigation'),
    )
  )
    return false;
  const paths = [
    i.snapshot.path,
    ...[...i.snapshot.controls, ...i.snapshot.headings].filter(c=>!c.targetOrigin)
      .map((c) => c.path)
      .filter((s): s is string => s !== null),
  ];
  return paths.every(
    (p) => p.startsWith('/') && publicPath(new URL(p, i.binding.origin), i.profile) === p,
  );
}
export const Step = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('next_candidate'),
    ref: id,
    action: actions,
    citations: z.array(id).min(1).max(3),
  }),
  z.strictObject({
    kind: z.literal('need_more_controls'),
    terms: z.array(z.string().min(1).max(65)).min(1).max(3),
  }),
  z.strictObject({ kind: z.literal('completion_candidate'), citations: z.array(id).min(1).max(3) }),
  z.strictObject({ kind: z.literal('clarify'), question: z.string().min(1).max(160) }),
  z.strictObject({
    kind: z.literal('cannot_continue'),
    reason: z.enum(['missing_target', 'unsupported', 'manual_action_required', 'unclear_goal']),
  }),
]);
export type Step = z.infer<typeof Step>;
export function checkedStep(raw: unknown, i: StepInput) {
  const s = Step.safeParse(raw);
  if (!s.success || !checkedIntent(i.intent, i.goal) || i.snapshot.profile !== i.profile)
    return null;
  const d = s.data,
    refs = [...i.snapshot.controls, ...i.snapshot.headings];
  if (new Set(refs.map((r) => r.ref)).size !== refs.length) return null;
  if ('citations' in d && d.citations.some((k) => !refs.some((r) => r.ref === k))) return null;
  if (
    d.kind === 'next_candidate' &&
    (!d.citations.includes(d.ref) || !refs.some((r) => r.ref === d.ref && r.action === d.action))
  )
    return null;
  if (d.kind === 'clarify' && !safeLabel(d.question)) return null;
  if (d.kind === 'need_more_controls') {
    const terms = [i.goal, ...refs.map((r) => r.label)].join(' ').toLowerCase();
    if (d.terms.some((t) => !safeLabel(t) || !terms.includes(t.toLowerCase()))) return null;
  }
  return d;
}
export const AssistReply = z.strictObject({
  operationId: id,
  bindingToken: id,
  status: z.enum([
    'available',
    'not_configured',
    'unauthorized',
    'rate_limited',
    'timeout',
    'unavailable',
    'invalid_response',
    'cancelled',
  ]),
  explanation: z.union([Intent, Step]).nullable(),
  // Older local services omit this. Never infer a spending limit from status alone.
  limitReason: GenerationLimit.optional(),
  elapsedMs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative().nullable(),
});
export const AssistOutcome = z.strictObject({
  at: z.iso.datetime(),
  operation: z.enum(['intent', 'step']),
  status: AssistReply.shape.status,
  elapsedMs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative().nullable(),
});
export type AssistOutcome = z.infer<typeof AssistOutcome>;
export const AssistHealth = z.strictObject({
  provider: z.literal('Gemini'),
  model: z.string().max(80).nullable(),
  configured: z.boolean(),
  intentVerified: z.boolean(),
  stepVerified: z.boolean(),
  pending: z.number().int().nonnegative(),
  perMinute: z.literal(6),
  perSession: z.literal(30),
  recent: z.array(AssistOutcome).max(10),
});
export const AdaptiveState = z.strictObject({
  version: z.number().int().positive(),
  profile: assistProfiles,
  download: FileProfile.optional(),
  searchQuery: z.string().min(1).max(90).refine(safeLabel).optional(),
  returnUrl:z.string().max(250).refine(s=>URL.canParse(s)&&!!publicCatalogPath(new URL(s))).optional(),
  origin: z.string().max(260),
  intent: Intent.nullable(),
  status: z.string().max(180),
  since: z.number().int().nonnegative(),
  calls: z.number().int().max(10),
  noProgress: z.number().int().max(2),
  authorized: z.boolean(),
  journal: z
    .strictObject({
      id,
      documentId: z.string().max(64),
      revision: id,
      action: actions,
      from: path,
      to: path.nullable(),
      state: z.enum(['claimed', 'dispatched', 'verified', 'uncertain']),
    })
    .nullable(),
});
export type AdaptiveState = z.infer<typeof AdaptiveState>;
export const CleanItem = z.strictObject({
  id,
  reason: z.enum(['advertisement', 'promotion', 'promo_pair']),
  signal: z.enum(['labelled_advertisement','labelled_sponsored','labelled_promotion','recognized_banner','recognized_popup_pair']).optional(),
  hidden: z.boolean(),
});
export const CleanupView = z.strictObject({
  binding: bindingSchema,
  items: z.array(CleanItem).max(30),
  hidden: z.number().int().min(0).max(30),
  failed: z.number().int().min(0).max(30).optional(),
  uncertain: z.boolean(),
  limited: z.boolean(),
  enabled: z.boolean(),
});
export type CleanupView = z.infer<typeof CleanupView>;
export const AssistPage = z.strictObject({
  channel: z.literal('assist-page'),
  requestId: id,
  binding: AssistBinding,
  cmd: z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('inspect'), goal, terms: z.array(z.string().max(65)).max(3) }),
    z.strictObject({ op: z.literal('verify_snapshot') }),
    z.strictObject({ op: z.literal('cue'), ref: id, action: actions, scroll: z.boolean() }),
    z.strictObject({ op: z.literal('act'), ref: id, action: actions, actionId: id }),
    z.strictObject({ op: z.literal('clear') }),
  ]),
});
export type AssistPage = z.infer<typeof AssistPage>;
export const AssistPageReply = z.strictObject({
  channel: z.literal('assist-result'),
  requestId: id,
  binding: AssistBinding,
  ok: z.boolean(),
  snapshot: AssistSnapshot.nullable(),
  error: z.string().max(120).nullable(),
});
export type AssistPageReply = z.infer<typeof AssistPageReply>;
export const AssistNotice = z.strictObject({
  channel: z.literal('assist-notice'),
  binding: AssistBinding,
  event: z.enum(['changed', 'user_target', 'revealed']),
});
export const CleanPage = z.strictObject({
  channel: z.literal('clean-page'),
  requestId: id,
  binding: bindingSchema,
  cmd: z.enum(['preview', 'apply', 'restore', 'restore_one']),
  id: id.optional(),
  ids: z.array(id).min(1).max(30).optional(),
});
export const CleanReply = z.strictObject({
  channel: z.literal('clean-result'),
  requestId: id,
  binding: bindingSchema,
  view: CleanupView.nullable(),
});
export const CleanNotice = z.strictObject({
  channel: z.literal('clean-notice'),
  binding: bindingSchema,
  view: CleanupView,
});
