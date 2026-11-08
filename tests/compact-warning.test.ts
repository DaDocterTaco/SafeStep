import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtectionView, ThreatReply } from '@safestep/contracts';
import {
  currentWarningText,
  warningPresentationKey,
} from '../apps/extension/sites/protection-warning';

const now = Date.parse('2026-11-08T11:00:00Z');
const site = 'https://amazon.com.shop-verify.test';
const local: ProtectionView = {
  routeToken: 'a'.repeat(32),
  doc: 'doc',
  origin: site,
  host: new URL(site).hostname,
  expectedHost: 'amazon.com',
  revision: 'rev',
  identity: 'deceptive',
  address: 'The actual host is amazon.com.shop-verify.test. Check this address.',
  checkedAt: new Date(now).toISOString(),
  status: 'local',
  outside: 'Outside reports are off. Only the current address was checked.',
  sources: [],
  details: [],
  caution: true,
  dismissed: false,
  expiresAt: null,
};
function receipt(scope: 'page' | 'root', categories: ThreatReply['categories']): ThreatReply {
  return {
    url: site + (scope === 'root' ? '/' : '/articles/returns'),
    scope,
    purpose: 'arrival',
    status: 'match',
    reason: null,
    source: 'Google Web Risk Lookup',
    categories,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
  };
}
test('compact identity warning shows the complete compared hosts and local coverage once; dates are secondary', () => {
  const x = currentWarningText(local, now);
  assert.equal(x.passiveLocalStrip, false);
  assert.equal(currentWarningText(local, now, true).passiveLocalStrip, true);
  assert.equal(
    currentWarningText({ ...local, status: 'reports' }, now, true).passiveLocalStrip,
    false,
  );
  assert.deepEqual(x.rows, [
    { label: 'Expected', value: 'amazon.com' },
    { label: 'Here', value: 'amazon.com.shop-verify.test' },
  ]);
  assert.deepEqual(x.findings, [
    'Address only. Outside reputation checks are off.',
    'Check before sharing information.',
  ]);
  assert(x.details.some((d) => d.includes('Local address check')));
  assert(
    ![...x.findings, ...x.details].some((d) => d.includes(local.host) || d.includes('amazon.com')),
  );
  assert.deepEqual(x.advisory, []);
  const same = currentWarningText(
    { ...local, identity: 'mismatch', host: 'amazon.com', origin: 'http://amazon.com' },
    now,
  );
  assert.deepEqual(same.rows, [{ label: 'Expected and here', value: 'amazon.com' }]);
  assert.match(same.findings.join(' '), /requires HTTPS/);
});
test('only the identity engine’s actual registrable difference is emphasized and each value identifies its provenance', () => {
  const host = 'www.amazon.com.safestep-fixture.org';
  const view = { ...local, host, origin: 'https://' + host },
    copy = currentWarningText(view, now);
  assert(copy.difference);
  const marked = host.slice(copy.difference.start, copy.difference.end);
  assert.equal(marked, 'safestep-fixture.org');
  assert(copy.details.includes('Expected · SafeStep’s built-in Amazon US address rule.'));
  assert(copy.details.includes('Here · Current browser address.'));
  assert.equal(
    currentWarningText({ ...view, host: 'www.amazon.com', origin: 'http://www.amazon.com' }, now)
      .difference,
    null,
  );
  assert.equal(
    warningPresentationKey(view),
    warningPresentationKey({ ...view, checkedAt: new Date(now + 3000).toISOString() }),
  );
  assert.notEqual(
    warningPresentationKey(view),
    warningPresentationKey({ ...view, threatWarnings: [receipt('page', ['MALWARE'])] }),
  );
});
test('a current page match and homepage match retain separate scope, single subject, and positive-only provider attribution', () => {
  const page = receipt('page', ['SOCIAL_ENGINEERING']);
  const home = receipt('root', ['MALWARE']);
  const x = currentWarningText({ ...local, threat: page, threatWarnings: [home, page] }, now);
  assert.equal(x.rows[1]?.value, page.url);
  assert.deepEqual(
    x.findings.filter((s) => s.includes('Google Web Risk')),
    [
      'Google Web Risk reported possible malware for the homepage only.',
      'Google Web Risk reported possible phishing or social engineering for this exact page.',
    ],
  );
  assert.equal(x.advisory.filter((a) => a.label === 'Advisory provided by Google').length, 1);
  assert(![...x.findings, ...x.details].some((d) => d.includes(local.host)));
  assert.deepEqual(
    currentWarningText({ ...local, threatWarnings: [page] }, now + 310000).advisory,
    [],
  );
  assert.deepEqual(
    currentWarningText({ ...local, threatWarnings: [{ ...page, purpose: 'target' }] }, now)
      .advisory,
    [],
  );
});
test('folded positive warnings keep original scope, advisory and applicable learning links; expiry/local copy removes all provider claims', () => {
  const home = receipt('root', ['MALWARE']),
    page = receipt('page', ['SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE']);
  assert.equal(
    currentWarningText({ ...local, threat: page, threatWarnings: [page] }, now, true)
      .passiveLocalStrip,
    false,
  );
  for (const compact of [false, true]) {
    const x = currentWarningText(
      { ...local, threat: page, threatWarnings: [home, page] },
      now,
      compact,
    );
    assert(x.findings.some((s) => s.includes('possible malware for the homepage only')));
    assert(
      x.findings.some((s) =>
        s.includes(
          'possible phishing or social engineering and unwanted software for this exact page',
        ),
      ),
    );
    assert.deepEqual(
      x.advisory.map((a) => a.label).sort(),
      [
        'Advisory provided by Google',
        'Learn about malware',
        'Learn about phishing',
        'Learn about unwanted software',
      ].sort(),
    );
    assert.equal(
      x.advisory.find((a) => a.label === 'Advisory provided by Google')?.url,
      'https://docs.cloud.google.com/web-risk/docs/advisory',
    );
    assert.equal(
      x.advisory.find((a) => a.label === 'Learn about phishing')?.url,
      'https://www.antiphishing.org/',
    );
  }
  for (const x of [
    currentWarningText(local, now, true),
    currentWarningText({ ...local, threatWarnings: [page] }, now + 310000, true),
  ]) {
    assert.deepEqual(x.advisory, []);
    assert.deepEqual(x.findings, []);
  }
});
test('merchant allegations retain their evidence links, dates and limits without duplicating the current host', () => {
  const source = {
    label: 'Washington State complaint dataset',
    url: 'https://data.wa.gov/resource/fvrz-yz45.json',
  };
  const x = currentWarningText(
    {
      ...local,
      identity: 'observed',
      expectedHost: undefined,
      status: 'reports',
      outside:
        'Washington State records multiple recent complaints naming ' +
        local.host +
        ' about fulfillment or refunds. Review the dated allegations before buying.',
      details: ['Complaint period: 2025-11-08 through 2026-11-08.'],
      sources: [source],
    },
    now,
  );
  assert.equal(x.title, 'Merchant complaints');
  assert.deepEqual(x.sources, [source]);
  assert(x.findings.some((s) => s.includes('allegations')));
  assert(x.details.some((s) => s.includes('Complaint period')));
  assert(![...x.findings, ...x.details].some((d) => d.includes(local.host)));
  assert.deepEqual(x.advisory, []);
});
