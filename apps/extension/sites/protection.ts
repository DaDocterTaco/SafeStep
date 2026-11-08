import { publicHost, type ProtectionView } from '@safestep/contracts';
import { observeAddress } from './address';

const privateSegment =
  /(?:^|[^a-z0-9])(?:log[-_]?in|sign[-_]?in|account|myaccount|me|profile|private|authenticated|auth|oauth|sso|callback|reset|recover|session(?:id)?|token|secret|password|passcode|credentials|admin|inbox|messages?|orders?|basket|cart|checkout|billing|pay(?:ment)?|bank|wallet|dashboard|settings|invite)(?:[^a-z0-9]|$)/i;
function decodedPublicPart(raw: string) {
  if (raw.length > 650) return null;
  let s = raw;
  try {
    for (let depth = 0; depth < 2 && s.includes('%'); depth++) s = decodeURIComponent(s);
  } catch {
    return null;
  }
  s = s.normalize('NFKC');
  if (/[\u0000-\u001f%?@=&\\]|[A-Za-z0-9_-]{28,}/.test(s) || privateSegment.test(s)) return null;
  return s;
}
function publicQuery(u: URL) {
  const known = new Set<string>();
  for (const [key, value] of u.searchParams) {
    if (known.has(key)) return false;
    known.add(key);
    const text = decodedPublicPart(value);
    if (!text) return false;
    if (key === 'page' && /^\d{1,4}$/.test(text)) continue;
    if ((key === 'lang' || key === 'uselang') && /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(text))
      continue;
    if (key === 'title' && text.length <= 80 && /^[\p{L}\p{N}][\p{L}\p{N}_ ()'’.,-]*$/u.test(text))
      continue;
    return false;
  }
  return true;
}
export function protectionAddress(raw: string, expectAmazon = false) {
  const u = new URL(raw);
  const check = observeAddress(raw, raw, 'amazon.com');
  const host = check.host ?? '';
  const looksAmazon =
    /am[a4]z[o0]n|amazon/i.test(host) ||
    /amazon/i.test(u.username) ||
    check.flags.includes('similar_spelling');
  let identity: ProtectionView['identity'] = 'observed';
  let address = 'Current hostname: ' + host + '. Identity alone does not establish reputation.';
  if (expectAmazon || looksAmazon || check.domain === 'amazon.com') {
    if (
      check.domain === 'amazon.com' &&
      u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password
    ) {
      identity = 'amazon_us';
      address =
        host + ' matches the expected Amazon US HTTPS domain. Seller feedback is a separate check.';
    } else if (
      check.flags.includes('embedded_expected_domain') ||
      check.flags.includes('similar_spelling') ||
      check.flags.includes('user_info') ||
      /(?:^|\.)amazon-com[.-]/.test(host)
    ) {
      identity = 'deceptive';
      address =
        'The actual host is ' +
        host +
        '. This address does not match the expected Amazon US site. Check the address before continuing.';
    } else {
      identity = 'mismatch';
      address =
        host +
        ' does not match the expected Amazon US HTTPS address. A different domain, region, port or protocol alone does not establish fraud.';
    }
  } else if (check.flags.includes('user_info') || check.scheme !== 'https') {
    identity = 'unusual';
    address = check.flags.includes('user_info')
      ? 'This address includes user information before the actual host, ' + host + '.'
      : 'This page uses HTTP on ' + host + '. Its connection is not encrypted.';
  }
  const privateRoute =
    !publicHost.safeParse(host).success ||
    !check.domain ||
    check.flags.includes('ip_address') ||
    !!u.username ||
    !!u.password ||
    !!u.port ||
    decodedPublicPart(u.pathname) === null ||
    !publicQuery(u) ||
    (u.hash.length > 0 && (u.hash.length > 100 || decodedPublicPart(u.hash.slice(1)) === null)) ||
    /\b(?:localhost|internal|intranet|local|corp|test|example|invalid)$/.test(host) ||
    ['accounts', 'login', 'auth', 'mail', 'myaccount', 'banking', 'intranet', 'internal'].includes(
      host.split('.')[0]!,
    );
  return {
    host,
    domain: check.domain,
    identity,
    address,
    privateRoute,
    caution:
      identity === 'deceptive' ||
      (identity === 'mismatch' && check.domain === 'amazon.com') ||
      check.flags.includes('user_info'),
  };
}
