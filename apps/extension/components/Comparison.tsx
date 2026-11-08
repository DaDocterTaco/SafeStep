import { openEvidenceLink } from './evidence-click';
import { useEffect, useRef, useState } from 'react';
import {
  comparableSubtotal,
  comparisonFromWords,
  comparisonQuestion,
  type CompareAction,
  type ComparePriority,
  CompareSettings,
  type CompareView,
  type PanelView,
} from '@safestep/contracts';
import type { usePanel } from './usePanel';
type Send = ReturnType<typeof usePanel>['command'];
type Offer = NonNullable<CompareView['baseline']>;
type Candidate = CompareView['candidates'][number];
type Assessment = Offer['sellerEvidence'];
const modes: Record<CompareSettings['mode'], string> = {
  same_product_other_sellers: 'Same product, other sellers',
  similar_products: 'Similar products',
  compare_selected: 'Compare selected offers',
};
const priorityLabels: Record<ComparePriority, string> = {
  cost: 'Comparable cost',
  feature: 'Feature fit',
  product: 'Product feedback',
  seller: 'Seller feedback',
  condition: 'Condition',
};
const fitLabels: Record<Candidate['fit'], string> = {
  confirmed: 'Confirmed match',
  needs_checking: 'Needs checking',
  incompatible: 'Incompatible',
  identity_uncertain: 'Identity uncertain',
  unavailable: 'Unavailable',
};
const statusLabels: Record<CompareView['status'], string> = {
  idle: 'Review requirements',
  needs_baseline: 'Choose a supported item',
  clarify: 'Clarification needed',
  searching: 'Searching',
  checking_candidates: 'Checking options',
  comparing: 'Comparing',
  ready: 'Comparison ready',
  partial: 'Partial coverage',
  no_matches: 'No suitable alternatives',
  only_baseline: 'Only the original found',
  needs_checking: 'Needs checking',
  source_unavailable: 'Source unavailable',
  unsupported: 'Unsupported source',
  stale: 'Evidence needs refresh',
  cancelled: 'Comparison cancelled',
  paused: 'Comparison paused',
};
const human = (v: string) => v.replaceAll('_', ' ');
const time = (v: string) => new Date(v).toLocaleString();
function price(value: string | null, currency: string | null, unknown: string) {
  return value === null ? unknown : value + ' ' + (currency ?? '· currency unconfirmed');
}
function shipping(o: Offer) {
  if (o.cost.basis === 'not_applicable') return 'Not applicable';
  if (o.cost.shippingScope && /pickup/i.test(o.cost.shippingScope)) return 'Pickup only';
  return [price(o.cost.shipping, o.cost.currency, 'Shipping unknown'), o.cost.shippingScope]
    .filter(Boolean)
    .join(' · ');
}
function evidenceLink(raw: string) {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.hash) return null;
    if (
      u.protocol === 'https:' &&
      ((u.host === 'api.resell.store' && u.pathname.startsWith('/v1/')) ||
        (u.host === 'addons.mozilla.org' &&
          (/^\/api\/v5\//.test(u.pathname) || /^\/en-US\/firefox\/addon\//.test(u.pathname))))
    )
      return u.href;
    if (
      u.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(u.hostname) &&
      u.pathname.startsWith('/comparison-lab/')
    )
      return u.href;
  } catch {
    /* Missing or unsupported source. */
  }
  return null;
}
function ReviewEvidence({ data, kind }: { data: Assessment; kind: 'Product' | 'Seller' }) {
  if (!data)
    return (
      <p>{kind === 'Product' ? 'Product reviews not provided' : 'Seller feedback not provided'}</p>
    );
  const href = evidenceLink(data.source);
  return (
    <div className="compare-evidence">
      <p>{data.subject}</p>
      {data.metric && (
        <p>
          {data.metric.label} · {data.metric.value}/{data.metric.scale} ·{' '}
          {data.metric.count === null ? 'Count unknown' : data.metric.count + ' ratings'} ·{' '}
          {data.metric.period}
        </p>
      )}
      <p>
        {data.sample} inspected
        {data.groups !== undefined ? ' · ' + data.groups + ' distinct groups' : ''} ·{' '}
        {time(data.captured)}
      </p>
      {data.scope && <small>{data.scope}</small>}
      {data.metrics?.map((m, i) => (
        <small key={i}>
          {m.label} · {m.value}
        </small>
      ))}
      {data.summary.map((s, i) => (
        <p key={'s' + i}>{s}</p>
      ))}
      {data.limits.map((s, i) => (
        <small key={'l' + i}>{s}</small>
      ))}
      {!!data.records?.length && (
        <details>
          <summary>Inspected feedback ({data.records.length})</summary>
          {data.records.map((record, i) => (
            <p key={i}>
              {record.text || 'No shareable text supplied'}
              <small>
                {[
                  record.date ?? 'Date unknown',
                  record.version,
                  record.rating !== null ? record.rating + '/5' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </p>
          ))}
        </details>
      )}
      {href ? (
        <a data-source-url="" href={href} target="_blank" rel="noreferrer">
          View {kind.toLowerCase()} evidence
        </a>
      ) : (
        <small>{data.source}</small>
      )}
    </div>
  );
}
function OfferFacts({ offer: o }: { offer: Offer }) {
  return (
    <dl className="compare-fields">
      <dt>Source and item ID</dt>
      <dd>
        {o.market} · {o.id}
      </dd>
      <dt>Catalog identity</dt>
      <dd>{o.catalog ?? 'Not supplied'}</dd>
      {o.market === 'mozilla' && (
        <div>
          <dt>Developer listed by Mozilla</dt>
          <dd>{o.attributes.developer ?? 'Not provided'}</dd>
        </div>
      )}
      <dt>Seller</dt>
      <dd>{o.seller ? [o.sellerName, o.seller].filter(Boolean).join(' · ') : 'Not provided'}</dd>
      {Object.entries(o.attributes)
        .filter(([k]) => o.market !== 'mozilla' || k !== 'developer')
        .map(([k, v]) => (
          <div key={k}>
            <dt>{human(k)}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      <dt>Quantity</dt>
      <dd>{o.quantity ?? 'Unknown'}</dd>
      <dt>Item price</dt>
      <dd>
        {o.cost.text || price(o.cost.amount, o.cost.currency, 'Not provided')} ·{' '}
        {human(o.cost.basis)}
      </dd>
      <dt>Currency</dt>
      <dd>
        {o.cost.currency ?? 'Currency unconfirmed'}{' '}
        {o.cost.currencySource && <small>{o.cost.currencySource}</small>}
      </dd>
      <dt>Shipping</dt>
      <dd>{shipping(o)}</dd>
      <dt>Mandatory fees</dt>
      <dd>{price(o.cost.fees, o.cost.currency, 'Unknown')}</dd>
      <dt>Tax / duty</dt>
      <dd>{o.cost.tax ?? 'Unknown'}</dd>
      <dt>Availability</dt>
      <dd>
        {human(o.availability)} · {time(o.captured)}
      </dd>
    </dl>
  );
}
function CandidateCard({
  candidate: c,
  stale,
  included,
  toggle,
  open,
  remove,
}: {
  candidate: Candidate;
  stale: boolean;
  included: boolean;
  toggle: () => void;
  open: () => void;
  remove: () => void;
}) {
  const o = c.offer;
  return (
    <article aria-label={'Alternative ' + o.title} className="compare-card" data-offer-id={o.id}>
      <h3>{o.title}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={included}
          disabled={stale}
          onChange={toggle}
          aria-label={'Compare ' + o.title + ' · ' + (o.seller ?? o.id)}
        />
        Include in comparison
      </label>
      <strong>
        {stale ? 'Captured option' : fitLabels[c.fit]}
        {!stale && c.recommended ? ' · Recommended' : ''}
      </strong>
      <small>
        {o.seller ?? 'Seller not provided'} · {time(o.captured)}
      </small>
      <p>
        {o.cost.text || price(o.cost.amount, o.cost.currency, 'Price not provided')} · {shipping(o)}
      </p>
      {!stale && c.subtotal !== null && (
        <p>Known pre-tax subtotal · {price(c.subtotal, o.cost.currency, 'Unknown')}</p>
      )}
      {!stale && c.savings !== null && (
        <p>
          Lower listed pre-tax subtotal · {price(c.savings, o.cost.currency, 'Unknown')}
          {c.savingsPercent !== null ? ' (' + c.savingsPercent + '%)' : ''}
        </p>
      )}
      {c.matched.length > 0 && <p>Matched · {c.matched.map(human).join(', ')}</p>}
      {!stale && c.reasons.map((s, i) => <p key={'r' + i}>{human(s)}</p>)}
      {c.tradeoffs.map((s, i) => (
        <p key={'t' + i}>{human(s)}</p>
      ))}
      <details>
        <summary>Attributes and sources</summary>
        <OfferFacts offer={o} />
        <h4>Product reviews</h4>
        <ReviewEvidence kind="Product" data={o.productEvidence} />
        <h4>Seller feedback</h4>
        <ReviewEvidence kind="Seller" data={o.sellerEvidence} />
      </details>
      <div className="actions">
        <button disabled={stale} onClick={open}>
          Open offer
        </button>
        <button disabled={stale} onClick={remove}>Remove option</button>
      </div>
    </article>
  );
}
function Priorities({
  value,
  onChange,
}: {
  value: ComparePriority[];
  onChange: (p: ComparePriority[]) => void;
}) {
  const move = (i: number, delta: number) => {
    const order = [...value];
    [order[i], order[i + delta]] = [order[i + delta]!, order[i]!];
    onChange(order);
  };
  return (
    <fieldset className="compare-priorities">
      <legend>Priorities, highest first</legend>
      <ol>
        {value.map((p, i) => (
          <li key={p}>
            {priorityLabels[p]}{' '}
            <button
              type="button"
              disabled={!i}
              aria-label={'Move ' + priorityLabels[p] + ' up'}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>{' '}
            <button
              type="button"
              disabled={i === value.length - 1}
              aria-label={'Move ' + priorityLabels[p] + ' down'}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              disabled={value.length === 1}
              aria-label={'Remove ' + priorityLabels[p] + ' priority'}
              onClick={() => onChange(value.filter((k) => k !== p))}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {value.length < Object.keys(priorityLabels).length && (
        <label>
          Add priority
          <select
            value=""
            onChange={(e) =>
              e.target.value && onChange([...value, e.target.value as ComparePriority])
            }
          >
            <option value="">Choose a priority</option>
            {Object.entries(priorityLabels)
              .filter(([p]) => !value.includes(p as ComparePriority))
              .map(([p, label]) => (
                <option key={p} value={p}>
                  {label}
                </option>
              ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}
function SettingsForm({
  settings: s,
  baseline,
  change,
  find,
  interpret,
  confirmRequest = false,
}: {
  settings: CompareSettings;
  baseline: Offer;
  change: (settings: CompareSettings) => void;
  find: () => void;
  interpret: () => void;
  confirmRequest?: boolean;
}) {
  const [error, report] = useState('');
  const attrs = [
    ...new Set([
      ...Object.keys(baseline.attributes),
      'product',
      'model',
      'edition',
      'printing',
      'nib',
      'platform',
      'feature',
      'condition',
      'quantity',
      'delivery',
    ]),
  ];
  function submit(ai: boolean) {
    const question=comparisonQuestion(s);
    if(!ai && question)return report(question);
    if (!s.goal.trim() || (!ai && !s.query.trim() && s.mode !== 'compare_selected'))
      return report('Enter your goal and a public search term.');
    if (!ai && s.mode === 'similar_products' && !s.allowedDifferences.length)
      return report('Choose which attributes may differ.');
    if (
      s.hard.some((x) => !x.field.trim() || !x.value.trim()) ||
      s.preferred?.some((x) => !x.field.trim() || !x.value.trim())
    )
      return report('Complete or remove empty requirement and preference rows.');
    if (
      s.budget &&
      (!/^\d+(?:\.\d+)?$/.test(s.budget.amount) || !/^[A-Z]{3}$/.test(s.budget.currency))
    )
      return report('Enter a budget amount and its three-letter currency.');
    const validation = CompareSettings.safeParse(s);
    if (!validation.success) {
      const field = validation.error.issues[0]?.path[0];
      return report(
        typeof field === 'string'
          ? 'Check ' + human(field) + ' and use only public product details.'
          : 'Check your comparison requirements.',
      );
    }
    report('');
    if (ai) interpret();
    else find();
  }
  return (
    <form
      className="comparison-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <label>
        Comparison goal
        <input
          maxLength={240}
          value={s.goal}
          onChange={(e) => change({ ...s, goal: e.target.value })}
        />
      </label>
      <button type="button" onClick={() => submit(true)}>
        Interpret goal with Gemini
      </button>
      <label>
        Comparison mode
        <select
          value={s.mode}
          onChange={(e) => change({ ...s, mode: e.target.value as CompareSettings['mode'] })}
        >
          {Object.entries(modes).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Public search terms
        <input
          maxLength={100}
          value={s.query}
          onChange={(e) => change({ ...s, query: e.target.value })}
        />
      </label>
      <datalist id="compare-attributes">
        {attrs.map((a) => (
          <option key={a}>{a}</option>
        ))}
      </datalist>
      <fieldset>
        <legend>Hard requirements</legend>
        {s.hard.map((x, i) => (
          <div className="requirement" key={i}>
            <label>
              Required attribute {i + 1}
              <input
                list="compare-attributes"
                value={x.field}
                maxLength={64}
                onChange={(e) =>
                  change({
                    ...s,
                    hard: s.hard.map((a, j) => (j === i ? { ...a, field: e.target.value } : a)),
                  })
                }
              />
            </label>
            <label>
              Required value {i + 1}
              <input
                value={x.value}
                maxLength={120}
                onChange={(e) =>
                  change({
                    ...s,
                    hard: s.hard.map((a, j) => (j === i ? { ...a, value: e.target.value } : a)),
                  })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={x.exclude}
                onChange={(e) =>
                  change({
                    ...s,
                    hard: s.hard.map((a, j) => (j === i ? { ...a, exclude: e.target.checked } : a)),
                  })
                }
              />
              Exclude this value
            </label>
            <button
              type="button"
              aria-label={'Remove requirement ' + (i + 1)}
              onClick={() => change({ ...s, hard: s.hard.filter((_, j) => j !== i) })}
            >
              Remove requirement
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={s.hard.length >= 10}
          onClick={() =>
            change({ ...s, hard: [...s.hard, { field: '', value: '', exclude: false }] })
          }
        >
          Add requirement
        </button>
      </fieldset>
      {s.mode === 'similar_products' && (
        <fieldset>
          <legend>Allowed differences</legend>
          {attrs
            .filter((a) => !['quantity', 'delivery'].includes(a))
            .map((a) => (
              <label className="check" key={a}>
                <input
                  type="checkbox"
                  checked={s.allowedDifferences.includes(a)}
                  onChange={(e) =>
                    change({
                      ...s,
                      allowedDifferences: e.target.checked
                        ? [...s.allowedDifferences, a]
                        : s.allowedDifferences.filter((k) => k !== a),
                    })
                  }
                />
                {human(a)}
              </label>
            ))}
        </fieldset>
      )}
      <label>
        Required quantity
        <input
          type="number"
          min={1}
          max={1000}
          value={s.quantity}
          onChange={(e) => change({ ...s, quantity: Number(e.target.value) })}
        />
      </label>
      <fieldset>
        <legend>Budget</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={!!s.budget}
            onChange={(e) =>
              change({
                ...s,
                budget: e.target.checked ? { amount: '', currency: '', basis: 'item' } : null,
              })
            }
          />
          Apply a budget
        </label>
        {s.budget && (
          <>
            <label>
              Budget amount
              <input
                inputMode="decimal"
                value={s.budget.amount}
                maxLength={20}
                onChange={(e) => change({ ...s, budget: { ...s.budget!, amount: e.target.value } })}
              />
            </label>
            <label>
              Budget currency
              <input
                value={s.budget.currency}
                placeholder="e.g. USD"
                maxLength={3}
                onChange={(e) =>
                  change({ ...s, budget: { ...s.budget!, currency: e.target.value.toUpperCase() } })
                }
              />
            </label>
            <label>
              Budget basis
              <select
                value={s.budget.basis}
                onChange={(e) =>
                  change({
                    ...s,
                    budget: { ...s.budget!, basis: e.target.value as 'item' | 'subtotal' },
                  })
                }
              >
                <option value="item">Item price</option>
                <option value="subtotal">Known pre-tax subtotal</option>
              </select>
            </label>
          </>
        )}
      </fieldset>
      <details>
        <summary>Soft preferences</summary>
        {(s.preferred ?? []).map((x, i) => (
          <div key={i}>
            <label>
              Preferred attribute {i + 1}
              <input
                list="compare-attributes"
                value={x.field}
                onChange={(e) =>
                  change({
                    ...s,
                    preferred: s.preferred!.map((a, j) =>
                      j === i ? { ...a, field: e.target.value } : a,
                    ),
                  })
                }
              />
            </label>
            <label>
              Preferred value {i + 1}
              <input
                value={x.value}
                onChange={(e) =>
                  change({
                    ...s,
                    preferred: s.preferred!.map((a, j) =>
                      j === i ? { ...a, value: e.target.value } : a,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              onClick={() => change({ ...s, preferred: s.preferred!.filter((_, j) => i !== j) })}
            >
              Remove preference
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={(s.preferred?.length ?? 0) >= 6}
          onClick={() =>
            change({ ...s, preferred: [...(s.preferred ?? []), { field: '', value: '' }] })
          }
        >
          Add preference
        </button>
      </details>
      <Priorities value={s.priorities} onChange={(p) => change({ ...s, priorities: p })} />
      {confirmRequest && <label className="check"><input type="checkbox" required /> I have included my required features, budget and exclusions.</label>}
      {error && <p role="alert">{error}</p>}
      <button className="primary">Find options</button>
    </form>
  );
}
function ComparisonTable({ view }: { view: CompareView }) {
  const base = view.baseline!;
  const list = [base, ...view.candidates.map((c) => c.offer)];
  const rows: [string, (o: Offer, i: number) => React.ReactNode][] = [
    ['Source identity', (o) => o.market + ' · ' + o.id],
    ['Catalog', (o) => o.catalog ?? 'Not supplied'],
    ...(base.market === 'mozilla'
      ? [
          [
            'Developer listed by Mozilla',
            (o: Offer) => o.attributes.developer ?? 'Not provided',
          ] as [string, (o: Offer) => string],
        ]
      : []),
    ['Seller', (o) => o.seller ?? 'Not provided'],
    ...[...new Set(list.flatMap((o) => Object.keys(o.attributes)))]
      .filter((k) => base.market !== 'mozilla' || k !== 'developer')
      .map(
        (k) =>
          [human(k), (o: Offer) => o.attributes[k] ?? 'Unknown'] as [string, (o: Offer) => string],
      ),
    ['Quantity', (o) => o.quantity ?? 'Unknown'],
    ['Item price', (o) => o.cost.text || price(o.cost.amount, o.cost.currency, 'Not provided')],
    ['Shipping', shipping],
    ['Known fees', (o) => price(o.cost.fees, o.cost.currency, 'Unknown')],
    ['Pre-tax subtotal', (o) => price(comparableSubtotal(o), o.cost.currency, 'Unknown')],
    ['Tax / duty', (o) => o.cost.tax ?? 'Unknown'],
    ['Product reviews', (o) => <ReviewEvidence data={o.productEvidence} kind="Product" />],
    ['Seller feedback', (o) => <ReviewEvidence data={o.sellerEvidence} kind="Seller" />],
    ['Fit', (_o, i) => (i ? fitLabels[view.candidates[i - 1]!.fit] : 'Original')],
    ['Source time', (o) => time(o.captured)],
  ];
  return (
    <div
      className="comparison-scroll"
      tabIndex={0}
      role="region"
      aria-label="Side-by-side comparison"
    >
      <table>
        <caption>Original and selected alternatives</caption>
        <thead>
          <tr>
            <th scope="col">Attribute</th>
            {list.map((o, i) => (
              <th scope="col" key={o.id}>
                {i ? 'Alternative' : 'Original'}
                <br />
                {o.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, f], n) => (
            <tr key={key + n}>
              <th scope="row">{key}</th>
              {list.map((o, i) => (
                <td key={o.id}>{f(o, i)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Comparison({ v, send, original, initialMode }: {
  v: PanelView;
  send: Send;
  original?: string;
  initialMode?: CompareSettings['mode'];
}) {
  const c = v.comparison,
    active = ['temporary', 'site'].includes(v.access),
    heading = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState<CompareSettings | null>(null),
    [editing, setEditing] = useState(false),
    [selected, setSelected] = useState(false),
    [omitted, setOmitted] = useState<string[]>([]),
    [url, setURL] = useState('');
  useEffect(() => {
    setDraft(null);
    setEditing(false);
    setSelected(false);
    setOmitted([]);
    setURL('');
  }, [c?.id]);
  const focus = () => heading.current?.focus({ preventScroll: true });
  const submit = (a: CompareAction) => void send({ kind: 'compare', action: a });
  const busy =
    c &&
    (['searching', 'checking_candidates', 'comparing'].includes(c.status) ||
      c.ai === 'Asking Gemini…');
  const stale =
    c &&
    (['stale', 'paused', 'cancelled'].includes(c.status) ||
      Date.now() - Date.parse(c.at) >= 300000);
  const canOpen = active && !busy && !stale;
  function simple(op: 'clear' | 'cancel' | 'refresh' | 'more' | 'keep' | 'explain') {
    if (!c) return;
    focus();
    submit({ op, session: c.id, version: c.version });
  }
  function edit() {
    if (!c) return;
    setDraft(c.settings);
    setEditing(true);
    setSelected(false);
    focus();
    submit({ op: 'edit', session: c.id, version: c.version, settings: c.settings });
  }
  const showEditor =
    !!c?.baseline && (editing || (!busy && ['idle', 'clarify'].includes(c.status)));
  const customRequest = !!original && !/^compare (?:alternatives|products|sellers)[.!]?$/i.test(original.trim());
  let initialSettings = c?.settings;
  if (c && !editing && showEditor && original) {
    initialSettings = comparisonFromWords({...c.settings,mode:initialMode ?? c.settings.mode}, original);
  }
  function commit(op: 'find' | 'interpret') {
    if (!c || !initialSettings) return;
    const settings = draft ?? initialSettings;
    setEditing(false);
    setDraft(null);
    setSelected(false);
    focus();
    submit({ op, settings, session: c.id, version: c.version });
  }
  return (
    <section aria-label="Compare alternatives" className="comparison" data-shopping-evidence=""
      onClickCapture={e=>openEvidenceLink(e,url=>{if(c)void send({kind:'compare',action:{op:'openSource',session:c.id,version:c.version,url}});})}
      onAuxClickCapture={e=>openEvidenceLink(e,url=>{if(c)void send({kind:'compare',action:{op:'openSource',session:c.id,version:c.version,url}});})}>
      <h2 ref={heading} tabIndex={-1} className="guide-heading">
        Compare alternatives
      </h2>
      {!c && (
        <button
          disabled={!active}
          onClick={() => {
            focus();
            submit({ op: 'prepare' });
          }}
        >
          Find alternatives
        </button>
      )}
      {c && (
        <>
          <p role="status" data-testid="comparison-status" data-revision={c.version}>
            <strong>{statusLabels[c.status]}</strong> · {c.message}
          </p>
          {c.baseline && (
            <article
              className="compare-card original"
              aria-label="Original item"
              data-offer-id={c.baseline.id}
            >
              <small>Original item</small>
              <h3>{c.baseline.title}</h3>
              <small>
                {c.baseline.market} · {time(c.baseline.captured)}
              </small>
              <details>
                <summary>Original item details</summary>
                <OfferFacts offer={c.baseline} />
                <ReviewEvidence kind="Product" data={c.baseline.productEvidence} />
                <ReviewEvidence kind="Seller" data={c.baseline.sellerEvidence} />
              </details>
            </article>
          )}
          {c.ai && <p role="status">Gemini · {human(c.ai)}</p>}
          {showEditor && initialSettings && (
            <>
            {original && <p className="comparison-original"><strong>Your request</strong><br/>{original}<br/><small>Review the required features, exclusions, delivery and budget before finding options.</small></p>}
            <SettingsForm
              baseline={c.baseline!}
              settings={draft ?? initialSettings}
              confirmRequest={customRequest}
              change={setDraft}
              find={() => commit('find')}
              interpret={() => commit('interpret')}
            />
            </>
          )}
          {!showEditor && c.baseline && (
            <>
              <h3>Your requirements</h3>
              <p>{c.settings.goal}</p>
              <small>
                {modes[c.settings.mode]} · Quantity {c.settings.quantity} ·{' '}
                {c.settings.priorities.map((p) => priorityLabels[p]).join(', ')}
              </small>
              {c.settings.hard.map((h, i) => (
                <small key={i}>
                  {h.exclude ? 'Exclude' : 'Require'} {human(h.field)} · {h.value}
                </small>
              ))}
              {c.settings.allowedDifferences.length > 0 && (
                <small>
                  Allowed differences · {c.settings.allowedDifferences.map(human).join(', ')}
                </small>
              )}
              {c.settings.budget && (
                <small>
                  Budget · {c.settings.budget.amount} {c.settings.budget.currency} (
                  {human(c.settings.budget.basis)})
                </small>
              )}
              <button disabled={!active} onClick={edit}>
                Edit requirements
              </button>
            </>
          )}
          {busy && <button onClick={() => simple('cancel')}>Cancel comparison</button>}
          {c.baseline && !showEditor && !busy && (
            <>
              <p>
                <strong>Search coverage</strong> · {c.coverage.searched} returned ·{' '}
                {c.coverage.checked} detail-checked · {c.coverage.excluded} excluded ·{' '}
                {c.coverage.batches} batches
              </p>
              {c.searchSource && evidenceLink(c.searchSource) && (
                <a data-source-url="" href={evidenceLink(c.searchSource)!} target="_blank" rel="noreferrer">
                  View discovery source
                </a>
              )}
              {!!c.excludedReasons?.length && (
                <details>
                  <summary>Excluded options</summary>
                  <ul>
                    {c.excludedReasons.map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                </details>
              )}
              {c.candidates.map((option) => (
                <CandidateCard
                  key={option.offer.id}
                  candidate={option}
                  included={!omitted.includes(option.offer.id)}
                  toggle={() =>
                    setOmitted((ids) =>
                      ids.includes(option.offer.id)
                        ? ids.filter((id) => id !== option.offer.id)
                        : [...ids, option.offer.id],
                    )
                  }
                  stale={!canOpen}
                  open={() =>
                    submit({ op: 'open', id: option.offer.id, session: c.id, version: c.version })
                  }
                  remove={() => {
                    focus();
                    submit({
                      op: 'remove',
                      id: option.offer.id,
                      session: c.id,
                      version: c.version,
                    });
                  }}
                />
              ))}
              {c.candidates.length > 0 && (
                <>
                  <Priorities
                    value={c.settings.priorities}
                    onChange={(priorities) => {
                      focus();
                      submit({ op: 'sort', priorities, session: c.id, version: c.version });
                    }}
                  />
                  <button
                    disabled={!selected && c.candidates.every((x) => omitted.includes(x.offer.id))}
                    aria-expanded={selected}
                    onClick={() => setSelected(!selected)}
                  >
                    Compare selected
                  </button>
                  {selected &&
                    (stale ? (
                      <p>Refresh evidence to compare current values.</p>
                    ) : (
                      <ComparisonTable
                        view={{
                          ...c,
                          candidates: c.candidates.filter((x) => !omitted.includes(x.offer.id)),
                        }}
                      />
                    ))}
                </>
              )}
              <div className="actions">
                <button disabled={!active} onClick={() => simple('refresh')}>
                  Refresh evidence
                </button>
                {c.coverage.more && (
                  <button
                    disabled={!canOpen || c.coverage.batches >= 3}
                    onClick={() => simple('more')}
                  >
                    More results
                  </button>
                )}
                <button onClick={() => simple('keep')}>Keep original</button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  focus();
                  submit({ op: 'add', url: url.trim(), session: c.id, version: c.version });
                  setURL('');
                }}
              >
                <label>
                  Supported offer URL
                  <input
                    type="url"
                    value={url}
                    maxLength={500}
                    onChange={(e) => setURL(e.target.value)}
                  />
                </label>
                <button disabled={!canOpen || !url.trim() || c.candidates.length >= 3}>
                  Add offer
                </button>
              </form>
              {c.candidates.length > 0 && (
                <button disabled={!canOpen} onClick={() => simple('explain')}>
                  Explain comparison with Gemini
                </button>
              )}
              {c.explanation?.map((s, i) => {
                const id=c.explanationOffers?.[i];
                const offer=id && [c.baseline,...c.candidates.map(v=>v.offer)].find(o=>o?.id===id);
                return <p key={i}>{s}{offer && <button disabled={!canOpen} onClick={()=>submit({op:'open',session:c.id,version:c.version,id:offer.id})}>
                  View source for {offer.title}
                </button>}</p>;
              })}
            </>
          )}
          {!c.baseline && !busy && (
            <button disabled={!active} onClick={() => submit({ op: 'prepare' })}>
              Check current item
            </button>
          )}
          <button onClick={() => simple('clear')}>Close comparison</button>
        </>
      )}
    </section>
  );
}
