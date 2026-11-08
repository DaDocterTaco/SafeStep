// All data returned here is synthetic, and exists only on this loopback test server.
const scenarios = {
  exact: ['original', 'better', 'better', 'lower', 'own-shop', 'wrong-edition', 'bundle', 'sold'],
  fit: ['original', 'alternative', 'unknown-fit', 'incompatible', 'better'],
  'long-text': ['original', 'long-item', 'better'],
  'price-bases': ['bid', 'from', 'range', 'coupon', 'installment', 'trade-in', 'subscription'],
  money: [
    'original',
    'lower',
    'missing-shipping',
    'mixed-currency',
    'ambiguous',
    'pickup',
    'bid',
    'subscription',
    'free',
    'fees',
  ],
  empty: [],
  'baseline-only': ['original'],
  incompatible: ['incompatible', 'wrong-edition', 'sold'],
  unknown: ['unknown-fit', 'missing-shipping', 'ambiguous'],
  partial: ['error', 'better', 'lower'],
  'partial-restored': ['error', 'better', 'lower'],
  unavailable: [],
  pagination: Array.from({ length: 38 }, (_, i) => 'page-' + (i + 1)),
  delayed: ['better', 'lower'],
  identity: ['conflict', 'better'],
  hostile: ['hostile', 'bad-link', 'better'],
  changed: ['original', 'better', 'lower'],
  expired: ['original', 'better', 'lower'],
  rate: [],
  forbidden: [],
  timeout: [],
  redirect: [],
  malformed: [],
  oversize: [],
};
const known = new Set([
  ...Object.values(scenarios).flat(),
  'fees',
  'zero-original',
  'subscription',
  'from',
  'conditional',
  'range',
  'other-scale',
  'sparse',
  'unknown-quantity',
  'old-version',
]);
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
function assessment(subject, source, seller, good = false) {
  const sparse = subject === 'sparse.shop';
  const count = sparse ? 1 : good ? 45 : 22;
  return {
    subject,
    source,
    captured: new Date().toISOString(),
    sample: sparse ? 1 : 3,
    groups: sparse ? 1 : 2,
    scope: seller
      ? 'Received as seller · labelled first page'
      : 'Catalog-wide product reviews · across editions',
    metric: {
      label: seller ? 'Average shop rating' : 'Average product rating',
      value: good ? 4.8 : 4.1,
      scale: 5,
      period: 'Synthetic last 12 months',
      count,
    },
    metrics: [
      { label: 'Published ratings', value: String(count) },
      { label: 'Written review count', value: 'Unavailable' },
    ],
    records: [
      {
        date: '2026-10-01T13:00:00Z',
        version: seller ? null : '2025 edition',
        rating: 4,
        text: seller ? 'Secure packaging.' : 'The pen writes smoothly.',
      },
      ...(sparse
        ? []
        : [
            {
              date: '2025-11-01T13:00:00Z',
              version: seller ? null : '2024 edition',
              rating: 3,
              text: seller ? 'Secure packaging.' : 'The pen writes smoothly.',
            },
            {
              date: '2024-10-01T13:00:00Z',
              version: seller ? null : '2023 edition',
              rating: 3,
              text: seller
                ? 'Carefully wrapped in transit.'
                : 'The older edition isn’t easy to use.',
            },
          ]),
    ],
    summary: sparse
      ? []
      : seller
        ? ['Packaging · strength · two distinct sampled comments']
        : [
            'Duplicates and earlier-edition feedback included in sample; no recurring product strength established.',
          ],
    limits: [
      'Labelled synthetic evidence.',
      seller
        ? 'Seller feedback describes service, not this item.'
        : 'Catalog evidence shared by every offer with this catalog key.',
    ],
  };
}
function buildOffer(id, origin, state) {
  const canonical = (key) => origin + '/comparison-lab/' + key,
    changed = state.scenario === 'changed' || state.changed;
  const o = {
    market: 'practice',
    id,
    title: 'Practice Meridian fountain pen',
    url: canonical(id),
    family: 'fountain pen',
    catalog: 'meridian:one',
    seller: 'original.shop',
    sellerName: 'Practice Stationery',
    attributes: {
      brand: 'Meridian',
      model: 'One',
      nib: 'fine',
      condition: 'excellent',
      edition: '2025',
      format: 'physical',
      accessories: 'box',
      platform: 'physical',
      purpose: 'fountain pen',
    },
    quantity: 1,
    availability: 'available',
    captured: new Date().toISOString(),
    cost: {
      text: 'USD 24.95',
      amount: '24.95',
      currency: 'USD',
      currencySource: 'Labelled fixture ISO field',
      shipping: '5.05',
      shippingScope: 'Fixture domestic delivery',
      fees: '1.00',
      tax: null,
      basis: 'exact',
    },
    productEvidence: null,
    sellerEvidence: null,
  };
  if (id !== 'original' && id !== 'zero-original' && id !== 'own-shop') {
    o.seller = 'other.shop';
    o.sellerName = 'Practice Stationery';
  }
  if (id === 'better' || id === 'lower' || id === 'own-shop') {
    o.cost.amount = id === 'better' ? '20.10' : '19.99';
    o.cost.shipping = id === 'lower' ? '12.00' : '3.05';
    o.cost.fees = '1.00';
  }
  if (id === 'better' && changed) {
    o.cost.amount = '17.10';
    o.availability = 'sold';
  }
  if (id === 'alternative') {
    o.title = 'Practice Vista everyday fountain pen';
    o.catalog = 'vista:two';
    Object.assign(o.attributes, { brand: 'Vista', model: 'Two', nib: 'extra fine' });
  }
  if (id === 'unknown-fit') delete o.attributes.nib;
  if (id === 'incompatible') {
    o.catalog = 'meridian:broad';
    o.attributes.nib = 'broad';
    o.attributes.platform = 'desktop only';
  }
  if (id === 'wrong-edition') o.attributes.edition = '2012';
  if (id === 'bundle') {
    o.quantity = 2;
    o.attributes.accessories = 'two pens without box';
  }
  if (id === 'unknown-quantity') o.quantity = null;
  if (id === 'sold') o.availability = 'sold';
  if (id === 'free' || id === 'zero-original') {
    o.cost.amount = '0';
    o.cost.shipping = '0';
    o.cost.shippingScope = 'Explicit free delivery';
    o.cost.fees = '0';
  }
  if (id === 'fees') o.cost.fees = null;
  if (id === 'mixed-currency') o.cost.currency = 'CAD';
  if (id === 'ambiguous') {
    o.cost.currency = null;
    o.cost.currencySource = null;
  }
  if (id === 'missing-shipping') {
    o.cost.shipping = null;
    o.cost.shippingScope = null;
  }
  if (id === 'pickup') {
    o.cost.shipping = '0';
    o.cost.shippingScope = 'Pickup only';
  }
  if (['bid', 'subscription', 'from', 'range', 'conditional'].includes(id)) o.cost.basis = id;
  const priceTerms = { coupon: 'Member coupon required', installment: 'Installment payment', 'trade-in': 'Trade-in required' }[id];
  if (priceTerms) o.cost.basis = 'conditional';
  o.cost.text =
    (o.cost.currency ?? '$') +
    ' ' +
    o.cost.amount +
    (o.cost.basis === 'exact' ? '' : ' · ' + (priceTerms ?? o.cost.basis));
  if (id === 'sparse') o.seller = 'sparse.shop';
  if (id === 'lower') o.seller = 'budget.shop';
  if (id === 'other-scale') o.seller = 'scale.shop';
  if (id === 'long-item') {
    o.title='Practice Meridian fountain pen with a fine nib, presentation case, original packaging and documented edition for the comparison';
    o.sellerName='Practice Stationery and Fountain Pen Exchange, Independent Store Account';
  }
  if (id === 'original' && state.variant) o.attributes.nib = 'medium';
  if (state.scenario === 'expired') o.captured = new Date(Date.now() - 360000).toISOString();
  o.productEvidence = assessment(
    o.catalog,
    canonical(o.catalog === 'meridian:one' ? 'original' : id),
    false,
    id === 'alternative',
  );
  const sellerPage = {
    'other.shop': 'better',
    'budget.shop': 'lower',
    'original.shop': 'original',
    'sparse.shop': 'sparse',
    'scale.shop': 'other-scale',
  }[o.seller];
  o.sellerEvidence = assessment(o.seller, canonical(sellerPage), true, o.seller === 'other.shop');
  if (id === 'other-scale') {
    o.sellerEvidence.metric.scale = 100;
    o.sellerEvidence.metric.value = 97;
    o.sellerEvidence.metric.period = 'Synthetic last 30 days';
  }
  if (id === 'hostile') {
    o.title = 'Sponsored practice option';
    o.attributes.promoted = 'true';
  }
  if (id === 'conflict') o.id = 'different-subject';
  return o;
}
export function comparisonFixture() {
  const state = { scenario: 'exact', changed: false, variant: false };
  return async (req, res, pathname) => {
    if (!/^\/comparison-lab(?:\/|$)/.test(pathname)) return false;
    const host = req.headers.host ?? '';
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(host)) {
      res.writeHead(403).end();
      return true;
    }
    const origin = 'http://' + host,
      url = new URL(req.url, origin);
    const send = (body, code = 200) => {
      res
        .writeHead(code, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        })
        .end(JSON.stringify(body));
      return true;
    };
    if (pathname === '/comparison-lab/state') {
      if (req.method !== 'POST' || req.headers.origin !== origin)
        return send({ error: 'Local fixture controls only' }, 403);
      const s = url.searchParams.get('scenario');
      if (s && Object.hasOwn(scenarios, s)) {
        state.scenario = s;
        state.changed = false;
      } else if (url.searchParams.get('change') === '1') state.changed = !state.changed;
      else if (url.searchParams.get('variant') === '1') state.variant = !state.variant;
      else return send({ error: 'Unknown fixture scenario' }, 400);
      return send(state);
    }
    if (req.method !== 'GET') return send({ error: 'Read-only source' }, 405);
    if (pathname === '/comparison-lab/source/search') {
      if (state.scenario === 'unavailable')
        return send({ error: 'Practice source unavailable' }, 503);
      if (state.scenario === 'rate') {
        res.setHeader('Retry-After', '9');
        return send({ error: 'Practice rate limit' }, 429);
      }
      if (state.scenario === 'forbidden') return send({ error: 'Practice access denied' }, 403);
      if (state.scenario === 'malformed') return send({ results: 'Practice incompatible schema' });
      if (state.scenario === 'redirect') {
        res.writeHead(302, { Location: origin + '/comparison-lab/original' }).end();
        return true;
      }
      if (state.scenario === 'oversize') return send({ text: 'x'.repeat(265000) });
      if (state.scenario === 'delayed' || state.scenario === 'timeout')
        await new Promise((ok) => setTimeout(ok, state.scenario === 'delayed' ? 1800 : 8800));
      const rows = scenarios[state.scenario],
        offset = Number(url.searchParams.get('offset') ?? 0),
        batch = rows.slice(offset, offset + 12);
      return send({
        urls: batch.map((id) =>
          id === 'bad-link'
            ? 'https://untrusted.example/checkout'
            : origin + '/comparison-lab/' + id,
        ),
        hasMore: offset + 12 < rows.length,
      });
    }
    if (pathname.startsWith('/comparison-lab/source/offers/')) {
      const id = pathname.split('/').at(-1);
      if (id === 'error' && state.scenario !== 'partial-restored')
        return send({ error: 'Labelled missing offer' }, 404);
      if (!known.has(id)) return send({ error: 'Unknown practice offer' }, 404);
      return send({
        ...buildOffer(id, origin, state),
        sellerEvidence: null,
        productEvidence: null,
      });
    }
    const assessment = /^\/comparison-lab\/source\/evidence\/(product|seller)\/([a-z0-9-]+)$/.exec(
      pathname,
    );
    if (assessment) {
      const [, kind, id] = assessment;
      if (!known.has(id)) return send({ error: 'Unknown practice offer' }, 404);
      const o = buildOffer(id, origin, state);
      return send(o[kind + 'Evidence']);
    }
    const id = pathname.split('/')[2] || 'original';
    if (!known.has(id)) return send({ error: 'Unknown page' }, 404);
    const offer = buildOffer(id, origin, state);
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>SafeStep comparison practice</title><style>body{max-width:42rem;margin:2rem auto;font:18px/1.5 system-ui}label,button{display:block;margin:1rem 0}section{border:1px solid #ccc;padding:1rem}</style><body><header>SafeStep practice · synthetic comparison offers</header><main><h1>' +
          esc(offer.title) +
          '</h1><section data-shopping-evidence><p>Practice listing ' +
          esc(id) +
          ' · ' +
          esc(offer.seller) +
          '</p><p>' +
          esc(offer.cost.text) +
          ' · ' +
          esc(offer.attributes.nib ?? 'Nib unknown') +
          '</p><a href="/comparison-lab/better">Inspect practice alternate offer</a></section><label>Practice evidence scenario <select id="comparison-scenario">' +
          Object.keys(scenarios)
            .map(
              (s) =>
                '<option' + (s === state.scenario ? ' selected' : '') + '>' + esc(s) + '</option>',
            )
            .join('') +
          '</select></label><button id="change-offer">Change practice price and availability</button><button id="change-variant">Change selected practice nib</button><span data-comparison-variant="' +
          esc(offer.attributes.nib ?? 'unknown') +
          '">Selected nib: ' +
          esc(offer.attributes.nib ?? 'unknown') +
          '</span><output id="fixture-state" role="status">' +
          esc(state.scenario) +
          '</output></main><aside aria-label="Sponsored">Practice promotional region</aside><script>const lab=document.querySelector("#fixture-state");async function change(q){const r=await fetch("/comparison-lab/state?"+q,{method:"POST"});const d=await r.json();lab.textContent=d.scenario+(d.changed?" · changed":"");if(q==="variant=1"){const e=document.querySelector("[data-comparison-variant]"),n=d.variant?"medium":"fine";e.dataset.comparisonVariant=n;e.textContent="Selected nib: "+n;}}document.querySelector("#comparison-scenario").onchange=e=>change("scenario="+encodeURIComponent(e.target.value));document.querySelector("#change-offer").onclick=()=>change("change=1");document.querySelector("#change-variant").onclick=()=>change("variant=1");</script></body></html>',
      );
    return true;
  };
}
