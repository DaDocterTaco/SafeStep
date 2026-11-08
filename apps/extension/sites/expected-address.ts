import { publicHost } from '@safestep/contracts';
import { observeAddress } from './address';

const publishers: Record<string, string> = {
  wikipedia: 'wikipedia.org',
  videolan: 'videolan.org',
  vlc: 'videolan.org',
  mozilla: 'mozilla.org',
  resell: 'resell.store',
  '7-zip': '7-zip.org',
  python: 'python.org',
  iana: 'iana.org',
};

// An explicit expectation must come from the user's words outside a URL.
// The hostname or path being inspected cannot nominate its own publisher.
export function expectedAddress(text: string): string | null {
  const words = text.replace(/https?:\/\/\S+/gi, ' ');
  const names = [
    /\b(?:expect(?:ed|ing)?|belongs? to)\s+(?:(?:website|site|domain|address)\s+)?(?:is\s+)?([a-z0-9][a-z0-9.-]{1,252})/i,
    /\bofficial\s+(?:(?:site|website)\s+(?:for|of)\s+)?([a-z0-9][a-z0-9.-]{1,252})/i,
    /\bis (?:this|it)\s+(?:the\s+)?([a-z0-9][a-z0-9.-]{1,252})/i,
    /\s—\s([a-z0-9][a-z0-9.-]{1,252})\s*$/i,
  ];
  for (const pattern of names) {
    const name = pattern.exec(words)?.[1]?.toLowerCase().replace(/[.]+$/, '');
    if (name && publishers[name]) return publishers[name]!;
    if (name && publicHost.safeParse(name).success &&
        observeAddress('https://'+name+'/', 'https://'+name+'/', null).domain) return name;
  }
  return null;
}

export function explainExpectedAddress(raw: string, expected: string): string {
  const a = observeAddress(raw, raw, expected);
  const host = a.host ?? 'unknown';
  const matches = host === expected || host.endsWith('.' + expected);
  const secure = a.scheme === 'https' && !a.port && !a.flags.includes('user_info');
  return (
    'Actual hostname: ' +
    host +
    '. ' +
    (matches && secure
      ? 'This HTTPS address matches the expected ' + expected + ' domain.'
      : 'This address does not match the expected HTTPS address for ' + expected + '.') +
    ' Website reputation and seller service require separate evidence.'
  );
}
