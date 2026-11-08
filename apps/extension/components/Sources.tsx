import { useState } from 'react';
import {
  Health,
  Subject,
  parseWire,
  type FeatureResult,
  type ReviewData,
} from '@safestep/contracts';
import { EvidenceCard } from './EvidenceCard';
export function Sources({ domain, review }: { domain: string | null; review?: ReviewData }) {
  const [health, setHealth] = useState<Health | null>(null),
    [note, setNote] = useState('No sources checked.');
  async function check() {
    setHealth(null);
    setNote('Checking local service…');
    try {
      const r = await fetch('http://127.0.0.1:4317/health', {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(3500),
      });
      if (!r.ok) throw Error();
      const h = parseWire(Health, await r.json());
      if (!h) throw Error();
      setHealth(h);
      setNote('Local service connected.');
    } catch {
      setNote('Local service unavailable. Page inspection still works.');
    }
  }
  // A missing-evidence card is not a provider result. Do not invent an example subject on restricted pages.
  const subject = Subject.safeParse({ kind: 'website_risk', domain });
  const result: FeatureResult | null = subject.success
    ? {
        featureId: 'site_trust',
        subject: subject.data,
        availability: review?.selection.kind === 'website' ? 'partial' : 'unavailable',
        finding:
          review?.selection.kind === 'website'
            ? 'Local website check: ' + review.status.replaceAll('_', ' ') + '.'
            : 'Use Check this website for current observations.',
        explanation:
          'Outside reviews and threat-list coverage appear separately in the website summary.',
        evidence: [],
        limitations: [],
        nextStep: '',
      }
    : null;
  return (
    <details>
      <summary>Sources &amp; coverage</summary>
      {result && <EvidenceCard result={result} />}
      <button onClick={check}>Check local service</button>
      <p role="status">{note}</p>
      {health && (
        <ul>
          {health.providers.map((p) => (
            <li key={p.provider}>
              {p.provider.replaceAll('_', ' ')} ·{' '}
              {p.status === 'not_configured'
                ? 'Not configured'
                : p.status === 'connector_unavailable'
                  ? 'Connector unavailable'
                  : 'Ready'}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
