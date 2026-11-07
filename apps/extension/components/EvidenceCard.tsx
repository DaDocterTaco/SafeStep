import type { FeatureResult } from '@safestep/contracts';

export function EvidenceCard({ result }: { result: FeatureResult }) {
  return (
    <article aria-label="Evidence">
      <h3>{result.subject.kind.replaceAll('_', ' ')}</h3>
      <strong>{result.finding}</strong>
      <p>{result.explanation}</p>
      {result.evidence.length === 0 && <p>No source coverage. No assessment available.</p>}
      {result.evidence.map((e) => (
        <div key={e.id}>
          <b>{e.source}</b> · {e.availability}
          <p>{e.finding}</p>
          <p>{e.coverage}</p>
          <small>
            {e.retrievedAt} · {e.freshness}
            {e.expiresAt ? ' · Expires ' + e.expiresAt : ''}
          </small>
          {e.sourceUrl && (
            <a href={e.sourceUrl} target="_blank" rel="noreferrer">
              View source
            </a>
          )}
        </div>
      ))}
      {result.limitations.map((s) => (
        <p key={s}>{s}</p>
      ))}
    </article>
  );
}
