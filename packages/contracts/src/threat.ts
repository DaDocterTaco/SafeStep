import { z } from 'zod';
import { publicHost } from './public-host.js';
import type { ProtectionView } from './protection.js';
import { publicCatalogPath, catalogOrigin, storeListing } from './site-navigation.js';
import { resellStorefrontAccount, mozillaReviewScope } from './source-scope.js';
import { wikipediaSearchUrl } from './assist.js';

export const THREAT_POLICY_VERSION = 2;
export const threatPurpose = z.enum(['arrival', 'target', 'manual']);
export type ThreatPurpose = z.infer<typeof threatPurpose>;
export const threatCategories = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'] as const;
const restricted =
  /(?:^|[^a-z0-9])(?:accounts?|myaccount|login|logout|log-in|signin|sign-in|oauth2?|auth|sso|callback|profiles?|users?|private|secret|token|session|password|reset|orders?|cart|checkout|wallet|pay|payments?|admin|dashboard|inbox|mail|invite|internal|settings|billing|credentials?|bookings?|invoice|messages?|my|me|register|recover|receipt|accountsettings|member)(?:[^a-z0-9]|$)/i;
const opaque =
  /(?:^|[^a-f0-9])[a-f0-9]{16,}|[a-z0-9]{32,}|\d{10,}|[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}|eyJ[a-zA-Z0-9_-]{8,}|(?:access|refresh|identity|id)[_-]?token|session[_-]?(?:id|key)|auth[_-]?code|(?:^|[^a-z0-9])(?=[a-z\d]{18,}(?:[^a-z\d]|$))(?=(?:[a-z]*\d){4})/i;
