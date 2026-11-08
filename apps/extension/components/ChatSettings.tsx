import { useLayoutEffect, useRef, useState } from 'react';
import { ChatRouteHealth, type FeatureId, type PanelView } from '@safestep/contracts';
import { pattern } from '../core/access';
import { ProtectionSettings } from './Protection';
import { ConnectAI } from './Explain';
import { Sources } from './Sources';
import { featureNames, type Send } from './ChatCards';

export const helpExamples: Record<FeatureId, string> = {
  visual_guidance: 'Follow highlights for a supported page task.',
  url_identity: 'Inspect the actual address and the destination of a link.',
  site_trust: 'Check local warning signs and the available sources.',
  download_guidance: 'Find the official VLC or 7-Zip Windows x64 button.',
  seller_assessment: 'Read feedback received by the identified seller.',
  product_assessment: 'Check reviews for the current product and edition.',
  automatic_navigation: 'Preview a read-only route, then decide whether to start.',
  page_cleanup: 'See what can be hidden, then apply or restore it.',
  shopping_alternatives: 'Compare current offers using your requirements.',
};
export function AccessButton({ v, send }: { v: PanelView; send: Send }) {
  const [error, setError] = useState('');
  const site = v.origin;
  const enabled = !!site && v.prefs.sites.includes(site);
  function request() {
    if (!site) return;
    setError('');
    // This browser request must start synchronously inside the real button click.
    void chrome.permissions.request({ origins: [pattern(site)] }).then(
      (ok) => send({ kind: ok ? 'siteGranted' : 'siteDenied' }),
      () => setError('Chrome could not grant access to this site.'),
    );
  }
  return (
    <div className="site-access">
      {site && (
        <p>
          Site access for <strong>{new URL(site).hostname}</strong>
        </p>
      )}
      {enabled ? (
        <button onClick={() => void send({ kind: 'siteRemoved' })}>Remove site access</button>
      ) : (
        <button disabled={!site} onClick={request}>
          Enable on this site
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function SecondarySurface({
  surface,
  v,
  send,
  close,
  choose,
  clear,
}: {
  surface: 'Settings' | 'Help';
  v: PanelView;
  send: Send;
  close: () => void;
  choose: (feature: FeatureId, text: string) => void;
  clear: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [health, setHealth] = useState('');
  async function checkHealth() {
    try {
      const response = await fetch('http://127.0.0.1:4317/v1/chat/health', {
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw Error();
      const data = ChatRouteHealth.parse(await response.json());
      setHealth(
        data.configured
          ? (data.model ?? 'Configured model') +
              ' · Chat routing ' +
              (data.verified ? 'verified' : 'unverified') +
              (data.lastStatus ? ' · ' + data.lastStatus.replaceAll('_', ' ') : '')
          : 'Chat routing is unavailable. Local tools still work.',
      );
    } catch {
      setHealth('The local routing service is unavailable.');
    }
  }
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [surface]);
  return (
    <aside
      className="secondary"
      aria-label={surface}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="secondary-heading">
        <h2 ref={heading} tabIndex={-1}>
          {surface}
        </h2>
        <button onClick={close} aria-label={'Close ' + surface}>
          Close
        </button>
      </div>
      {surface === 'Help' ? (
        <>
          <p>Choose a tool for this page. Some free-text requests need a paired AI service.</p>
          <ul className="help-tools">
            {(Object.keys(helpExamples) as FeatureId[]).map((feature) => (
              <li key={feature}>
                <button
                  data-feature={feature}
                  onClick={() => choose(feature, featureNames[feature])}
                >
                  {featureNames[feature]}
                </button>
                <small>{helpExamples[feature]}</small>
              </li>
            ))}
          </ul>
          <p>
            Seller and product checks use supported Resell and Mozilla sources. Amazon US address
            checks are local; exact Amazon seller feedback is unavailable.
          </p>
        </>
      ) : (
        <>
          <AccessButton v={v} send={send} />
          <ProtectionSettings v={v} send={send} />
          <details>
            <summary>Reading and conversation</summary>
            <label className="check">
              <input
                type="checkbox"
                checked={v.prefs.largeText}
                onChange={(e) => void send({ kind: 'textSize', large: e.target.checked })}
              />{' '}
              Larger text
            </label>
            <p>Each tab keeps a bounded conversation for this browser session.</p>
            <button onClick={clear}>New chat</button>
          </details>
          <ConnectAI />
          <button onClick={() => void checkHealth()}>Check routing availability</button>
          {health && <p role="status">{health}</p>}
          <details>
            <summary>Sources and diagnostics</summary>
            <Sources domain={v.origin ? new URL(v.origin).hostname : null} review={v.review} />
          </details>
          <details>
            <summary>Clear SafeStep data</summary>
            <p>Clear local preferences, tab access and tasks for SafeStep.</p>
            <button onClick={() => void send({ kind: 'forget' })}>Clear SafeStep data</button>
          </details>
        </>
      )}
    </aside>
  );
}
