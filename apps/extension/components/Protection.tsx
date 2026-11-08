import { useEffect, useRef, useState } from 'react';
import {
  nextProtectionExpiry,
  protectionOff,
  threatAccuracyNotice,
  threatFinding,
  threatWarningLinks,
  visibleProtection,
  type PanelView,
  type ProtectionPreferences,
  type ThreatReply,
  type ProtectionView,
} from '@safestep/contracts';
import type { usePanel } from './usePanel';
import { allWeb, pattern } from '../core/access';
import { protectionAddress } from '../sites/protection';
import { automaticThreatSubject } from '@safestep/contracts';
import {
  currentWarningText,
  warningPresentationKey,
  warningPortName,
} from '../sites/protection-warning';

type Send = ReturnType<typeof usePanel>['command'];
type Props = { v: PanelView; send: Send };
export function CurrentSiteWarning({ v, send }: Props) {
  const p = v.protection;
  if (!p?.caution || p.dismissed || p.origin !== v.origin) return null;
  return <PanelWarning key={warningPresentationKey(p)} p={p} tabId={v.tabId} send={send} />;
}
function PanelWarning({ p, tabId, send }: { p: ProtectionView; tabId: number; send: Send }) {
  const [folded, setFolded] = useState(false),
    root = useRef<HTMLElement>(null);
  const { doc, origin, revision, routeToken } = p;
  useEffect(() => {
    let closed = false,
      tries = 0,
      port: chrome.runtime.Port | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (closed || port || document.visibilityState !== 'visible') return;
      try {
        const channel = chrome.tabs.connect(tabId, { name: warningPortName, documentId: doc });
        port = channel;
        channel.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (port !== channel) return;
          port = undefined;
          if (!closed && document.visibilityState === 'visible' && tries++ < 3)
            timer = setTimeout(connect, 200 * tries);
        });
        channel.onMessage.addListener((msg) => {
          if (
            !closed &&
            msg?.op === 'show' &&
            msg.revision === revision &&
            msg.route === routeToken
          ) {
            setFolded(false);
            requestAnimationFrame(() => root.current?.focus());
          }
        });
        channel.postMessage({ op: 'present', doc, origin, revision, route: routeToken });
      } catch {
        port?.disconnect();
        port = undefined;
        if (!closed && tries++ < 3) timer = setTimeout(connect, 200 * tries);
      }
    };
    const posture = () => {
      if (document.visibilityState === 'visible') {
        tries = 0;
        connect();
      } else {
        clearTimeout(timer);
        port?.disconnect();
        port = undefined;
      }
    };
    document.addEventListener('visibilitychange', posture);
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', posture);
      port?.disconnect();
    };
  }, [tabId, doc, origin, revision, routeToken]);
  const copy = currentWarningText(p, Date.now(), folded);
  return (
    <section
      ref={root}
      tabIndex={-1}
      className="site-warning"
      data-security=""
      data-warning-mode={folded ? 'compact' : 'expanded'}
      aria-label="Current website warning"
    >
      <div role="status" aria-atomic="true">
        <strong>{copy.title}</strong>
        {folded ? (
          <p>{p.host}</p>
        ) : (
          <>
            <dl className="warning-hosts">
              {copy.rows.map((row) => {
                const mark = row.label === 'Here' ? copy.difference : null;
                return (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>
                      {mark ? (
                        <>
                          {row.value.slice(0, mark.start)}
                          <mark style={{ fontWeight: 700, textDecoration: 'underline' }}>
                            {row.value.slice(mark.start, mark.end)}
                          </mark>
                          {row.value.slice(mark.end)}
                        </>
                      ) : (
                        row.value
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </>
        )}
        {copy.findings.map((f) => (
          <p key={f}>{f}</p>
        ))}
      </div>
      {copy.advisory.map((a) => (
        <p key={a.url}>
          <a href={a.url} target="_blank" rel="noopener noreferrer">
            {a.label}
          </a>
        </p>
      ))}
      {!folded && (
        <details key={p.revision}>
          <summary>Details</summary>
          {copy.details.map((s) => (
            <p key={s}>{s}</p>
          ))}
          {copy.sources.map((s) => (
            <p key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.label}
              </a>
            </p>
          ))}
        </details>
      )}
      <button aria-expanded={!folded} onClick={() => setFolded(!folded)}>
        {folded ? 'Show warning' : 'Tuck warning'}
      </button>
      <button
        onClick={() =>
          void send({ kind: 'protection', action: { op: 'leave', revision: p.revision } })
        }
      >
        Leave page
      </button>
      <button
        onClick={() =>
          void send({ kind: 'protection', action: { op: 'dismiss', revision: p.revision } })
        }
      >
        Dismiss warning
      </button>
    </section>
  );
}
export function useVisibleProtection(view: ProtectionView | undefined) {
  const [tick, refresh] = useState(0);
  const now = Date.now();
  const expiry = view && nextProtectionExpiry(view, now);
  useEffect(() => {
    const update = () => refresh(n => n + 1);
    // Schedule against the display, so an idle worker or a closed panel
    // cannot prolong a provider warning. Recheck when Chrome wakes the tab.
    const timer = expiry ? setTimeout(update, Math.min(2147483647, Math.max(0, expiry - Date.now()))) : undefined;
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pageshow', update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pageshow', update);
    };
  }, [expiry, tick]);
  return view && visibleProtection(view, now);
}
export function ThreatLinks({r}:{r:ThreatReply}) {
  return <>{threatWarningLinks(r).map(link => <p key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a></p>)}</>;
}
export function ThreatCoverage({view,subject,documentId}:{view:PanelView;subject:string;documentId:string}) {
  const check=view.protection;
  const eligible=automaticThreatSubject(subject);
  if (!check || !eligible || check.doc!==documentId || check.origin!==view.origin ||
      new URL(eligible.url).origin!==check.origin) return null;
  const receipt=check.threat;
  const applies=receipt && receipt.purpose!=='target' && (
    receipt.scope==='page' ? eligible.scope==='page' && receipt.url===eligible.url :
      receipt.url===new URL(eligible.url).origin+'/');
  return <div data-security=""><strong>Website URL check</strong>
    <p>{applies ? threatFinding(receipt) : 'No current Google URL result for this source.'}</p>
    {applies && <><small>{receipt.source} · {new Date(receipt.checkedAt).toLocaleString()}</small><ThreatLinks r={receipt}/></>}
  </div>;
}
export function TargetProtection({v,send}:Props) {
  const target=v.protection?.destination;
  if(!target || v.protection?.origin!==v.origin) return null;
  return <section className="site-warning" data-security="" aria-label="Selected destination coverage">
    <strong>Selected {target.kind} destination</strong><p role="status">{target.message}</p>
    {target.result && <><ThreatLinks r={target.result}/>
      <details><summary>Details</summary><small>{target.result.source} · {new Date(target.result.checkedAt).toLocaleString()}</small></details></>}
    {target.limitedTicket && <button onClick={()=>void send({kind:'protection',action:{op:'allowLimitedTarget',
      revision:v.protection!.revision,ticket:target.limitedTicket!}})}>Accept limited coverage for this destination</button>}
  </section>;
}
function ThreatReceipt({r}:{r:ThreatReply}) {
  return <div><p>{threatFinding(r)}</p>
    <small>Source: {r.source} · {new Date(r.checkedAt).toLocaleString()}{r.expiresAt ? ' · match expires '+new Date(r.expiresAt).toLocaleString() : ''}</small>
    <ThreatLinks r={r} />
  </div>;
}
export function OutsideFindings({check,send}:{check?:ProtectionView;send:Send}) {
  const current=check?.threat;
  const warnings=check?.threatWarnings?.filter(r=>r.url!==current?.url || r.scope!==current?.scope || current.status!=='match') ?? [];
  return <>
    <h3>Known phishing or malware</h3>
    {current && <ThreatReceipt r={current}/>}
    {warnings.map(r=><ThreatReceipt key={r.scope+r.url} r={r}/>)}
    {check?.threatNotice && <p role="status">{check.threatNotice}</p>}
    {!current && !check?.threatNotice && <p>No Google Web Risk lookup was performed for this check.</p>}
    {check && (check.threatHome || check.threatPage) ? <details>
      <summary>Request one threat lookup</summary>
      <p>Choosing a button sends the displayed address to the paired service for a Google Web Risk lookup if enabled. The service does not send cookies or form contents.</p>
      <p>{threatAccuracyNotice}</p>
      {check.threatHome && <button onClick={()=>void send({kind:'protection',action:{op:'threat',scope:'root',revision:check.revision}})}>Check homepage only: {check.threatHome}</button>}
      {check.threatPage ? <button onClick={()=>void send({kind:'protection',action:{op:'threat',scope:'page',revision:check.revision}})}>Check exact page: {check.threatPage}</button> : <small>This page path is outside SafeStep’s public URL policy. A homepage result does not cover it.</small>}
    </details> : !check ? <small>To use outside checks, enable this site in Settings → Auto protection and pair the local service.</small> : <small>This address is not eligible to share with Google Web Risk.</small>}
    <h3>Merchant service evidence</h3>
    <p>{check?.outside ?? 'No current Washington complaint lookup. You can opt in through Auto protection.'}</p>
    {check && <>{!!check.sources.length && <small>Washington State Attorney General’s complaint dataset · checked {new Date(check.checkedAt).toLocaleString()}</small>}
      {check.details.map((d,i)=><p key={i}>{d}</p>)}
      {check.sources.map(s=><p key={s.url}><a href={s.url} rel="noreferrer" target="_blank">{s.label}</a></p>)}
    </>}
    <small>No licensed outside consumer-review feed is connected. Complaints are reported experiences, not findings of fraud.</small>
  </>;
}
export function ProtectionSettings({ v, send }: Props) {
  const saved = v.prefs.protection ?? protectionOff();
  const [scope, setScope] = useState(saved.scope),
    [outside, setOutside] = useState(saved.outside),
    [threatRoot, setThreatRoot] = useState(!!saved.threatRoot),
    [automatic, setAutomatic] = useState(saved.automaticUrlConsent===2),
    [budget, setBudget] = useState(saved.budget || 5),
    [notice, setNotice] = useState('');
  useEffect(() => {
    setScope(saved.scope);
    setOutside(saved.outside);
    setThreatRoot(!!saved.threatRoot);
    setAutomatic(saved.automaticUrlConsent===2);
    setBudget(saved.budget || 5);
  }, [saved.scope, saved.outside, saved.threatRoot, saved.automaticUrlConsent, saved.budget]);
  async function apply() {
    setNotice('');
    const site = scope === 'selected' ? v.origin : null;
    if (scope === 'selected' && !site) {
      setNotice('Open an ordinary website to enable protection for it.');
      return;
    }
    if (scope !== 'off' && (!Number.isInteger(budget) || budget < 1 || budget > 20)) {
      setNotice('Choose a budget from 1 to 20.');
      return;
    }
    try {
      if (
        scope !== 'off' &&
        !(await chrome.permissions.request({
          origins: scope === 'all' ? allWeb : [pattern(site!)],
        }))
      ) {
        setNotice(
          'Chrome declined the requested access. Your previous protection settings still apply.',
        );
        return;
      }
      await send({
        kind: 'protection',
        action: {
          op: 'configure',
          scope,
          site,
          outside: scope !== 'off' && outside,
          threatRoot: scope !== 'off' && threatRoot,
          ...(scope!=='off' && automatic ? {automaticUrlConsent:2 as const} : {}),
          budget: scope !== 'off' ? budget : 0,
        },
      });
    } catch {
      setNotice('Chrome could not grant that access. Try on a public website.');
    }
  }
  return (
    <section aria-label="Auto protection settings">
      <h2>Auto protection</h2>
      <p>Check the current address on arrival, even when the panel is closed.</p>
      <label>
        Check on arrival{' '}
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as ProtectionPreferences['scope'])}
        >
          <option value="off">Off</option>
          <option value="selected">Selected sites</option>
          <option value="all">All ordinary public websites</option>
        </select>
      </label>
      {scope === 'selected' && v.origin && <p>Apply to this site: {v.origin}</p>}
      {scope !== 'off' && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={outside}
              onChange={(e) => setOutside(e.target.checked)}
            />{' '}
            Look up outside merchant reports
          </label>
          <p>
            Send only the public hostname to the paired local service. It checks the Washington
            State Attorney General’s complaint dataset. Private pages are excluded.
          </p>
          <label className="check">
            <input type="checkbox" checked={threatRoot} onChange={e=>setThreatRoot(e.target.checked)} />{' '}
            Check the homepage with Google Web Risk on arrival
          </label>
          <p>Homepage-only sharing sends the public homepage address. For coverage of eligible paths and selected destinations, enable automatic public URL checks below.</p>
          <label className="check">
            <input type="checkbox" checked={automatic} onChange={e=>setAutomatic(e.target.checked)} />{' '}
            Allow automatic public URL checks with Google Web Risk
          </label>
          <p>On sites you grant, SafeStep can send eligible public page and destination URLs to Google through the paired service, even with the panel closed. Private routes, tokens, cookies and form values are excluded.</p>
          <p>{threatAccuracyNotice}</p>
          {(
            <label>
              Maximum new lookups per paired session{' '}
              <input
                type="number"
                min={1}
                max={20}
                value={budget || ''}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </label>
          )}
          <small>Merchant and legacy homepage checks share this allowance. Automatic public URL checks use the operator’s separate Web Risk limits.</small>
        </>
      )}
      <button onClick={() => void apply()}>Apply protection settings</button>
      <p role="status">
        {notice ||
          'Current setting: ' +
            (saved.scope === 'off'
              ? 'Off'
              : saved.scope === 'selected'
                ? 'Selected sites'
                : 'All ordinary public websites') +
            (saved.outside ? ' · Merchant reports on' : '') +
            (saved.automaticUrlConsent===2 ? ' · Automatic public URL checks on' : saved.threatRoot ? ' · Homepage threat checks on' : !saved.outside ? ' · Local checks only' : '')}
      </p>
      {saved.scope === 'selected' &&
        saved.sites.map((site) => (
          <div key={site}>
            <span>{site}</span>{' '}
            <button
              onClick={() => void send({ kind: 'protection', action: { op: 'removeSite', site } })}
            >
              Stop protecting {new URL(site).hostname}
            </button>
          </div>
        ))}
    </section>
  );
}
export function ProtectionStatus({ v, send, compact = false }: Props & { compact?: boolean }) {
  const check = v.protection;
  const [address, setAddress] = useState(''),
    [observed, setObserved] = useState('');
  if (compact && (!check?.caution || check.dismissed)) return null;
  return (
    <section aria-label="Website protection" data-security="">
      <h2>{check?.caution ? 'Website warning' : 'Website protection'}</h2>
      {check ? (
        <>
          <p>{check.address}</p>
          <p role="status">{check.outside}</p>
          {!compact && (
            <>
              <small>Observed {new Date(check.checkedAt).toLocaleString()}</small>
              {check.details.map((d, i) => (
                <p key={i}>{d}</p>
              ))}
              {check.sources.map((s) => (
                <p key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.label}
                  </a>
                </p>
              ))}
              <button
                onClick={() =>
                  void send({
                    kind: 'protection',
                    action: { op: 'recheck', revision: check.revision },
                  })
                }
              >
                Recheck protection
              </button>
            </>
          )}
          {check.caution && !check.dismissed && (
            <button
              onClick={() =>
                void send({
                  kind: 'protection',
                  action: { op: 'dismiss', revision: check.revision },
                })
              }
            >
              Dismiss warning
            </button>
          )}
        </>
      ) : (
        <p>Automatic coverage is unavailable on this page. Review Auto protection in Settings.</p>
      )}
      {!compact && (
        <details>
          <summary>Check an expected Amazon US address</summary>
          <p>
            Inspect a link’s address before opening it. Its eventual redirect destination is
            unknown.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const u = new URL(address);
                if (!['https:', 'http:'].includes(u.protocol)) throw Error();
                setObserved(protectionAddress(u.href, true).address);
              } catch {
                setObserved('Enter a complete public HTTP or HTTPS address.');
              }
            }}
          >
            <label>
              Amazon US address or link{' '}
              <input
                type="text"
                maxLength={2048}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setObserved('');
                }}
              />
            </label>
            <button type="submit">Inspect address</button>
          </form>
          <p role="status">{observed}</p>
        </details>
      )}
    </section>
  );
}
export function AmazonSellerStatus({ v }: { v: PanelView }) {
  if (!v.origin || protectionAddress(v.origin).identity !== 'amazon_us') return null;
  return (
    <section aria-label="Amazon US seller">
      <h2>Amazon US seller</h2>
      <p>
        Exact seller feedback is unavailable. SafeStep has no licensed source for shopper-facing
        Amazon seller data.
      </p>
      <p>
        Check the selected offer’s <strong>Sold by</strong> account on Amazon.{' '}
        <strong>Ships from</strong> identifies fulfillment. Brand and product ratings describe
        different subjects.
      </p>
      <small>
        SafeStep has not inspected an Amazon seller account, feedback period or review sample for
        this offer.
      </small>
    </section>
  );
}
