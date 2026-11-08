import { useRef, useState } from 'react';
import { OutsideFindings } from './Protection';
import {
  signalText,
  type PanelView,
  type FileProfile,
  type ReviewData,
  type SourceCoverage,
} from '@safestep/contracts';
import type { usePanel } from './usePanel';
import { products, packageLabel } from '../sites/downloads';
import { explainAddress } from '../sites/address-copy';
import { Explain } from './Explain';
import { Reveal } from './Guidance';
const statuses: Record<ReviewData['status'], string> = {
  reported_threat: 'Threat source reported a match',
  warning_signs: 'Warning signs found',
  limited_information: 'Limited information',
  no_known_warning_in_checked_sources: 'No warning found in the checked sources',
};
function Source({ source }: { source: SourceCoverage }) {
  const reviews = source.kind === 'business_reviews';
  const state = {
    unavailable: 'Unavailable',
    no_coverage: 'No coverage',
    wrong_business: 'Different business',
    zero_reviews: 'Zero reviews',
    stale: 'Expired data',
    matched: 'Match',
    no_match: 'No match',
  }[source.state];
  return (
    <div>
      <strong>{reviews ? 'Business review service' : 'Threat-list coverage'}</strong>
      <p>
        {source.source === 'labelled_fixture' ? 'Labelled fixture · ' : ''}
        {state}
      </p>
      <small>
        {reviews ? 'Business: ' : 'HTTPS homepage only: '}
        {source.subject}
      </small>
      <small>
        Coverage checked {new Date(source.observedAt).toLocaleTimeString()}
        {source.expiresAt ? ' · expires ' + new Date(source.expiresAt).toLocaleTimeString() : ''}
      </small>
    </div>
  );
}
export function Reviews({
  v,
  send,
  resultOnly = false,
}: {
  v: PanelView;
  send: ReturnType<typeof usePanel>['command'];
  resultOnly?: boolean;
}) {
  const [product, setProduct] = useState<FileProfile | ''>(''),
    [pkg, setPkg] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const siteButton = useRef<HTMLButtonElement>(null),
    fileButton = useRef<HTMLButtonElement>(null),
    title = useRef<HTMLHeadingElement>(null);
  const d = v.review,
    allowed = ['site', 'temporary'].includes(v.access);
  async function check(kind: 'website' | 'download') {
    setMessage('');
    if (kind === 'download') {
      if (!product || !pkg) {
        setMessage('Choose the product and the Windows package you want.');
        return;
      }
      if (pkg !== 'x64' && pkg !== product) {
        setMessage('Download guidance supports Windows x64 EXE for the selected product.');
        return;
      }
      if (v.task && !v.task.adaptive?.authorized && ['showing_step', 'awaiting_user', 'inspecting'].includes(v.task.state)) {
        setMessage('Pause the current task before outlining another control.');
        return;
      }
    }
    setBusy(true);
    try {
      await send({
        kind: 'review',
        selection: kind === 'website' ? { kind } : { kind, profile: product as FileProfile },
      });
    } finally {
      setBusy(false);
    }
  }
  function changed() {
    setMessage('');
    if (d?.selection.kind === 'download') void send({ kind: 'reviewDismiss' });
  }
  const site = d?.selection.kind === 'website';
  const protection = d && v.protection?.doc===d.binding.documentId && v.protection.origin===d.binding.origin ? v.protection : undefined;
  const observedFile=d?.candidates.find(c=>c.ref===d.selected && c.publisherPath && c.address.host);
  const fileURL=observedFile?'https://'+observedFile.address.host+observedFile.publisherPath:null;
  const proposed=protection?.destination?.kind==='download'?protection.destination.result:undefined;
  const receipt=site?(protection?.threatWarnings?.[0]??protection?.threat):
    proposed && fileURL && (proposed.url===fileURL || (proposed.scope==='root' && proposed.url===new URL(fileURL).origin+'/'))?proposed:undefined;
  return (
    <section aria-label="Website and download checks">
      {!resultOnly && <>
      <button ref={siteButton} disabled={!allowed || busy} onClick={() => check('website')}>
        Check this website
      </button>
      <details>
        <summary>Download help</summary>
        <label>
          Product
          <select
            value={product}
            onChange={(e) => {
              changed();
              setProduct(e.target.value as FileProfile | '');
              setPkg('');
            }}
          >
            <option value="">Choose a product</option>
            {(Object.keys(products) as FileProfile[]).map((p) => (
              <option key={p} value={p}>
                {p.startsWith('winscp_') ? packageLabel(p) : products[p].name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Platform and package
          <select
            value={pkg}
            onChange={(e) => {
              changed();
              setPkg(e.target.value);
            }}
          >
            <option value="">Choose a package</option>
            {product && product.startsWith('winscp_') ? <option value={product}>{products[product].package}</option> :
              <option value="x64">Windows x64 · EXE</option>}
            <option value="x86">Windows x86</option>
            <option value="arm">Windows ARM64</option>
            <option value="mac">macOS</option>
          </select>
        </label>
        <button ref={fileButton} disabled={!allowed || busy} onClick={() => check('download')}>
          Identify button
        </button>
      </details>
      </>}
      {message && <p role="status">{message}</p>}
      {busy && <p role="status">Checking this document…</p>}
      {v.reviewStale && !d && (
        <p role="status">The page or check changed. Check again for current findings.</p>
      )}
      {d && (
        <article className="review" aria-label={site ? 'Website summary' : 'Download comparison'}>
          <h2 className="guide-heading" ref={title} tabIndex={-1}>
            {site ? 'Website summary' : 'Download comparison'}
          </h2>
          {d.fixture && <strong>Labelled practice fixture</strong>}
          <p className="hostname">{d.binding.origin}</p>
          <small>Observed {new Date(d.at).toLocaleString()} · current top-level document</small>
          <h3>
            {site
              ? protection?.threatWarnings?.length ? 'There is a current threat-list warning' : statuses[d.status]
              : d.fileState === 'identified'
                ? 'Button identified'
                : d.fileState === 'incomplete'
                  ? 'Could not verify a unique button'
                  : d.fileState === 'ambiguous'
                    ? 'More than one possible control'
                    : d.fileState === 'unsupported'
                      ? 'Unsupported page'
                      : 'Matching control unavailable'}
          </h3>
          {site ? (
            <>
              <strong>Website address</strong>
              <p>
                {d.address.host} {d.address.domain ? ' · ' + d.address.domain : ''}
              </p>
              <small>{explainAddress(d.address)}</small>
              <strong>Local warning signs</strong>
              {d.cleanup&&<p>{d.cleanup.count} regions hidden by SafeStep. Earlier local observations from {new Date(d.cleanup.at).toLocaleTimeString()} are included.</p>}
              <ul>
                {d.observations
                  .filter((o) => o.code !== 'host')
                  .map((o) => (
                    <li key={o.id}>
                      {signalText[o.code]} {o.detail} [{o.id}]
                    </li>
                  ))}
              </ul>
              {d.observations.length === 1 && (
                <p>No local warning observed in the inspected portion.</p>
              )}
            </>
          ) : (
            <>
              <p>
                {d.fileState === 'identified'
                  ? 'Ready for your review. You control the final click.'
                  : d.fileState === 'incomplete'
                    ? 'The page scan reached its limit. Check the publisher and package yourself or refresh the check.'
                    : d.fileState === 'unsupported'
                      ? 'Open the official page for the chosen product.'
                      : 'Refresh after checking the product and page.'}
              </p>
              {d.selection.kind === 'download' && (
                <small>{packageLabel(d.selection.profile)}</small>
              )}
              {d.selected && d.placement && (
                <Reveal
                  position={d.placement}
                  targetLabel={d.candidates.find(c => c.ref === d.selected)?.label}
                  show={() => send({ kind: 'reviewReveal', operationId: d.binding.operationId })}
                  keyboardFocus={() => title.current?.focus({ preventScroll: true })}
                />
              )}
              <ul>
                {d.candidates.map((c) => (
                  <li key={c.ref}>
                    <b>{c.label}</b>
                    {c.packageHint && ' · ' + c.packageHint}
                    <div className="hostname">
                      {c.address.host ?? 'Unknown destination'}
                      {c.publisherPath}
                    </div>
                    <small>{signalText[c.reason]}</small>
                  </li>
                ))}
              </ul>
              <small>
                Later mirror or CDN redirects, file signatures and file contents are unchecked.
              </small>
            </>
          )}
          {site && d.fixture && d.sources.map((s) => <Source key={s.kind} source={s} />)}
          {site && !d.fixture && <OutsideFindings check={protection} send={send}/>}
          <details>
            <summary>Sources and coverage</summary>
            {!site && d.sources.map((s) => <Source key={s.kind} source={s} />)}
            <p>
              Source: local public page controls. {d.limited ? 'Inspection limit reached. ' : ''}
              {d.frames ? 'Embedded frames skipped. ' : ''}Private fields are excluded.
            </p>
          </details>
          <Explain key={d.binding.operationId+':'+(receipt?.checkedAt??'local')} data={d} receipt={receipt}/>
          <button
            onClick={() => {
              if (site) void check('website');
              else if (d.selection.kind === 'download')
                void send({ kind: 'review', selection: d.selection });
            }}
          >
            Refresh check
          </button>
          <button
            onClick={() => {
              (site ? siteButton : fileButton).current?.focus();
              void send({ kind: 'reviewDismiss' });
            }}
          >
            Dismiss check
          </button>
        </article>
      )}
    </section>
  );
}
