import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import { stage6Edges } from './support/stage6-lifecycle.mjs';
import { stage6RepairExtras } from './support/stage6-repair-extra.mjs';
import { openArea } from './support/stage7-panel.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
const out = resolve('.test-artifacts/stage6', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const lab = await startFixture(0),
  base = lab.origin + '/comparison-lab/',
  results = [];
const suites = (
  process.env.SAFESTEP_S6_CASES ??
  'pen,book,mozilla,exact,selected,coverage,lifecycle,recovery,permissions,edits,cleanup,expiry,boundaries,reviewBudget,window,pendingRecovery'
).split(',');
const scope = 'section[aria-label="Compare alternatives"]';
const rect = { 1440: 900, 1366: 768 };
const trial = process.env.SAFESTEP_S6_TRIAL ?? '';
assert(!trial || /^[a-z0-9-]{1,60}$/i.test(trial));
const starts = {
  pen: 'https://nibdrawer.resell.store/lamy-2000-makrolon',
  book: 'https://foxedandfound.resell.store/mastering-art-french-cooking-1961',
  mozilla: 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
};
const finalStates = [
  'ready',
  'partial',
  'no_matches',
  'only_baseline',
  'needs_checking',
  'source_unavailable',
  'clarify',
  'unsupported',
];
class InsufficientPublicCoverage extends Error {}
function reviewedMozillaOffers(c) {
  return c.candidates.filter(({ offer }) => {
    const ev = offer.productEvidence;
    return (
      offer.market === 'mozilla' &&
      offer.catalog === 'amo_' + offer.id &&
      ev?.subject === offer.catalog &&
      ev.source === offer.url + 'reviews/' &&
      ev.sample >= 0 &&
      ev.sample <= 20 &&
      (ev.metric !== null || ev.sample > 0)
    );
  });
}
async function until(fn, message, ms = 70000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const x = await fn();
    if (x) return x;
    await sleep(85);
  }
  throw Error('Timed out: ' + message);
}
const current = async (p) => (await view(p)).v.comparison;
async function state(p, fn, what) {
  return until(async () => {
    const c = await current(p);
    return c && fn(c) && c;
  }, what);
}
async function find(p, selector, text) {
  for (const e of await p.$$(scope + ' ' + selector))
    if ((await e.isVisible()) && (await e.evaluate((el, t) => el.textContent.trim() === t, text)))
      return e;
  return null;
}
async function click(p, text, keyboard = false) {
  const e = await until(() => find(p, 'button', text), 'button ' + text, 8000);
  if (keyboard) {
    await e.focus();
    await p.keyboard.press('Enter');
  } else await e.click();
  return e;
}
async function field(p, label) {
  const selector = scope + ' label';
  for (const e of await p.$$(selector)) {
    const txt = await e.evaluate((el) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim(),
    );
    if (txt === label) {
      const control = await e.$('input,select');
      if (control) return control;
    }
  }
  throw Error('Missing comparison form control ' + label);
}
async function type(p, label, txt) {
  const el = await field(p, label);
  await el.click();
  await p.keyboard.down('Control');
  await p.keyboard.press('a');
  await p.keyboard.up('Control');
  await p.keyboard.press('Backspace');
  if (txt) await p.keyboard.type(txt);
}
async function prepare(s) {
  await openArea(s.panel,'Shopping');
  await s.page.bringToFront();
  await s.panel.evaluate(async () => {
    const w = await chrome.windows.getCurrent();
    if (!w.focused) await chrome.windows.update(w.id, { focused: true });
  });
  await click(s.panel, 'Find alternatives', true);
  const c = await state(
    s.panel,
    (x) =>
      !!x.baseline || ['unsupported', 'source_unavailable', 'needs_baseline'].includes(x.status),
    'baseline',
  );
  assert(c.baseline, c.message);
  await s.panel.waitForSelector(scope + ' form.comparison-form');
  return c;
}
async function configure(
  p,
  {
    goal = 'Compare exact offers for this product',
    query = 'fountain pen',
    mode = 'same_product_other_sellers',
    differences = [],
    hard,
    preference,
    priority,
    budget,
  } = {},
) {
  await type(p, 'Comparison goal', goal);
  await (await field(p, 'Comparison mode')).select(mode);
  await type(p, 'Public search terms', query);
  for (const k of differences) {
    const e = await field(p, k);
    if (!(await e.evaluate((n) => n.checked))) await e.click();
  }
  for (const [n, pair] of (hard ? (Array.isArray(hard[0]) ? hard : [hard]) : []).entries()) {
    await click(p, 'Add requirement');
    await type(p, 'Required attribute ' + (n + 1), pair[0]);
    await type(p, 'Required value ' + (n + 1), pair[1]);
  }
  if (preference) {
    await p.locator(scope + ' summary::-p-text(Soft preferences)').click();
    await click(p, 'Add preference');
    await type(p, 'Preferred attribute 1', preference[0]);
    await type(p, 'Preferred value 1', preference[1]);
  }
  if (priority) {
    await (await field(p, 'Add priority')).select(priority);
  }
  if (budget) {
    await (await field(p, 'Apply a budget')).click();
    await type(p, 'Budget amount', budget.amount);
    await type(p, 'Budget currency', budget.currency);
    await (await field(p, 'Budget basis')).select(budget.basis);
  }
}
async function options(p) {
  const c = await current(p);
  await click(p, 'Find options', true);
  return state(
    p,
    (x) => x.version > c.version && finalStates.includes(x.status),
    'settled comparison',
  );
}
async function scenario(s, name) {
  await s.page.select('#comparison-scenario', name);
  await s.page.waitForFunction(
    (n) => document.querySelector('#fixture-state')?.textContent === n,
    {},
    name,
  );
}
function summary(c) {
  const offer = (o) => ({
    id: o.id,
    title: o.title,
    url: o.url,
    market: o.market,
    catalog: o.catalog,
    seller: o.seller,
    family: o.family,
    availability: o.availability,
    attributes: o.attributes,
    quantity: o.quantity,
    cost: o.cost,
    captured: o.captured,
    product: o.productEvidence && {
      subject: o.productEvidence.subject,
      source: o.productEvidence.source,
      sample: o.productEvidence.sample,
      aggregate: o.productEvidence.metric,
    },
    service: o.sellerEvidence && {
      subject: o.sellerEvidence.subject,
      source: o.sellerEvidence.source,
      sample: o.sellerEvidence.sample,
      aggregate: o.sellerEvidence.metric,
    },
  });
  return {
    status: c.status,
    baseline: c.baseline && offer(c.baseline),
    candidates: c.candidates.map((x) => ({
      offer: offer(x.offer),
      fit: x.fit,
      reasons: x.reasons,
      tradeoffs: x.tradeoffs,
      savings: x.savings,
      subtotal: x.subtotal,
      recommended: x.recommended,
    })),
    settings: c.settings,
    coverage: c.coverage,
    source: c.searchSource,
    time: c.at,
    message: c.message,
  };
}
async function snapshot(s, r, c) {
  r.observations.push(summary(c));
  assert(c.candidates.length <= 3);
  assert(new Set(c.candidates.map((x) => x.offer.id)).size === c.candidates.length);
  assert(c.candidates.every((x) => x.offer.id !== c.baseline.id));
  const p = s.panel;
  await p.$eval(scope + ' [data-testid=comparison-status]', (e) =>
    e.scrollIntoView({ block: 'start' }),
  );
  const file = [r.name, r.width, r.observations.length, trial].filter(Boolean).join('-') + '.png';
  await p.screenshot({ path: join(out, file) });
  r.screens.push(file);
}
async function refresh(p, c) {
  await click(p, 'Refresh evidence');
  return state(
    p,
    (x) => x.version > c.version && finalStates.includes(x.status),
    'explicit refresh',
  );
}
async function openOffer(s, r, c, index = 0) {
  const offer = c.candidates[index].offer;
  const tab = s.browser.waitForTarget((t) => t.type() === 'page' && t.url() === offer.url, {
    timeout: 18000,
  });
  const card = await s.panel.$(scope + ' article[data-offer-id="' + offer.id + '"]');
  assert(card);
  const b = await card.$('::-p-aria(Open offer[role="button"])');
  assert(b);
  await b.click();
  const target = await tab,
    opened = await target.asPage();
  await opened.waitForFunction(
    (url) => location.href === url && document.readyState !== 'loading' && !!document.title,
    { timeout: 30000 },
    offer.url,
  );
  const visible = await opened.evaluate(() => ({
    href: location.href,
    title: document.title,
    heading: document.querySelector('main h1,h1')?.innerText,
  }));
  assert.equal(visible.href, offer.url);
  const normalize = (t) =>
    String(t ?? '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  assert(
    normalize(visible.heading ?? visible.title).includes(normalize(offer.title)),
    'Opened page identifies the selected offer.',
  );
  r.opened = { expected: offer.url, visible };
  assert.equal(c.baseline.url, new URL(s.page.url()).href);
  await opened.close();
  await s.page.bringToFront();
  r.checks.push(
    'Explicit canonical open created the matching new tab and preserved the original tab.',
  );
}
async function live(s, r, kind) {
  // Start from the settled live listing so a delayed initial load cannot retire
  // the user's new comparison while its source request is in flight.
  await s.page.waitForFunction(() => document.readyState === 'complete' &&
    document.querySelector('h1')?.getBoundingClientRect().height > 0, { timeout: 30000 });
  const b = (await prepare(s)).baseline;
  if (kind === 'book') {
    await configure(s.panel, {
      goal: 'Find the same 1961 first printing from a different seller.',
      query: 'french cooking',
    });
    const c = await options(s.panel);
    await snapshot(s, r, c);
    assert.equal(c.baseline.id, b.id);
    assert(c.coverage.batches > 0 && c.coverage.searched >= 1, c.message);
    assert(
      ['only_baseline', 'no_matches', 'needs_checking', 'ready'].includes(c.status),
      c.message,
    );
    assert(
      !c.candidates.some(
        (x) => x.recommended && (x.offer.seller === b.seller || x.fit !== 'confirmed'),
      ),
    );
    r.checks.push('Genuine exact discovery retained the original printing, item and seller scope.');
    return;
  }
  const software = kind === 'mozilla';
  await configure(s.panel, {
    goal: software
      ? 'Compare Firefox extensions for ad blocking. Prefer tracking protection.'
      : 'Compare other fountain pens. Different models and nibs are allowed.',
    query: software ? 'ad blocker' : 'fountain pen',
    mode: 'similar_products',
    differences: software
      ? ['product', 'model', 'version']
      : ['product', 'model', 'nib', 'condition'],
    hard: software
      ? [
          ['platform', 'Firefox'],
          ['ad blocking', 'yes'],
        ]
      : undefined,
    preference: software ? ['tracking protection', 'yes'] : undefined,
    priority: software ? 'feature' : undefined,
  });
  let c = await options(s.panel);
  await snapshot(s, r, c);
  while (
    software &&
    reviewedMozillaOffers(c).length < 2 &&
    c.coverage.more &&
    c.coverage.batches < 3
  ) {
    const version = c.version;
    await click(s.panel, 'More results');
    c = await state(
      s.panel,
      (x) => x.version > version && finalStates.includes(x.status),
      'next Mozilla batch',
    );
    await snapshot(s, r, c);
  }
  if (c.coverage.searched < 2 || c.coverage.checked < 2 || c.candidates.length < 2)
    throw new InsufficientPublicCoverage(
      'Fewer than two checked public alternatives. ' + c.message,
    );
  assert(new Set(c.candidates.map(({ offer }) => offer.id)).size >= 2);
  assert(c.candidates.every((x) => x.offer.market === b.market));
  if (software) {
    assert(c.candidates.every((x) => x.offer.sellerEvidence === null && x.savings === null));
    const reviewed = reviewedMozillaOffers(c);
    if (new Set(reviewed.map(({ offer }) => offer.catalog)).size < 2)
      throw new InsufficientPublicCoverage(
        'Two distinct Mozilla catalog options with bounded source-matched feedback were unavailable.',
      );
    r.reviewedCatalogs = reviewed.map(({ offer }) => ({
      id: offer.id,
      developer: offer.attributes.developer ?? null,
      source: offer.productEvidence.source,
      sample: offer.productEvidence.sample,
    }));
  } else {
    assert(c.candidates.every((x) => x.offer.productEvidence === null));
    const pens = c.candidates.filter(({ offer }) => {
      const service = offer.sellerEvidence;
      return (
        (offer.attributes.purpose === 'fountain pen' || /fountain pens?/i.test(offer.family)) &&
        offer.seller &&
        service?.subject === offer.seller &&
        service.source === 'https://api.resell.store/v1/stores/' + offer.seller + '/reviews' &&
        Number.isFinite(Date.parse(offer.captured)) &&
        offer.cost.text
      );
    });
    if (new Set(pens.map(({ offer }) => offer.id)).size < 2)
      throw new InsufficientPublicCoverage(
        'Two distinct public fountain pen observations with source-bound shop coverage were unavailable.',
      );
    r.observedPens = pens.map(({ offer }) => ({
      id: offer.id,
      seller: offer.seller,
      nib: offer.attributes.nib ?? null,
      condition: offer.attributes.condition ?? null,
      source: offer.sellerEvidence.source,
      captured: offer.captured,
    }));
  }
  await click(s.panel, 'Compare selected');
  await s.panel.waitForSelector(scope + ' table');
  assert(
    (await s.panel.$$eval(scope + ' table th[scope=col]', (x) => x.length)) ===
      c.candidates.length + 2,
  );
  if (software) {
    const attribution = await s.panel.$$eval(
      scope + ' tbody tr',
      (rows) =>
        rows.find((row) => row.querySelector('th')?.textContent === 'Developer listed by Mozilla')
          ?.innerText,
    );
    assert(attribution);
    for (const offer of [b, ...c.candidates.map((x) => x.offer)])
      assert(attribution.includes(offer.attributes.developer ?? 'Not provided'));
  }
  const next = await refresh(s.panel, c);
  assert(Date.parse(next.at) > Date.parse(c.at));
  assert(next.candidates.length);
  await snapshot(s, r, next);
  await openOffer(s, r, next);
  r.checks.push(
    software
      ? 'Firefox catalog identities, public compatible features and bounded product feedback remained separate from seller evidence.'
      : 'Physical model and nib differences, source-specific seller feedback and current cost components are visible.',
  );
}
async function exact(s, r) {
  await scenario(s, 'exact');
  await prepare(s);
  await configure(s.panel, { priority: 'seller' });
  const c = await options(s.panel);
  await snapshot(s, r, c);
  const better = c.candidates.find((x) => x.offer.id === 'better'),
    lower = c.candidates.find((x) => x.offer.id === 'lower');
  assert(better && lower, c.message);
  assert.equal(better.fit, 'confirmed');
  assert.equal(Number(better.subtotal), 24.15);
  assert.equal(Number(better.savings), 6.85);
  assert.equal(lower.savings, null);
  assert.equal(better.offer.productEvidence.subject, c.baseline.productEvidence.subject);
  assert.notEqual(better.offer.sellerEvidence.subject, c.baseline.sellerEvidence.subject);
  await click(s.panel, 'Explain comparison with Gemini');
  const unpaired = await state(
    s.panel,
    (x) => /not paired/i.test(x.ai ?? ''),
    'honest unpaired AI status',
  );
  assert.deepEqual(unpaired.candidates, c.candidates);
  assert(!unpaired.explanation?.length);
  const excluded = await s.panel.waitForSelector(
    scope + ' article[data-offer-id="lower"] input[type=checkbox]',
    { visible: true },
  );
  await excluded.focus();
  await s.panel.keyboard.press('Space');
  await click(s.panel, 'Compare selected', true);
  const t = await s.panel.$(scope + ' table');
  assert(t);
  const text = await t.evaluate((e) => e.innerText);
  assert(
    text.includes('Original') &&
      text.includes('Product reviews') &&
      text.includes('Seller feedback'),
  );
  assert.equal(await t.$$eval('th[scope=col]', (cells) => cells.length), c.candidates.length + 1);
  assert.equal(
    await s.panel.evaluate(() => document.activeElement.textContent),
    'Compare selected',
  );
  const before = c.coverage.searched;
  const priority = await s.panel.$('button[aria-label="Move Seller feedback up"]');
  await priority.click();
  const next = await state(s.panel, (x) => x.version > unpaired.version, 'new order');
  assert.equal(next.settings.priorities[0], 'seller');
  assert.equal(next.coverage.searched, before);
  const first = s.panel.locator(
    scope + ' article[data-offer-id="' + lower.offer.id + '"] button::-p-text(Remove option)',
  );
  await first.click();
  await state(
    s.panel,
    (x) => !x.candidates.some((y) => y.offer.id === lower.offer.id),
    'removed option',
  );
  assert.equal(
    await s.panel.evaluate(() => document.activeElement.textContent),
    'Compare alternatives',
  );
  await click(s.panel, 'Keep original');
  await state(
    s.panel,
    (x) => x.baseline?.id === 'original' && !x.candidates.length,
    'original kept',
  );
  r.checks.push(
    'Exact same item, two sellers; deduplication, exact 6.85 lower subtotal, item-only price did not win, shared ratings, keyboard table and sorting/removal without rediscovery.',
    'An explicit unpaired Gemini request showed its unavailable status and left every local option and reason intact. Keyboard selection omitted one card while retaining the original; focus remained on the table control.',
  );
}
async function selected(s, r) {
  await scenario(s, 'exact');
  await prepare(s);
  await configure(s.panel, {
    mode: 'compare_selected',
    query: '',
    goal: 'Compare these selected pens',
  });
  let c = await options(s.panel);
  assert.equal(c.coverage.batches, 0);
  for (const id of ['better', 'lower']) {
    await type(s.panel, 'Supported offer URL', base + id);
    await click(s.panel, 'Add offer');
    c = await state(s.panel, (x) => x.candidates.some((y) => y.offer.id === id), 'validated ' + id);
  }
  assert.equal(c.candidates.length, 2);
  await snapshot(s, r, c);
  const card = c.candidates.find((x) => x.offer.id === 'better');
  assert(card);
  await s.page.click('#change-offer');
  await s.page.waitForFunction(() =>
    document.querySelector('#fixture-state').textContent.includes('changed'),
  );
  const now = await refresh(s.panel, c);
  assert(!now.candidates.some((x) => x.offer.id === 'better' && x.recommended));
  await snapshot(s, r, now);
  r.checks.push(
    'Selected URLs resolved to their actual identities; explicit refresh rechecked a changed price/stock, and removed any old advantage.',
  );
}
async function coverage(s, r) {
  await scenario(s, 'empty');
  await prepare(s);
  await configure(s.panel, {});
  let c = await options(s.panel);
  assert(c.status === 'no_matches');
  await snapshot(s, r, c);
  for (const [source, allowed] of [
    ['baseline-only', ['only_baseline']],
    ['incompatible', ['no_matches', 'needs_checking']],
    ['partial', ['partial']],
    ['rate', ['source_unavailable', 'partial']],
    ['pagination', ['ready', 'needs_checking', 'partial']],
  ]) {
    await scenario(s, source);
    c = await refresh(s.panel, c);
    assert(allowed.includes(c.status), source + ' ' + c.status + ' ' + c.message);
    await snapshot(s, r, c);
  }
  for (let batch = 2; batch <= 3; batch++) {
    assert(c.coverage.more);
    await click(s.panel, 'More results');
    c = await state(
      s.panel,
      (x) => x.coverage.batches === batch && finalStates.includes(x.status),
      'explicit batch ' + batch,
    );
  }
  assert.equal(c.coverage.more, false);
  assert.equal(c.coverage.searched, 36);
  assert.equal(await find(s.panel, 'button', 'More results'), null);
  await snapshot(s, r, c);
  r.checks.push(
    'Zero results, baseline only, incompatible/uncertain, partial detail and provider limit states were distinct. Three explicit batches capped results at 36, with no automatic More.',
  );
}
async function lifecycle(s, r) {
  await scenario(s, 'delayed');
  await prepare(s);
  await configure(s.panel, {});
  await click(s.panel, 'Find options');
  await state(s.panel, (x) => x.status === 'searching', 'delayed search');
  await click(s.panel, 'Cancel comparison');
  let c = await state(s.panel, (x) => x.status === 'cancelled', 'cancelled');
  const v = c.version;
  await sleep(2000);
  c = await current(s.panel);
  assert.equal(c.version, v);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.candidates.length, 0);
  await click(s.panel, 'Edit requirements');
  await configure(s.panel, { goal: 'Safe topic password: PRIVATE_STAGE6_SECRET', query: 'PUBLIC' });
  const before = r.requests.length;
  await click(s.panel, 'Find options');
  await s.panel.waitForSelector(scope + ' [role=alert]', { timeout: 4000 });
  assert.equal(r.requests.length, before);
  await configure(s.panel, { goal: 'Find the original pen', query: 'Meridian' });
  await click(s.panel, 'Find options');
  await state(s.panel, (x) => x.status === 'searching', 'pending comparison');
  const other = await s.browser.newPage();
  await other.goto(base + 'alternative');
  await other.bringToFront();
  await sleep(650);
  await s.page.bringToFront();
  await state(
    s.panel,
    (x) => ['paused', 'stale', 'cancelled'].includes(x.status),
    'original paused on tab switch',
  );
  r.checks.push(
    'Cancellation retained version and empty result after the late response. Private goal rejected without a source request. Tab change retired the comparison.',
  );
}
async function recovery(s, r) {
  await scenario(s, 'exact');
  await prepare(s);
  await configure(s.panel, {});
  const old = await options(s.panel);
  assert(old.candidates.length);
  await openArea(s.panel,'Settings');
  await s.panel.locator('summary::-p-text(Access & preferences)').click();
  await s.panel.locator('::-p-aria(Larger text[role="checkbox"])').click();
  await until(async () => (await view(s.panel)).v.prefs.largeText, 'larger text', 8000);
  await s.panel.waitForSelector('.large section[aria-label="Compare alternatives"]');
  await openArea(s.panel,'Shopping');
  const w = await (
    await s.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(s.id))
  ).worker();
  await w.close();
  const c = await state(
    s.panel,
    (x) => ['paused', 'stale'].includes(x.status),
    'paused worker recovery',
  );
  const count = s.sourceReadCount();
  await sleep(800);
  assert.equal(s.sourceReadCount(), count);
  assert(c.version > old.version);
  await s.panel.waitForFunction((id) => {
    const status = document.querySelector('[data-testid="comparison-status"]');
    return status?.dataset.revision === String(id) && /recovered|paused/i.test(status.innerText);
  }, {timeout: 8000}, c.version);
  assert(
    !(await find(s.panel, 'button', 'Open offer')) ||
      (await (await find(s.panel, 'button', 'Open offer')).evaluate((e) => e.disabled)),
  );
  assert((await view(s.panel)).v.prefs.largeText);
  r.checks.push(
    'Restart recovered a paused/stale view without replaying a network read or offer click and preserved large text.',
  );
  r.recoveryStatus = c.status;
}
async function ai(s, r) {
  await openArea(s.panel,'Settings');
  const token = (await readFile('apps/api/.env.safestep-session', 'utf8')).trim();
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  await s.panel.type('input[type=password]', token);
  await s.panel.locator('::-p-aria(Connect[role="button"])').click();
  await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'));
  const aiHealth = async () =>
    await (await fetch('http://127.0.0.1:4317/v1/compare/health')).json();
  const started = new Date().toISOString();
  await prepare(s);
  await configure(s.panel, {
    goal: 'Compare Firefox ad blockers for at most USD 32 item price, excluding Chrome and beta versions.',
    query: 'ad blocker',
  });
  await click(s.panel, 'Interpret goal with Gemini');
  const parsed = await state(s.panel, (x) => x.ai && !x.ai.includes('Asking'), 'actual intent');
  r.aiIntent = { message: parsed.ai, settings: parsed.settings };
  assert(
    parsed.settings.budget &&
      parsed.settings.budget.currency === 'USD' &&
      Number(parsed.settings.budget.amount) === 32 &&
      parsed.settings.budget.basis === 'item',
    parsed.ai,
  );
  for (const [field, value, exclude] of [
    ['platform', 'Firefox', false],
    ['platform', 'Chrome', true],
    ['version', 'beta', true],
  ])
    assert(
      parsed.settings.hard.some(
        (x) =>
          x.field === field &&
          x.value.toLowerCase() === value.toLowerCase() &&
          x.exclude === exclude,
      ),
      'Missing user constraint ' + value,
    );
  const intentHealth = await aiHealth();
  assert(
    intentHealth.intent &&
      intentHealth.recent.some(
        (x) => x.at >= started && x.operation === 'intent' && x.status === 'available',
      ),
  );
  r.aiIntent.health = intentHealth;
  await snapshot(s, r, parsed);
  await click(s.panel, 'Close comparison');
  await s.page.goto(base + 'original');
  await s.page.bringToFront();
  await s.activate(s.page);
  await scenario(s, 'exact');
  await prepare(s);
  await configure(s.panel, {});
  const c = await options(s.panel);
  assert(c.candidates.length, c.message);
  await click(s.panel, 'Explain comparison with Gemini');
  const explained = await state(
    s.panel,
    (x) => x.explanation?.length,
    'actual comparison explanation',
  );
  r.aiExplanation = { message: explained.ai, explanation: explained.explanation };
  assert.deepEqual(
    explained.candidates.map((x) => x.savings),
    c.candidates.map((x) => x.savings),
  );
  await snapshot(s, r, explained);
  const explanationHealth = await aiHealth();
  assert(
    explanationHealth.explain &&
      explanationHealth.recent.some(
        (x) => x.at >= started && x.operation === 'explain' && x.status === 'available',
      ),
  );
  r.aiExplanation.health = explanationHealth;
  const worker = await (
    await s.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(s.id))
  ).worker();
  await worker.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      const u = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
      if (u.origin === 'http://127.0.0.1:4317' && u.pathname === '/v1/compare/explain') {
        globalThis.fetch = original;
        const body = await response.clone().json();
        globalThis.qaCompared = {
          http: response.status,
          status: body.status,
          elapsedMs: body.elapsedMs,
          tokens: body.tokens,
        };
        await new Promise((ok) => (globalThis.qaReleaseCompared = ok));
      }
      return response;
    };
  });
  await click(s.panel, 'Explain comparison with Gemini');
  await until(
    () => worker.evaluate(() => typeof globalThis.qaReleaseCompared === 'function'),
    'held actual provider response',
    14500,
  );
  assert.equal((await current(s.panel)).ai, 'Asking Gemini…');
  r.heldReply = await worker.evaluate(() => globalThis.qaCompared);
  assert.equal(r.heldReply.status, 'available');
  await click(s.panel, 'Edit requirements');
  await type(s.panel, 'Comparison goal', 'A new comparison goal');
  await worker.evaluate(() => globalThis.qaReleaseCompared());
  await sleep(1400);
  const edited = await current(s.panel);
  assert(!edited.explanation?.length);
  assert.equal(
    await (await field(s.panel, 'Comparison goal')).evaluate((e) => e.value),
    'A new comparison goal',
  );
  r.checks.push(
    'Paired genuine comparison intent and explanation; checked exact savings stability, then fenced an explanation with a requirements edit.',
  );
}
const fixtures = {
  exact,
  selected,
  coverage,
  lifecycle,
  recovery,
  ai,
  ...stage6RepairExtras({ prepare, configure, options, state, refresh, click, snapshot, type, field, base, scenario }),
  ...stage6Edges({
    prepare,
    configure,
    click,
    state,
    current,
    options,
    scenario,
    snapshot,
    view,
    base,
    field,
    type,
  }),
};
async function run(name, width) {
  const url = starts[name] ?? (name === 'ai' ? starts.mozilla : base + 'original');
  const r = {
    name,
    width,
    status: 'fail',
    checks: [],
    observations: [],
    screens: [],
    requests: [],
    downloads: 0,
    consequentialAttempts: 0,
    privateOutbound: 0,
  };
  let s;
  let sourceReads = 0;
  const observeFixture = (req) => {
    if (req.url?.startsWith('/comparison-lab/source/')) sourceReads++;
  };
  lab.server.on('request', observeFixture);
  try {
    const open = () =>
      nativeSession(bundle, width, rect[width], url, {
        attachWorker: true,
        prepare: async (page) => {
          await page.setRequestInterception(true);
          page.on('request', (q) => {
            const u = new URL(q.url());
            if (
              /\/(?:checkout|purchase|install|download|message\/send|vote|cart\/add)(?:\/|$)|\.xpi$/i.test(
                u.pathname,
              ) ||
              /(^|\.)ebay\.com$/.test(u.hostname)
            ) {
              r.consequentialAttempts++;
              void q.abort();
              return;
            }
            if (
              u.hostname === 'api.resell.store' ||
              (u.hostname === 'addons.mozilla.org' && u.pathname.startsWith('/api/')) ||
              u.pathname.includes('/comparison-lab/source/')
            )
              r.requests.push({
                path: u.pathname,
                keys: [...u.searchParams.keys()],
                method: q.method(),
                credential: !!q.headers().authorization || !!q.headers().cookie,
                fromExtension:
                  q
                    .initiator()
                    ?.stack?.callFrames?.some((f) => f.url.startsWith('chrome-extension://')) ??
                  false,
              });
            void q.continue();
          });
        },
      });
    try {
      s = await open();
    } catch (e) {
      if (!starts[name] || !/net::ERR_|Navigation timeout/.test(e.message)) throw e;
      r.initialLoadError = e.message.slice(0, 150);
      await sleep(1250);
      s = await open();
    }
    const target = await s.browser.waitForTarget(
      (t) =>
        t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + s.id + '/'),
    );
    s.sourceReadCount = () => sourceReads;
    const network = (await target.worker()).client;
    await network.send('Network.enable');
    const recorded = new Map();
    network.on('Network.requestWillBeSent', (e) => {
      const u = new URL(e.request.url);
      const decoy =
        /PRIVATE_(?:COMPARE_TEST|TEST|STAGE6_SECRET)|QA comparison buyer|QA raw review sentinel/i;
      if (
        decoy.test(u.href) ||
        decoy.test([...u.searchParams.values()].join(' ')) ||
        decoy.test(e.request.postData ?? '') ||
        decoy.test(JSON.stringify(e.request.headers))
      )
        r.privateOutbound++;
      if (
        !['api.resell.store', 'addons.mozilla.org'].includes(u.hostname) &&
        !(u.origin === lab.origin && u.pathname.startsWith('/comparison-lab/source/'))
      )
        return;
      const allowed = new Set([
        'q',
        'category',
        'sort',
        'app',
        'type',
        'page',
        'page_size',
        'limit',
        'offset',
        'score',
        'show_grouped_ratings',
      ]);
      const row = {
        host: u.hostname,
        path: u.pathname,
        query: Object.fromEntries([...u.searchParams].filter(([k]) => allowed.has(k))),
        method: e.request.method,
        credential: Object.keys(e.request.headers).some((k) =>
          ['cookie', 'authorization'].includes(k.toLowerCase()),
        ),
        fromExtension: true,
      };
      r.requests.push(row);
      recorded.set(e.requestId, row);
    });
    network.on('Network.responseReceived', (e) => {
      const row = recorded.get(e.requestId);
      if (row) row.http = e.response.status;
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const loaded = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    );
    assert(loaded?.enabled && resolve(loaded.path) === bundle);
    r.loaded = { id: loaded.id, path: loaded.path };
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    if (starts[name]) await live(s, r, name);
    else await fixtures[name](s, r);
    assert.equal(r.downloads, 0);
    assert.equal(r.consequentialAttempts, 0);
    assert.equal(r.privateOutbound, 0, 'A synthetic private marker left the worker');
    assert(
      r.requests.filter((q) => q.fromExtension).every((q) => q.method === 'GET' && !q.credential),
    );
    r.status = 'pass';
  } catch (e) {
    if (e instanceof InsufficientPublicCoverage) r.status = 'blocked';
    r.error = e.message.slice(0, 350);
    if (s) {
      const c = await current(s.panel).catch(() => null);
      r.diagnostic = c
        ? { status: c.status, version: c.version, message: c.message, ai: c.ai }
        : null;
    }
  } finally {
    lab.server.off('request', observeFixture);
    if (s) await s.browser.close();
    results.push(r);
    await saveRun();
    console.log(r.status, name, width, r.error ?? '', JSON.stringify(r.diagnostic ?? {}));
  }
}
try {
  for (const width of [1440, 1366]) {
    if (process.env.SAFESTEP_WIDTH && Number(process.env.SAFESTEP_WIDTH) !== width) continue;
    for (const name of suites) {
      assert(starts[name] || fixtures[name]);
      await run(name, width);
    }
  }
} finally {
  lab.server.close();
}
async function saveRun() {
  await writeFile(
    join(
      out,
      ['run', suites.join('-'), process.env.SAFESTEP_WIDTH ?? 'both', trial]
        .filter(Boolean)
        .join('-') + '.json',
    ),
    JSON.stringify(
      { role: 'builder', at: new Date().toISOString(), sha256, bundle, results },
      null,
      2,
    ) + '\n',
  );
}
if (!results.length || results.some((r) => r.status !== 'pass')) process.exitCode = 1;
