import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressObservation, GuideFacts, Lookup } from '@safestep/contracts';
import { observeAddress } from '../apps/extension/sites/address';
import { resolveGoal, expectedNavigation, citationView } from '../apps/extension/sites/profiles';
const wiki = 'en.wikipedia.org',
  vlc = 'www.videolan.org',
  base = 'https://www.videolan.org/vlc/';
const check = (raw: string | null, expected: string | null = vlc, label = '') =>
  AddressObservation.parse(observeAddress(raw, base, expected, label));
test('S2-G03/G04: the six aliases, full requests, ambiguous and unsupported intents', () => {
  for (const g of [
    'Help me find the APA citation for this article.',
    'How do I cite this page?',
    'Find an APA citation',
    'Show the article citation',
  ])
    assert.equal(resolveGoal(g), 'wikipedia_cite_apa');
  for (const g of [
    'Help me find VLC for Windows.',
    'Where is the Windows download page?',
    'Find VLC for Windows',
    'Show the official Windows VLC page',
  ])
    assert.equal(resolveGoal(g), 'videolan_windows_page');
  for (const g of ['', 'help me', 'Find an APA citation and VLC for Windows'])
    assert.equal(resolveGoal(g), 'clarify');
  for (const g of ['buy a monitor', 'install VLC for Windows', 'change my account password'])
    assert.equal(resolveGoal(g), 'unsupported');
});
test('S2-G10: only the supported article and explicit next public state qualify', () => {
  const w = 'wikipedia_cite_apa',
    v = 'videolan_windows_page',
    cite = 'https://en.wikipedia.org/w/index.php?title=Special%3ACiteThisPage&page=Phishing';
  assert(expectedNavigation(w, 2, cite));
  assert(!expectedNavigation(w, 3, cite));
  assert(expectedNavigation(w, 3, cite + '#APA_style'));
  for (const changed of [
    cite.replace('Phishing', 'Other'),
    cite.replace('en.wikipedia.org', 'evil.test'),
    cite + '&page=Other',
  ])
    assert(!expectedNavigation(w, 2, changed));
  assert(!citationView(new URL(cite.replace('CiteThisPage', 'Search'))));
  assert(expectedNavigation(v, 3, base + 'download-windows.html'));
  assert(!expectedNavigation(v, 2, base + 'download-windows.html'));
  assert(!expectedNavigation(v, 3, 'https://get.videolan.org/vlc/setup.exe'));
  assert(
    !GuideFacts.safeParse({
      workflow: w,
      version: 1,
      step: 1,
      result: 'target',
      placement: 'above',
      ref: null,
      link: null,
    }).success,
  );
});
test('S2-U01/U02: exact sites, embedded brand, and deceptive credentials are distinct', () => {
  for (const h of [wiki, vlc]) {
    const a = check('https://' + h, h);
    assert.equal(a.relationship, 'expected_host');
    assert(a.allowed);
    assert(a.domain);
  }
  const fake = check('https://en.wikipedia.org.harmless.test/', wiki);
  assert.equal(fake.host, 'en.wikipedia.org.harmless.test');
  assert(fake.flags.includes('embedded_expected_domain'));
  assert(!fake.allowed);
  const info = check('https://example:PRIVATE_MARKER@www.videolan.org/path?ticket=PRIVATE_MARKER');
  assert(info.flags.includes('user_info'));
  assert(!info.allowed);
  assert(!JSON.stringify(info).includes('PRIVATE_MARKER'));
});
test('S2-U03/U04: one-edit typo and sibling hosts are not allowed origins', () => {
  for (const h of ['videolam.org', 'viedolan.org', 'videoalan.org'])
    assert(check('https://' + h).flags.includes('similar_spelling'));
  for (const h of ['get.videolan.org', 'unlisted.videolan.org']) {
    const a = check('https://' + h);
    assert.equal(a.relationship, 'same_registered_domain_other_host');
    assert.equal(a.allowed, false);
  }
  for (const u of ['http://www.videolan.org/', 'https://www.videolan.org:8443/']) {
    const a = check(u);
    assert(!a.allowed);
    assert(a.flags.length);
  }
});
test('S2-U05: private suffix, multi-label suffix, case and trailing dot', () => {
  const tenant = check('https://beta.github.io', 'alpha.github.io');
  assert.equal(tenant.relationship, 'different_domain');
  assert.equal(tenant.domain, 'beta.github.io');
  assert.equal(check('https://a.b.example.co.uk', null).domain, 'example.co.uk');
  const dot = check('https://WWW.VIDEOLAN.ORG./');
  assert.equal(dot.host, vlc);
  assert(!dot.allowed);
  assert(dot.flags.includes('trailing_dot'));
  assert(check('https://WWW.VIDEOLAN.ORG/').allowed);
});
test('S2-U06: neutral IDN, IP, local, invalid and no-context results', () => {
  const idn = check('https://bücher.de', null);
  assert.equal(idn.host, 'xn--bcher-kva.de');
  assert(idn.flags.includes('international'));
  for (const u of ['http://127.0.0.1', 'http://[::1]'])
    assert(check(u, null).flags.includes('ip_address'));
  for (const h of ['localhost', 'service.unknownsuffix']) {
    const a = check('http://' + h, null);
    assert.equal(a.domain, null);
    assert(a.flags.includes('unknown_suffix'));
  }
  assert.equal(check('http://[', null).relationship, 'invalid_or_unsupported_address');
  assert.equal(check('https://example.com', null).relationship, 'no_expected_site');
  assert(
    !Lookup.safeParse({
      provider: 'url_threat',
      subject: { kind: 'website_risk', domain: 'localhost' },
    }).success,
  );
});
test('S2-U07/U08: relative base, opaque targets, visible label mismatch and external reference', () => {
  assert.equal(check('download-windows.html').host, vlc);
  assert.equal(check('').host, vlc);
  for (const u of [
    null,
    'javascript:void(0)',
    'blob:https://example.com/id',
    'data:text/plain,x',
    'mailto:someone@example.test',
  ])
    assert.equal(check(u).relationship, 'uninspectable_destination');
  const a = check('https://example.org/ref?token=PRIVATE_MARKER', vlc, 'https://www.videolan.org/');
  assert(a.flags.includes('label_mismatch'));
  assert(!JSON.stringify(a).includes('PRIVATE_MARKER'));
  const ordinary = check('https://example.org/research', vlc, 'Read the reference');
  assert.equal(ordinary.relationship, 'different_domain');
  assert.deepEqual(ordinary.flags, []);
});
