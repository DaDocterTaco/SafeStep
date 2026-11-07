import { parse } from 'tldts';
import type { AddressObservation } from '@safestep/contracts';
const opts = { extractHostname: false, allowPrivateDomains: true, validateHostname: true };
function registered(host: string) {
  const p = parse(host, opts);
  return p.isIcann || p.isPrivate ? p.domain : null;
}
function oneEdit(a: string, b: string) {
  if (a === b || Math.abs(a.length - b.length) > 1 || Math.max(a.length, b.length) > 63)
    return false;
  if (a.length > b.length) return oneEdit(b, a);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length !== b.length) return a.slice(i) === b.slice(i + 1);
  return (
    a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
  );
}
// Only this in-document function receives href, label, user-info or query data.
export function observeAddress(
  raw: string | null,
  base: string,
  expected: string | null,
  label = '',
): AddressObservation {
  const out: AddressObservation = {
    host: null,
    domain: null,
    expected,
    scheme: null,
    port: '',
    relationship: 'uninspectable_destination',
    flags: [],
    allowed: false,
  };
  if (raw === null) return out;
  if (raw.length > 8192) return { ...out, relationship: 'invalid_or_unsupported_address' };
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return { ...out, relationship: 'invalid_or_unsupported_address' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return out;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.[\]:_-]+$/.test(host))
    return { ...out, relationship: 'invalid_or_unsupported_address' };
  out.host = host;
  out.scheme = u.protocol === 'https:' ? 'https' : 'http';
  out.port = u.port;
  const parsed = parse(host, opts);
  out.domain = registered(host);
  if (u.username || u.password) out.flags.push('user_info');
  if (u.protocol !== 'https:' && expected) out.flags.push('unexpected_scheme');
  if (u.port) out.flags.push('nondefault_port');
  if (u.hostname.endsWith('.')) out.flags.push('trailing_dot');
  if (/(^|\.)xn--/.test(host)) out.flags.push('international');
  if (parsed.isIp || host.startsWith('[')) out.flags.push('ip_address');
  else if (!out.domain && !parsed.isIcann && !parsed.isPrivate) out.flags.push('unknown_suffix');
  const expDomain = expected ? registered(expected) : null;
  out.relationship = !expected
    ? 'no_expected_site'
    : host === expected
      ? 'expected_host'
      : out.domain && out.domain === expDomain
        ? 'same_registered_domain_other_host'
        : 'different_domain';
  out.allowed = !!expected && u.origin === 'https://' + expected && !u.username && !u.password;
  if (expDomain && out.relationship === 'different_domain') {
    if (('.' + host + '.').includes('.' + expDomain + '.'))
      out.flags.push('embedded_expected_domain');
    const a = out.domain?.split('.')[0],
      b = expDomain.split('.')[0];
    if (a && b && b.length >= 4 && oneEdit(a, b)) out.flags.push('similar_spelling');
  }
  let shown = label.trim();
  if (/^(?:https?:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$))/i.test(shown) && !/\s/.test(shown)) {
    try {
      if (!/^https?:\/\//i.test(shown)) shown = 'https://' + shown;
      if (new URL(shown).hostname.toLowerCase().replace(/\.$/, '') !== host)
        out.flags.push('label_mismatch');
    } catch {
      /* Not an inspectable visible URL label. */
    }
  }
  return out;
}
