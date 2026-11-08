import { openEvidenceLink } from './evidence-click';
import { useEffect, useRef, useState } from 'react';
import {
  parseWire,
  ShopAIReply,
  shoppingInput,
  shoppingInsights,
  textGroup,
  validatedShoppingExplanation,
  type ShoppingData,
  type ShoppingKind,
  type ShopView,
  type PanelView,
  type ShoppingExplanation,
} from '@safestep/contracts';
import type { z } from 'zod';
import type { usePanel } from './usePanel';
import { currentReview, storageKey, tokenPattern } from './Explain';
type Send = ReturnType<typeof usePanel>['command'];
const statuses: Record<ShoppingData['status'], string> = {
  session_limit: 'Session sample limit reached',
  reviews_available: 'Reviews in this sample',
  limited_evidence: 'Limited evidence',
  no_reviews_in_view: 'No reviews visible in this view',
  identity_uncertain: 'Identity could not be matched',
  source_unavailable: 'Source unavailable',
  unsupported: 'Unsupported source',
  loading: 'Source is loading',
  explicit_zero: 'Source reports zero reviews',
};
function ShoppingAI({ data }: { data: ShoppingData }) {
  const [message, setMessage] = useState(''),
    [result, setResult] = useState<z.infer<typeof ShoppingExplanation> | null>(null),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && storageKey in changes) {
        pending.current?.abort();
        setBusy(false);
        setResult(null);
        setMessage('Connection changed.');
      }
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      pending.current?.abort();
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  async function explain() {
    if (pending.current) return;
    const op = new AbortController();
    pending.current = op;
    setMessage('');
    setBusy(true);
    setResult(null);
    try {
      const token = (await chrome.storage.session.get(storageKey))[storageKey];
      if (typeof token !== 'string' || !tokenPattern.test(token)) {
        setMessage('Gemini unavailable. Connect the local service to add an explanation.');
        return;
      }
      if (!(await currentReview(data)) || op.signal.aborted) return;
      const input = shoppingInput(data);
      const response = await fetch('http://127.0.0.1:4317/v1/shopping/explain', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([op.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw Error();
      const reply = parseWire(ShopAIReply, await response.json());
      if (op.signal.aborted || !(await currentReview(data))) return;
      if (
        !reply ||
        reply.operationId !== input.operationId ||
        reply.bindingToken !== input.bindingToken
      )
        throw Error();
      const verified = validatedShoppingExplanation(reply.explanation, input);
      if (reply.status === 'available' && verified) setResult(verified);
      else setMessage('Gemini unavailable (' + reply.status.replaceAll('_', ' ') + ').');
    } catch {
      if (!op.signal.aborted) setMessage('Gemini unavailable. Your local findings are still here.');
    } finally {
      if (pending.current === op) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <details>
      <summary>Gemini explanation</summary>
      <p>Shares theme labels, public source and date coverage, and evidence IDs. The review text stays here.</p>
      <button disabled={busy} onClick={explain}>
        Explain this summary with Gemini
      </button>
      {busy && (
        <button
          onClick={() => {
            pending.current?.abort();
            pending.current = null;
            setBusy(false);
            setMessage('Explanation cancelled.');
          }}
        >
          Cancel explanation
        </button>
      )}
      <p role="status">{message}</p>
      {result && (
        <div>
          <b>Gemini</b>
          <p>{result.summary}</p>
          {[...result.strengths, ...result.concerns].map((x) => (
            <p key={x.theme}>
              {x.theme} [{x.ids.join(', ')}]
            </p>
          ))}
          <p>{result.limit}</p>
        </div>
      )}
    </details>
  );
}
export function ShoppingCard({ view, send, dismiss, request, compare }: {
  view: ShopView; send: Send; dismiss: () => void; request?:string; compare?:()=>void;
}) {
  const d = view.data,
    c = d.context,
    seller = d.kind === 'seller',
    insight = shoppingInsights(d,request), themes = insight.themes;
  const evidence = useRef<HTMLDetailsElement>(null);
  const openSource=(url:string)=>{
    const source=d.source===url?'source':d.more===url?'more':null;
    if(source)void send({kind:'openShopSource',subject:d.kind,operationId:d.binding.operationId,source});
  };
  function cite(id:string) {
    if(!evidence.current)return;
    evidence.current.open=true;
    const row=[...evidence.current.querySelectorAll<HTMLElement>('[data-record]')].find(e=>e.dataset.record===id);
    row?.focus();row?.scrollIntoView({block:'nearest'});
  }
  const fields = seller
    ? [
        [c.market === 'resell' ? 'Public shop ID' : 'Seller account', c.seller],
        ['Display name', c.display],
        ['Store slug', c.store],
        ['Member since', c.since],
        ['Listing', c.listing],
        ['Current item', c.title],
        ['Listing version or variant', c.variant],
        ['Listing condition', c.condition],
      ]
    : [
        ['Listing', c.listing],
        ['Catalog product', c.catalog],
        ['Product', c.title],
        ['ISBN', c.isbn],
        ['Format', c.format],
        ['Edition year', c.year],
        ['Selected version or edition', c.variant],
        ['Listing condition', c.condition],
        ['Listing seller', c.seller],
      ];
  const others = [...new Set(d.records.map((r) => r.listing).filter((l) => l && l !== c.listing))];
  if(c.practiceOffer) fields.push(['Marketplace region','US (labelled Amazon practice)'],['Simulated expected address',c.practiceOffer.marketplaceHost],['ASIN',c.practiceOffer.asin],['Selected offer ID',c.practiceOffer.offer],['Sold by · exact account',c.seller],['Ships from',c.practiceOffer.shipsFrom??'Unknown'],['Brand / manufacturer',c.practiceOffer.brand??'Unknown']);
  return (
    <article
      className="review shopping-card"
      onClickCapture={e=>openEvidenceLink(e,openSource)}
      onAuxClickCapture={e=>openEvidenceLink(e,openSource)}
      aria-label={seller ? 'Seller assessment' : 'Product assessment'}
    >
      <h3>{seller ? 'Seller assessment' : 'Product assessment'}</h3>
      {c.market === 'practice' && <strong>Practice · synthetic evidence</strong>}
      <p role="status">{statuses[d.status]}</p>
      <dl>
        {fields
          .filter(([, v]) => v)
          .map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <p>{d.note}</p>
      {d.metrics.some((m, i) =>
        d.metrics.slice(0, i).some((other) => other.label === m.label && other.value !== m.value),
      ) && <p>Source sections report different values. Each value retains its own stated scope.</p>}
      {d.metrics.map((m, i) => (
        <p key={i}>
          <b>{m.label}</b> {m.approximate ? '≈ ' : ''}
          {m.value}
          {m.unit === 'stars' ? ' / ' + m.scale : m.unit === 'percent' ? '%' : ''}
          <small>{m.period}</small>
        </p>
      ))}
      {d.badge && <p>Marketplace badge · {d.badge}</p>}
      {themes.length > 0 && (
        <div>
          <h4>What the sample mentions</h4>
          {themes.map((t) => (
            <p key={t.label + t.tone}>
              <b>
                {t.tone === 'strength' ? 'Strength' : 'Concern'} · {t.label}
              </b>
              <br />
              {t.ids.length === 1
                ? 'One distinct comment'
                : 'Recurring in ' + t.ids.length + ' distinct comments'}{' '}
              {t.ids.slice(0,3).map(id=><button key={id} aria-label={'Read evidence '+id} onClick={()=>cite(id)}>[{id}]</button>)}
            </p>
          ))}
        </div>
      )}
      {insight.mixed.length>0 && <p>Comments describe both positive and negative experiences with {insight.mixed.join(', ')}. Read the cited accounts above.</p>}
      {insight.requirement && <p>{insight.requirement} {d.source && <a data-source-url="" href={d.source} target="_blank" rel="noreferrer">Catalogue evidence</a>}</p>}
      {insight.conditionLimit && <p>{insight.conditionLimit}</p>}
      {insight.requested.map(r=><p key={r.label}><b>Your requested {r.label}</b> · {
        r.strengths.length||r.concerns.length ? r.strengths.length+' distinct positive and '+r.concerns.length+' distinct negative comments in '+r.scope+'.' :
          'No specific supporting or opposing comment identified in '+r.scope+'.'
      } {Array.from(new Set([...r.strengths,...r.concerns])).slice(0,4).map(id=><button key={id} onClick={()=>cite(id)}>[{id}]</button>)}</p>)}
      {insight.versions && <p>Of the inspected reviews, {insight.versions.same.length} name the selected version or edition, {insight.versions.other.length} name another, and {insight.versions.unstated.length} leave the version unstated.</p>}
      {d.records.length>0 && <p>Published dates in this sample: {insight.recent.length} within 90 days of capture, {insight.older.length} older, {insight.undated.length} without a comparable date.</p>}
      {insight.repeated>0 && <p>{insight.repeated} repeated written {insight.repeated===1?'entry was':'entries were'} counted once per text group for themes. Repeated wording alone does not establish whether reviews are authentic.</p>}
      <p>
        <b>Coverage</b> · {d.scope}. {d.filter}. {d.records.length} inspected,{' '}
        {d.records.filter((r) => r.text).length} with readable text,{' '}
        {new Set(d.records.filter((r) => r.text).map(textGroup)).size} distinct text groups.{' '}
        {d.limited ? 'Additional content is outside this sample.' : ''}
      </p>
      {seller && (
        <p>
          {d.records.filter((r) => r.automated).length} marked automated · filter{' '}
          {d.automatedFilter}. {others.length} other linked listing{others.length === 1 ? '' : 's'}
          {others.length ? ' · ' + others.join(', ') : ''}
        </p>
      )}
      <small>
        Captured {new Date(d.captured).toLocaleString()} ·{' '}
        {c.market === 'practice'
          ? 'Practice page'
          : c.market === 'resell'
            ? 'Resell.store public API'
            : c.market === 'mozilla'
              ? 'Mozilla Add-ons API'
              : 'Current tab'}
      </small>
      {d.records.length > 0 && (
        <details ref={evidence}>
          <summary>Review evidence ({d.records.length})</summary>
          {d.records.map((r) => (
            <p key={r.id} data-record={r.id} tabIndex={-1}>
              <b>[{r.id}]</b> {r.text || 'No shareable review text.'}
              <small>
                {[
                  r.rating !== null ? r.rating + '/5' : null,
                  r.published ?? 'Date unknown',
                  r.precision,
                  r.version,
                  r.condition,
                  r.automated ? 'Marked automated' : null,
                  r.verified ? 'Platform identifies a purchase' : null,
                  r.soldBy ? 'Sold by ' + r.soldBy : null,
                  r.listing ? 'Listing ' + r.listing : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </p>
          ))}
        </details>
      )}
      {view.history.length > 1 && (
        <details>
          <summary>Recent captures of this same view</summary>
          {view.history.map((h) => (
            <small key={h.at}>
              {new Date(h.at).toLocaleTimeString()} · {h.records} inspected
            </small>
          ))}
        </details>
      )}
      {d.source && (
        <a data-source-url="" href={d.source} target="_blank" rel="noreferrer">
          View source
        </a>
      )}{' '}
      {d.more && d.more !== d.source && (
        <a data-source-url="" href={d.more} target="_blank" rel="noreferrer">
          Open related source
        </a>
      )}
      {d.target && (
        <button
          onClick={() =>
            send({ kind: 'shopReveal', subject: d.kind, operationId: d.binding.operationId })
          }
        >
          Show evidence on page
        </button>
      )}
      <button onClick={() => send({ kind: 'shop', subject: d.kind })}>
        Refresh current evidence
      </button>
      <button onClick={dismiss}>Dismiss details</button>
      {d.records.length > 0 && <ShoppingAI key={d.binding.operationId} data={d} />}
      {compare && (c.listing || c.catalog) && <button onClick={compare}>Compare alternatives for this item</button>}
    </article>
  );
}
export function Shopping({ v, send }: { v: PanelView; send: Send }) {
  const [busy, setBusy] = useState<ShoppingKind | null>(null);
  const buttons = useRef<Partial<Record<ShoppingKind, HTMLButtonElement | null>>>({});
  const sequence = useRef(0);
  const allowed = v.access === 'temporary' || v.access === 'site';
  async function inspect(k: ShoppingKind) {
    const n = ++sequence.current;
    setBusy(k);
    try {
      await send({ kind: 'shop', subject: k });
    } finally {
      if (sequence.current === n) setBusy(null);
    }
  }
  function dismiss(k: ShoppingKind) {
    sequence.current++;
    setBusy(null);
    buttons.current[k]?.focus({ preventScroll: true });
    void send({ kind: 'shopDismiss', subject: k });
  }
  return (
    <section aria-label="Shopping checks">
      <h2>Shopping checks</h2>
      {(['seller', 'product'] as const).map((k) => (
        <button
          key={k}
          ref={(el) => {
            buttons.current[k] = el;
          }}
          disabled={!allowed}
          onClick={() => inspect(k)}
        >
          Check {k}
        </button>
      ))}
      {busy && (
        <div role="status">
          Checking the {busy} source… <button onClick={() => dismiss(busy)}>Cancel analysis</button>
        </div>
      )}
      {(['seller', 'product'] as const).map(
        (k) =>
          v.shopping?.[k] && (
            <ShoppingCard key={k} view={v.shopping[k]!} send={send} dismiss={() => dismiss(k)} />
          ),
      )}
    </section>
  );
}