function publicLocation(raw: string) {
  if (
    raw.length > 500 ||
    /[\\\s?#]|%(?:2f|3a|2e|40|25|3f|23|26|3d|5c)|\/\.{1,2}(?:\/|$)/i.test(raw)
  )
    return null;
  try {
    const u = new URL(raw);
    const path = decodeURIComponent(u.pathname).normalize('NFKC');
    if (
      !['https:', 'http:'].includes(u.protocol) ||
      u.href !== raw ||
      u.username ||
      u.password ||
      u.port ||
      !publicHost.safeParse(u.hostname).success ||
      restricted.test(u.hostname) ||
      /(?:^|\.)(?:sslip\.io|nip\.io|localtest\.me)$/.test(u.hostname) ||
      u.hostname.split('.').some((s) => s.startsWith('xn--') || opaque.test(s)) ||
      restricted.test(path) ||
      opaque.test(path) ||
      /[\u0000-\u001f@?=&%\\:]/.test(path) ||
      /\/\//.test(path) ||
      path !== decodeURIComponent(u.pathname) ||
      /%[0-7][0-9a-f]/i.test(raw)
    )
      return null;
    return u;
  } catch {
    return null;
  }
}
export function threatRootUrl(raw: string): string | null {
  const u = publicLocation(raw);
  return u ? u.origin + '/' : null;
}
function publicDocument(u: URL) {
  const slug = /^[a-z\d]+(?:[-_][a-z\d]+)*$/i;
  const segments = u.pathname.slice(1).split('/').filter(Boolean);
  if (segments.length > 8) return false;
  if (u.origin === catalogOrigin && publicCatalogPath(u) === '/discover') return true;
  if (
    resellStorefrontAccount(u) &&
    storeListing(u) &&
    (u.pathname === '/reviews' ||
      u.pathname === '/reviews/' ||
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+){1,20}$/.test(segments[0] ?? ''))
  )
    return true;
  if (mozillaReviewScope(u) ||
      (u.origin==='https://addons.mozilla.org' && !u.search && !u.hash &&
        /^\/[a-z]{2}(?:-[A-Za-z]{2})?\/firefox\/addon\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(u.pathname))) return true;
  const families =
    /^(?:about|articles?|blog|catalog|docs|documentation|guides?|help|learn|news|products?|public|reference|resources|support|tutorials?)$/i;
  return (
    families.test(segments[0] ?? '') && segments.every((s) => slug.test(s.replace(/\.html?$/i, '')))
  );
}
export function threatPageUrl(raw: string, purpose: ThreatPurpose = 'manual'): string | null {
  const u = publicLocation(raw);
  if (!u || u.href !== raw) return null;
  if (
    u.hostname === 'testsafebrowsing.appspot.com' &&
    /^\/s\/(?:malware|phishing|unwanted)\.html$/.test(u.pathname)
  )
    return u.href;
  if (
    u.pathname === '/' ||
    publicDocument(u) ||
    (u.hostname === 'en.wikipedia.org' &&
      /^\/wiki\/[\p{L}\p{N}_'().,-]{1,110}$/u.test(decodeURIComponent(u.pathname))) ||
    (u.hostname === 'developer.mozilla.org' &&
      /^\/en-US\/docs\/(?:[A-Za-z0-9_.-]{1,52}\/){0,14}[A-Za-z0-9_.-]{1,52}\/?$/.test(
        u.pathname,
      )) ||
    (u.hostname === 'docs.python.org' &&
      /^\/3\/tutorial\/[a-z0-9-]{1,48}\.html$/.test(u.pathname)) ||
    (['www.videolan.org', 'videolan.org'].includes(u.hostname) &&
      /^\/(?:vlc\/(?:download-windows\.html)?|support\/|index\.html)$/.test(u.pathname)) ||
    (u.hostname === 'www.7-zip.org' && u.pathname === '/download.html') ||
    (u.hostname === 'www.iana.org' && u.pathname === '/help/example-domains')
  )
    return u.href;
  if (
    purpose === 'target' &&
    ((u.origin === 'https://api.resell.store' &&
      /^\/v1\/(?:market\/stores\/[a-z0-9][a-z0-9-]{0,62}|stores\/[a-z0-9][a-z0-9-]{0,62}\/reviews)$/.test(
        u.pathname,
      )) ||
      (['get.videolan.org', 'download.videolan.org'].includes(u.hostname) &&
        /^\/(?:pub\/videolan\/)?vlc\/\d+(?:\.\d+){1,3}\/win64\/vlc-\d+(?:\.\d+){1,3}-win64\.exe$/i.test(
          u.pathname,
        )) ||
      (u.hostname === 'github.com' &&
        /^\/ip7z\/7zip\/releases\/download\/[\d.]+\/7z\d{3,5}-x64\.exe$/i.test(u.pathname)))
  )
    return u.href;
  return null;
}
const scope = z.enum(['root', 'page']);
const url = z.string().min(1).max(500);
const validSubject = (s: { scope: 'root' | 'page'; url: string; purpose?: ThreatPurpose }) =>
  (s.scope === 'root' ? threatRootUrl(s.url) : threatPageUrl(s.url, s.purpose)) === s.url;
export const ThreatRequest = z
  .strictObject({ scope, url, purpose: threatPurpose.optional() })
  .refine(validSubject);
export type ThreatRequest = z.infer<typeof ThreatRequest>;
function publicQueryHomepage(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (
      u.href !== raw ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      !publicLocation(u.origin + '/')
    )
      return null;
    const names = [...u.searchParams.keys()];
    if (!names.length || names.length !== new Set(names).size) return null;
    if (u.origin === catalogOrigin && u.pathname === '/discover') {
      // Only typed filter values and a bounded numeric page, never a free text
      // Resell query or another application parameter. Only the root leaves Chrome.
      if (names.some((k) => !['category', 'sort', 'price', 'page'].includes(k))) return null;
      const page = u.searchParams.get('page');
      if (page !== null && !/^[1-9]\d{0,2}$/.test(page)) return null;
      u.searchParams.delete('page');
      return publicCatalogPath(u) ? u.origin + '/' : null;
    }
    if (wikipediaSearchUrl(u)) {
      const words = u.searchParams.get('search')!;
      if (
        !/^[\p{L}][\p{L} ’'()-]{0,75}$/u.test(words) ||
        restricted.test(words) ||
        opaque.test(words) ||
        /\b(?:address|phone|passport|social security|medical|diagnosis|bank|email|dob|personal)\b/i.test(
          words,
        )
      )
        return null;
      return u.origin + '/';
    }
    return null;
  } catch {
    return null;
  }
}
// A harmless heading fragment identifies a location within the same public
// document. Unknown query values and unsafe fragments skip all external work.
export function automaticThreatSubject(
  raw: string,
  purpose: ThreatPurpose = 'arrival',
): ThreatRequest | null {
  if (raw.length > 500) return null;
  const hash = raw.indexOf('#'),
    subject = hash < 0 ? raw : raw.slice(0, hash);
  if (hash >= 0) {
    const fragment = raw.slice(hash + 1);
    if (
      !/^[\p{L}\p{N}_.,() -]{0,80}$/u.test(fragment) ||
      restricted.test(fragment) ||
      opaque.test(fragment)
    )
      return null;
  }
  if (subject.includes('?')) {
    const root = publicQueryHomepage(subject);
    return root ? { scope: 'root', url: root, purpose } : null;
  }
  const exact = threatPageUrl(subject, purpose);
  if (exact) return { scope: 'page', url: exact, purpose };
  const home = threatRootUrl(subject);
  return home ? { scope: 'root', url: home, purpose } : null;
}
export const ThreatReply = z
  .strictObject({
    scope,
    url,
    purpose: threatPurpose.optional(),
    source: z.literal('Google Web Risk Lookup'),
    status: z.enum(['match', 'no_match', 'unavailable', 'rate_limited']),
    categories: z.array(z.enum(threatCategories)).max(threatCategories.length),
    checkedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    reason: z.enum(['not_configured', 'disabled', 'timeout', 'source', 'quota']).nullable(),
  })
  .refine(
    (r) =>
      validSubject(r) &&
      new Set(r.categories).size === r.categories.length &&
      (r.status === 'match'
        ? r.categories.length > 0 &&
          r.reason === null &&
          r.expiresAt !== null &&
          Date.parse(r.expiresAt) > Date.parse(r.checkedAt)
        : !r.categories.length &&
          r.expiresAt === null &&
          (r.status === 'no_match'
            ? r.reason === null
            : r.status === 'rate_limited'
              ? r.reason === 'quota'
              : r.reason !== null && r.reason !== 'quota')),
  );
export type ThreatReply = z.infer<typeof ThreatReply>;

export const threatAccuracyNotice =
  'Google Web Risk can miss risky pages and can flag safe pages by mistake.';
export function activeThreat(r: ThreatReply, now = Date.now()) {
  return r.status === 'match' && !!r.expiresAt && Date.parse(r.expiresAt) > now;
}
export function threatWarningLinks(r: ThreatReply, now = Date.now()) {
  if (!activeThreat(r, now)) return [];
  const links = [
    {
      label: 'Advisory provided by Google',
      url: 'https://docs.cloud.google.com/web-risk/docs/advisory',
    },
  ];
  if (r.categories.includes('SOCIAL_ENGINEERING'))
    links.push({ label: 'Learn about phishing', url: 'https://www.antiphishing.org/' });
  if (r.categories.includes('MALWARE'))
    links.push({
      label: 'Learn about malware',
      url: 'https://developers.google.com/search/docs/monitor-debug/security/malware',
    });
  if (r.categories.includes('UNWANTED_SOFTWARE'))
    links.push({
      label: 'Learn about unwanted software',
      url: 'https://www.google.com/about/unwanted-software-policy.html',
    });
  return links;
}
export function visibleProtection(v: ProtectionView, now = Date.now()): ProtectionView {
  const warnings = v.threatWarnings?.filter((r) => activeThreat(r, now));
  const expired = v.threat?.status === 'match' && !activeThreat(v.threat, now);
  const merchantExpired = !!v.expiresAt && Date.parse(v.expiresAt) <= now;
  const destinationExpired =
    v.destination?.result?.status === 'match' && !activeThreat(v.destination.result, now);
  if (
    !expired &&
    !destinationExpired &&
    !merchantExpired &&
    warnings?.length === v.threatWarnings?.length
  )
    return v;
  const current = {
    ...v,
    ...(expired
      ? {
          threat: undefined,
          threatNotice: 'The previous Google Web Risk match expired. Recheck for current results.',
        }
      : {}),
    ...(destinationExpired ? { destination: undefined } : {}),
    ...(merchantExpired
      ? {
          status: 'unavailable' as const,
          outside: 'Previous outside merchant evidence expired. Recheck for current evidence.',
          sources: [],
          details: [],
          expiresAt: null,
        }
      : {}),
    threatWarnings: warnings,
  };
  current.caution =
    ['mismatch', 'deceptive', 'unusual'].includes(current.identity) ||
    current.status === 'reports' ||
    !!warnings?.length;
  return current;
}
export function nextProtectionExpiry(v: ProtectionView, now = Date.now()) {
  const times = [
    v.expiresAt,
    v.threat?.expiresAt,
    v.destination?.result?.expiresAt,
    ...(v.threatWarnings ?? []).map((r) => r.expiresAt),
  ]
    .filter((s): s is string => !!s)
    .map((s) => Date.parse(s))
    .filter((t) => t > now);
  return times.length ? Math.min(...times) : null;
}
export function threatFinding(r: ThreatReply, now = Date.now()) {
  const subject =
    (r.scope === 'root'
      ? (r.url.startsWith('https:') ? 'HTTPS' : 'HTTP') + ' homepage only: '
      : r.purpose === 'target'
        ? 'Exact proposed destination: '
        : 'Exact public page: ') + r.url;
  if (r.status === 'match') {
    if (!activeThreat(r, now))
      return 'The previous Google Web Risk match expired. Recheck for current results.';
    const kinds = r.categories
      .map((c) =>
        c === 'MALWARE'
          ? 'malware'
          : c === 'UNWANTED_SOFTWARE'
            ? 'unwanted software'
            : 'phishing or social engineering',
      )
      .join(' and ');
    return (
      'Google Web Risk reported possible ' +
      kinds +
      '. ' +
      subject +
      '. Avoid downloads and entering information there.'
    );
  }
  if (r.status === 'no_match')
    return (
      'No phishing, malware or unwanted software listing was returned for this lookup. ' +
      subject +
      '. This does not establish merchant reliability or general safety.'
    );
  if (r.status === 'rate_limited')
    return 'Lookup limit reached. No current threat finding is available.';
  if (r.reason === 'disabled' || r.reason === 'not_configured')
    return 'Google Web Risk is not enabled or configured on the paired service. This URL was not checked.';
  return 'A current threat-list result is unavailable. The source may be offline or unresponsive.';
}
