import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { view } from './chrome-cases.mjs';

export async function amazonPractice({ s, r, wait, button, area, record }) {
  const domains = new Set();
  s.page.on('request', (q) => domains.add(new URL(q.url()).hostname));
  await area(s.panel, 'Shopping');
  const data = async (kind) => (await view(s.panel)).v.shopping?.[kind]?.data;
  async function inspect(kind) {
    const prior = (await data(kind))?.binding.operationId;
    await button(s.panel, 'Check ' + kind).click();
    return wait(
      async () => {
        const d = await data(kind);
        return d && d.binding.operationId !== prior && d;
      },
      'new ' + kind + ' practice evidence',
    );
  }
  const seller = await inspect('seller'),
    product = await inspect('product');
  r.observations.push({stage:'first capture',seller:{context:seller.context,status:seller.status,note:seller.note},product:{context:product.context,status:product.status,note:product.note},selection:await s.page.$eval('#shop-listing',e=>({...e.dataset}))});
  assert.equal(seller.context.market, 'practice');
  assert.equal(seller.context.practiceOffer.region, 'US');
  assert.equal(seller.context.practiceOffer.marketplaceHost, 'www.amazon.com');
  assert.equal(seller.context.practiceOffer.offer, 'AMZ-A');
  assert.equal(seller.context.practiceOffer.asin, 'B00TEST001');
  assert.equal(seller.context.seller, 'SYNTH-A');
  assert.equal(seller.context.practiceOffer.shipsFrom, 'Amazon (practice fulfillment)');
  assert.equal(seller.context.practiceOffer.brand, 'Example Manufacturer');
  assert.equal(seller.status, 'limited_evidence');
  assert.deepEqual(
    seller.records.map((x) => [x.channel, x.subject, x.text]),
    [['seller_received_feedback', 'SYNTH-A', 'Delivery was late.']],
  );
  assert.equal(seller.metrics.find((x) => x.period === 'Last 30 days').value, 33);
  assert.equal(seller.metrics.find((x) => x.period === 'Last 365 days').value, 87);
  assert.equal(seller.metrics.find((x) => x.unit === 'count').period, 'Lifetime');
  assert(!seller.metrics.some((x) => x.period === 'Last 30 days' && x.unit === 'count'));
  assert(seller.note.includes('5 entries') && seller.note.includes('struck-through'));
  assert(
    product.records.every(
      (x) => x.channel === 'catalog_product_review' && x.subject === 'B00TEST001',
    ),
  );
  assert.equal(product.metrics.find((x) => x.unit === 'stars').value, 4.9);
  const display = await s.panel.$eval('[aria-label="Seller assessment"]', (el) => el.innerText);
  for (const term of [
    'Practice',
    'AMZ-A',
    'B00TEST001',
    'SYNTH-A',
    'Ships from',
    'Brand / manufacturer',
    'Last 30 days',
    '5 entries',
  ])
    assert(display.includes(term), term);
  assert(!display.includes('4.9'));
  await record(s, r, 'practice-original');
  r.caseChecks.push('S7-X19', 'S7-X23');
  r.observations.push({
    scenario: 'synthetic practice seller A + catalog',
    seller: {
      context: seller.context,
      records: seller.records,
      metrics: seller.metrics,
      note: seller.note,
    },
    product: { context: product.context, metrics: product.metrics },
  });
  await s.page.click('#delay');
  await wait(async () => !(await data('seller')), 'previous captures retired by page change');
  await button(s.panel, 'Check seller').click();
  await wait(
    async () =>
      s.panel.evaluate(async () => {
        const t = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        return (await chrome.storage.session.get('task:' + t.id))['task:' + t.id]?.shopping?.seller
          ?.operationId;
      }),
    'seller A capture in flight',
  );
  await s.page.select('#offer', 'b');
  await delay(850);
  assert(!(await data('seller')));
  assert(!(await data('product')));
  const second = await inspect('seller');
  assert.equal(second.context.seller, 'SYNTH-B');
  assert.equal(second.context.display, seller.context.display);
  assert.equal(second.context.practiceOffer.offer, 'AMZ-B');
  assert(second.records.length === 0 && second.metrics.length === 0);
  assert.equal(second.status, 'no_reviews_in_view');
  await s.page.select('#offer', 'c');
  await wait(async () => !(await data('seller')), 'ASIN change retired old seller evidence');
  const third = await inspect('product');
  assert.equal(third.context.practiceOffer.asin, 'B00TEST002');
  assert.equal(third.context.practiceOffer.offer, 'AMZ-C');
  await s.page.select('#offer', 'unknown');
  await wait(async () => !(await data('product')), 'unknown selection retired old catalog');
  const missing = await inspect('seller');
  assert.equal(missing.status, 'identity_uncertain');
  assert(!missing.metrics.length && !missing.records.length);
  assert([...domains].every((domain) => ['localhost', '127.0.0.1'].includes(domain)));
  r.observations.push({
    scenario: 'synthetic same-display seller switch, variant switch and unknown seller',
    second: second.context,
    third: third.context,
    unknown: missing.status,
  });
  r.caseChecks.push('S7-X22');
  r.checks.push(
    'Two synthetic accounts share a display name and catalog. The UI separated region, ASIN, offer, account, fulfiller, brand, measured periods and catalog-only ratings. A delayed capture was fenced when the selected seller switched. Seller replies, struck-through, removed, unknown-status and product entries stayed outside service evidence; changing ASIN and losing seller identity cleared earlier cards.',
  );
}
