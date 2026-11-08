import {
  activeThreat,
  threatCategoryText,
  threatWarningLinks,
  type ProtectionView,
} from '@safestep/contracts';
import { observeAddress } from './address';

export const warningPortName = 'safestep-current-warning';
export function warningPresentationKey(v: ProtectionView) {
  return JSON.stringify([
    v.doc,
    v.routeToken,
    v.revision,
    v.identity,
    v.expectedHost,
    v.status === 'reports',
    (v.threatWarnings ?? []).map((r) => [r.scope, r.url, r.categories]),
  ]);
}

/** One presentation for the page edge and the warning outside the transcript. */
export function currentWarningText(view: ProtectionView, now = Date.now(), compact = false) {
  const matches = (view.threatWarnings ?? []).filter(
    (r) => activeThreat(r, now) && r.purpose !== 'target' && new URL(r.url).origin === view.origin,
  );
  const exact = matches.find((r) => r.scope === 'page');
  const subject = exact?.url ?? matches[0]?.url ?? view.host;
  const different = !!view.expectedHost && view.identity !== 'amazon_us';
  const sameHost = different && view.expectedHost === view.host;
  const rows: { label: string; value: string }[] = [];
  if (different && !sameHost) rows.push({ label: 'Expected', value: view.expectedHost! });
  rows.push({ label: sameHost ? 'Expected and here' : 'Here', value: subject });

  const title = matches.length
    ? 'Possible URL risk'
    : different
      ? sameHost
        ? 'Unexpected address'
        : 'Different website'
      : view.status === 'reports'
        ? 'Merchant complaints'
        : 'Check this address';
  const findings: string[] = [];
  if (different && matches.length) findings.push('The address differs from the expected website.');
  if (different && (sameHost || view.host.endsWith('.' + view.expectedHost)))
    findings.push('The expected address requires HTTPS without a custom port or user information.');
  if (view.identity === 'unusual')
    findings.push(
      view.address.includes('user information')
        ? 'This address contains user information before its hostname.'
        : 'This HTTP connection is unencrypted.',
    );
  const threatFindings = matches.map(
    (match) =>
      'Google Web Risk reported possible ' +
      threatCategoryText(match) +
      (match.scope === 'root' ? ' for the homepage only.' : ' for this exact page.'),
  );
  findings.push(...threatFindings);
  if (matches.length) findings.push('Avoid downloads and entering information here.');
  const receipt = view.threat;
  if (
    !matches.length &&
    receipt &&
    receipt.purpose !== 'target' &&
    new URL(receipt.url).origin === view.origin
  ) {
    const coverage = receipt.scope === 'root' ? 'the homepage only' : 'this exact page';
    findings.push(
      receipt.status === 'no_match'
        ? 'Google Web Risk returned no threat listing for ' + coverage + '.'
        : 'No current threat result is available for ' + coverage + '.',
    );
  }

  if (view.status === 'reports') {
    // The matched legal name remains visible when it differs from the current host.
    findings.push(view.outside.replace('naming ' + view.host + ' about', 'about this merchant’s'));
    findings.push(
      'These complaints are allegations. A case status does not establish fault or a refund.',
    );
  } else if (
    view.status === 'local' &&
    !view.threat &&
    view.outside === 'Outside reports are off. Only the current address was checked.'
  ) {
    findings.push('Address only. Outside reputation checks are off.');
  } else if (
    view.status === 'checking' &&
    view.outside === 'Checking public merchant reports for ' + view.host + '.'
  ) {
    findings.push('Checking public merchant reports.');
  } else {
    findings.push(
      view.outside === 'Outside reports are off. Only the current address was checked.'
        ? 'Merchant reports are off.'
        : view.outside,
    );
  }

  const details = new Set<string>();
  if (different) {
    details.add(
      view.expectedHost === 'amazon.com'
        ? 'Expected · SafeStep’s built-in Amazon US address rule.'
        : 'Expected · SafeStep’s expected-site rule.',
    );
    if (!matches.length) findings.push('Check before sharing information.');
  }
  details.add('Here · Current browser address.');
  if (!matches.length && view.status !== 'reports')
    details.add('Local address check · ' + new Date(view.checkedAt).toLocaleString());
  if (view.status === 'reports')
    details.add(
      'Washington State Attorney General · checked ' + new Date(view.checkedAt).toLocaleString(),
    );
  for (const r of matches)
    details.add(
      r.source +
        ' · ' +
        (r.scope === 'root' ? 'Homepage' : 'Exact page') +
        ' checked ' +
        new Date(r.checkedAt).toLocaleString() +
        (r.expiresAt ? ' · expires ' + new Date(r.expiresAt).toLocaleString() : ''),
    );
  for (const text of view.details) {
    if (
      text ===
      'These are consumer allegations categorized by the state. An open or closed case does not establish fault, a refund, or current merchant behavior.'
    )
      continue;
    if (!findings.includes(text)) details.add(text);
  }
  const advisory = new Map(
    matches.flatMap((r) => threatWarningLinks(r, now)).map((link) => [link.url, link]),
  );
  let difference: { start: number; end: number } | null = null;
  if (different) {
    const identity = observeAddress(view.origin, view.origin, view.expectedHost ?? null);
    const expected = observeAddress('https://' + view.expectedHost, view.origin, null);
    const host = identity.host,
      domain = identity.domain;
    if (
      host === view.host &&
      domain &&
      expected.domain &&
      domain !== expected.domain &&
      (host === domain || host.endsWith('.' + domain))
    ) {
      const hostStart = subject.indexOf(host);
      if (hostStart >= 0) {
        const end = hostStart + host.length;
        difference = { start: end - domain.length, end };
      }
    }
  }
  return {
    title,
    passiveLocalStrip:
      compact &&
      !matches.length &&
      view.status !== 'reports' &&
      ['deceptive', 'mismatch', 'unusual'].includes(view.identity),
    rows,
    findings: [...new Set(compact ? threatFindings : findings)],
    details: [...details],
    sources: view.sources,
    advisory: [...advisory.values()],
    difference,
  };
}
