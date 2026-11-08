// Keyless seller, product and comparison journeys driven by the installed chat interface.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3');
const { sha256 } = await fingerprint(bundle);
assert.match(JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')).version, /^0\.8\./);
const trial = process.env.SAFESTEP_S8_TRIAL ?? 'shopping';
assert.match(trial, /^[a-z0-9-]{1,40}$/);
const out = resolve('.test-artifacts/stage8', sha256.slice(0, 12), trial);
await mkdir(out, { recursive: true });
let lab;
const starts = {
  pen: 'https://nibdrawer.resell.store/lamy-2000-makrolon',
  book: 'https://foxedandfound.resell.store/mastering-art-french-cooking-1961',
  mozilla: 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
  longNames: '',
};
const cases = (process.env.SAFESTEP_S8_SHOPPING ?? Object.keys(starts).join(',')).split(',');
assert(cases.length && cases.every((c) => Object.hasOwn(starts, c)));
const widthFlag = process.env.SAFESTEP_WIDTH;
assert(!widthFlag || ['1440', '1366'].includes(widthFlag));
const resultFile = join(out, 'shopping-' + cases.join('-') + '-' + (widthFlag ?? 'both') + '.json');
const results = [],
  at = new Date().toISOString();
const save = () =>
  writeFile(
    resultFile,
    JSON.stringify(
      {
        role: 'builder',
        sha256,
        bundle,
        at,
        provider: 'No model calls; direct chat controls',
        results,
      },
      null,
      2,
    ) + '\n',
  );
const state = async (s) => (await view(s.panel)).v;
const button = (p, title) => p.locator('::-p-aria(' + title + '[role="button"])').setTimeout(9000);
async function until(fn, name, limit = 26000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await delay(80);
  }
  throw Error('Timed out: ' + name);
}
async function shot(s, r, part) {
  const file = r.name + '-' + r.width + '-' + part + '-panel.png';
  await s.panel.screenshot({ path: join(out, file) });
  r.screens.push(file);
}
async function help(s, feature) {
  await button(s.panel, 'Help').click();
  const item = await s.panel.waitForSelector(
    'aside[aria-label="Help"] [data-feature="' + feature + '"]',
    { visible: true, timeout: 6500 },
  );
  await item.click();
}
async function comparison(s) {
  return (await state(s)).comparison;
}
async function field(s, label) {
  const p = s.panel;
  const forms = await p.$$('section[aria-label="Compare alternatives"] form label');
  for (const e of forms) {
    if (
      await e.evaluate(
        (n, t) =>
          [...n.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent.trim())
            .join(' ')
            .trim() === t,
        label,
      )
    ) {
      const control = await e.$('input,select');
      if (control) return control;
    }
  }
  throw Error('Missing comparison field ' + label);
}
async function type(s, label, value) {
  const el = await field(s, label);
  await el.click();
  await s.panel.keyboard.down('Control');
  await s.panel.keyboard.press('a');
  await s.panel.keyboard.up('Control');
  await s.panel.keyboard.press('Backspace');
  if (value) await s.panel.keyboard.type(value);
}
async function sourceUrl(href, fixture = false) {
  const u = new URL(href);
  assert(!u.username && !u.password);
  if (fixture) {
    assert.equal(u.origin, lab.origin);
    assert(u.pathname.startsWith('/comparison-lab/'));
    return;
  }
  assert.equal(u.protocol, 'https:');
  assert(![...u.searchParams.keys()].some((k) => /token|session|password|auth/i.test(k)));
  if (u.hostname === 'api.resell.store') {
    assert(u.pathname.startsWith('/v1/'));
    return;
  }
  if (u.hostname.endsWith('.resell.store')) {
    assert(/^\/[a-z0-9-]*\/?$/.test(u.pathname));
    return;
  }
  assert.equal(u.hostname, 'addons.mozilla.org');
  assert(/^\/(?:api\/v5\/|en-US\/firefox\/addon\/)/.test(u.pathname));
}
const facts = (o) => ({
  id: o.id,
  url: o.url,
  market: o.market,
  catalog: o.catalog,
  seller: o.seller,
  attributes: o.attributes,
  price: o.cost.amount,
  currency: o.cost.currency,
  delivery: o.cost.shipping ?? null,
  product: o.productEvidence && {
    subject: o.productEvidence.subject,
    scope: o.productEvidence.scope,
    source: o.productEvidence.source,
    sample: o.productEvidence.sample,
  },
  service: o.sellerEvidence && {
    subject: o.sellerEvidence.subject,
    scope: o.sellerEvidence.scope,
    source: o.sellerEvidence.source,
    sample: o.sellerEvidence.sample,
  },
});
class SourceUnavailable extends Error {}
async function prepare(s, r) {
  await help(s, 'shopping_alternatives');
  const data = await until(async () => {
    const c = await comparison(s);
    return (
      c &&
      (c.baseline || ['source_unavailable', 'needs_baseline', 'unsupported'].includes(c.status)) &&
      c
    );
  }, 'current baseline');
  if (!data.baseline) throw new SourceUnavailable(data.status + ': ' + data.message);
  assert.equal(new URL(data.baseline.url).origin, new URL(r.start).origin);
  const v = await state(s),
    owner = v.chat.turns.find((t) => t.id === v.chat.activeTurnId);
  assert.equal(owner.feature, 'shopping_alternatives');
  assert.equal(owner.operationId, data.id);
  assert(!owner.historical);
  await s.panel.waitForSelector('section[aria-label="Compare alternatives"] .comparison-form', {
    visible: true,
  });
  r.baseline = facts(data.baseline);
  return data;
}
async function assess(s, r, which) {
  await help(s, which === 'seller' ? 'seller_assessment' : 'product_assessment');
  const d = await until(
    async () => {
      const v = await state(s),
        owner = v.chat?.turns.find((t) => t.id === v.chat.activeTurnId);
      if (owner?.state === 'unavailable') throw new SourceUnavailable(owner.text);
      const got = v.shopping?.[which]?.data;
      return got && owner?.operationId === got.binding.operationId && !owner.historical && got;
    },
    'bound ' + which + ' card',
  );
  const name = which === 'seller' ? 'Seller assessment' : 'Product assessment';
  await s.panel.waitForSelector('article[aria-label="' + name + '"]', { visible: true });
  if (['source_unavailable', 'unsupported'].includes(d.status)) throw new SourceUnavailable(d.note);
  assert.equal(d.kind, which);
  assert.equal(new URL(d.binding.origin).origin, new URL(r.start).origin);
  if (d.source) await sourceUrl(d.source);
  const output = await s.panel.$eval('article[aria-label="' + name + '"]', (e) => ({
    text: e.innerText,
    source: [...e.querySelectorAll('a')].map((el) => el.href),
  }));
  for (const src of output.source) await sourceUrl(src);
  assert(output.text.includes(d.scope));
  assert(output.text.includes(d.note));
  if (which === 'seller') {
    assert(d.context.seller);
    assert(output.text.includes(d.context.seller));
  } else {
    assert(d.context.catalog);
    assert(output.text.includes(d.context.catalog));
  }
  r.assessment = {
    kind: which,
    scope: d.scope,
    filter: d.filter,
    status: d.status,
    subject: which === 'seller' ? d.context.seller : d.context.catalog,
    source: d.source,
    sample: d.records.length,
    captured: d.captured,
  };
  await shot(s, r, 'assessment');
  r.caseChecks['S8-F03'] = [
    'A new chat Help action produced a fresh ' +
      which +
      ' assessment bound to the exact subject, operation and original document. Observed coverage, source and missing information matched the rendered card.',
  ];
}
async function configure(s, name) {
  const software = name === 'mozilla',
    book = name === 'book',
    fixture = name === 'longNames';
  const mode = book || fixture ? 'same_product_other_sellers' : 'similar_products';
  const goal = book
    ? 'Find the same 1961 first printing from another seller.'
    : software
      ? 'Compare Firefox ad blockers with published product feedback.'
      : fixture
        ? 'Compare the same practice pen from another seller.'
        : 'Compare fountain pens with a fine or extra-fine nib.';
  await type(s, 'Comparison goal', goal);
  await (await field(s, 'Comparison mode')).select(mode);
  await type(
    s,
    'Public search terms',
    book ? 'french cooking' : software ? 'ad blocker' : 'fountain pen',
  );
  const differences = software
    ? ['product', 'model', 'version']
    : name === 'pen'
      ? ['product', 'model', 'nib', 'condition']
      : [];
  for (const difference of differences) {
    const el = await field(s, difference);
    if (!(await el.evaluate((n) => n.checked))) await el.click();
  }
  const hard = software
    ? [
        ['platform', 'Firefox'],
        ['ad blocking', 'yes'],
      ]
    : name === 'pen'
      ? [['nib', 'fine or extra-fine']]
      : [];
  for (const [i, [key, value]] of hard.entries()) {
    await button(s.panel, 'Add requirement').click();
    await type(s, 'Required attribute ' + (i + 1), key);
    await type(s, 'Required value ' + (i + 1), value);
  }
  return { goal, mode, hard };
}
async function result(s, r, b, config) {
  await button(s.panel, 'Find options').click();
  const c = await until(async () => {
    const v = await comparison(s);
    return (
      v &&
      v.id === b.id &&
      v.version > b.version &&
      [
        'ready',
        'partial',
        'needs_checking',
        'no_matches',
        'only_baseline',
        'source_unavailable',
        'unsupported',
      ].includes(v.status) &&
      v
    );
  }, 'settled current comparison');
  if (c.status === 'source_unavailable') throw new SourceUnavailable(c.message);
  assert(c.baseline && c.baseline.id === b.baseline.id);
  assert.equal(c.settings.goal, config.goal);
  assert.equal(c.settings.mode, config.mode);
  for (const [field, value] of config.hard)
    assert(c.settings.hard.some((x) => x.field === field && x.value === value && !x.exclude));
  assert(c.coverage.batches > 0 && c.coverage.searched > 0, c.message);
  assert(c.candidates.length <= 3);
  assert.equal(new Set(c.candidates.map((x) => x.offer.id)).size, c.candidates.length);
  r.result = {
    status: c.status,
    coverage: c.coverage,
    original: c.baseline.id,
    settings: c.settings,
    discovery: c.searchSource ?? null,
    excluded: c.excludedReasons ?? [],
    candidates: [],
  };
  const scope = 'section[aria-label="Compare alternatives"]';
  await s.panel.waitForSelector(scope + ' [data-testid="comparison-status"]', { visible: true });
  if (c.searchSource) {
    await sourceUrl(c.searchSource, r.name === 'longNames');
    assert(
      await s.panel.$eval(
        scope,
        (e, url) => Array.from(e.querySelectorAll('a')).some((a) => a.href === url),
        c.searchSource,
      ),
    );
  }
  for (const x of c.candidates) {
    const o = x.offer;
    assert(o.id !== c.baseline.id && o.market === c.baseline.market);
    if (o.productEvidence) assert.equal(o.productEvidence.subject, o.catalog);
    if (o.sellerEvidence) assert.equal(o.sellerEvidence.subject, o.seller);
    if (r.name === 'mozilla') {
      assert(!o.seller && !o.sellerEvidence);
      if (x.fit === 'confirmed') assert(/^yes$/i.test(o.attributes['ad blocking'] ?? ''));
    }
    if (r.name === 'pen' && x.fit === 'confirmed')
      assert(/extra.?fine|\bfine\b/i.test(o.attributes.nib ?? ''), JSON.stringify(o.attributes));
    if (r.name === 'book' && x.fit === 'confirmed') {
      assert.notEqual(o.seller, c.baseline.seller);
      assert.equal(o.catalog, c.baseline.catalog);
    }
    if (
      !o.cost.currency ||
      !c.baseline.cost.currency ||
      o.cost.currency !== c.baseline.cost.currency
    )
      assert.equal(x.savings, null);
    await sourceUrl(o.url, r.name === 'longNames');
    const card = await s.panel.waitForSelector(scope + ' article[data-offer-id="' + o.id + '"]');
    const details = await card.$('summary::-p-text(Attributes and sources)');
    assert(details);
    await details.click();
    const observed = await card.evaluate((el) => ({
      text: el.innerText,
      links: [...el.querySelectorAll('a[href]')].map((a) => a.href),
    }));
    assert(
      observed.text.includes(o.title) &&
        observed.text.includes('Product reviews') &&
        observed.text.includes('Seller feedback'),
    );
    for (const link of observed.links) await sourceUrl(link, r.name === 'longNames');
    r.result.candidates.push({
      offer: facts(o),
      fit: x.fit,
      recommended: x.recommended,
      subtotal: x.subtotal,
      savings: x.savings,
      tradeoffs: x.tradeoffs,
      sources: observed.links,
    });
    await details.click();
  }
  await shot(s, r, 'comparison');
  r.caseChecks['S8-F04'] = [
    'The user selected the comparison tool from chat, explicitly confirmed Find options, and observed the actual mode, original listing, hard filters and returned candidates or lack of a suitable alternative. Each inspected offer retained its own fit, cost basis, seller and product evidence.',
  ];
  return c;
}
async function longNames(s, r) {
  await s.page.select('#comparison-scenario', 'long-text');
  await s.page.waitForFunction(
    () => document.querySelector('#fixture-state').textContent === 'long-text',
  );
  const b = await prepare(s, r),
    config = await configure(s, r.name),
    c = await result(s, r, b, config);
  assert(c.candidates.some((x) => x.offer.id === 'long-item'));
  await button(s.panel, 'Settings').click();
  await s.panel.locator('summary::-p-text(Reading and conversation)').click();
  const checkbox = await s.panel.waitForSelector('::-p-aria(Larger text[role="checkbox"])');
  await checkbox.click();
  await button(s.panel, 'Close Settings').click();
  await button(s.panel, 'Compare selected').click();
  const table = await s.panel.waitForSelector('[aria-label="Side-by-side comparison"]', {
    visible: true,
  });
  await table.focus();
  await table.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const geo = await table.evaluate((el) => {
    const box = el.getBoundingClientRect(),
      log = document.querySelector('[role=log]'),
      composer = document.querySelector('#chat-composer').getBoundingClientRect();
    const before = el.scrollLeft;
    el.scrollLeft = el.scrollWidth;
    const bodyRow = el.querySelector('tbody tr:nth-child(2)');
    el.scrollTop += bodyRow.getBoundingClientRect().top - box.top - 12;
    const bodyRect = bodyRow.getBoundingClientRect();
    const hit = document.elementFromPoint(box.right - 28, Math.max(box.top + 3, bodyRect.top + 7));
    return {
      width: innerWidth,
      height: innerHeight,
      rootWidth: document.documentElement.scrollWidth,
      logWidth: log.clientWidth,
      logScroll: log.scrollWidth,
      localOverflow: el.scrollWidth > el.clientWidth,
      scrollDelta: el.scrollLeft - before,
      bodyRowReachable: hit?.closest('tr') === bodyRow && bodyRect.top < box.bottom,
      tableWidth: box.width,
      composerOnscreen: composer.top >= 0 && composer.bottom <= innerHeight,
      focused: el === document.activeElement,
      font: parseFloat(getComputedStyle(el).fontSize),
      title: el.querySelector('caption')?.textContent,
    };
  });
  assert(
    geo.focused &&
      geo.localOverflow &&
      geo.scrollDelta > 0 &&
      geo.font >= 18 &&
      geo.composerOnscreen,
  );
  assert(geo.rootWidth <= geo.width + 1 && geo.logScroll <= geo.logWidth + 1, JSON.stringify(geo));
  assert(geo.bodyRowReachable, 'A long sticky header covered the comparison body row.');
  r.geometry = geo;
  await shot(s, r, 'large-table');
  const previous = (await state(s)).chat.activeTurnId;
  await s.page.click('#change-variant');
  await until(async () => {
    const v = await state(s);
    const turn = v.chat.turns.find((t) => t.id === previous);
    return turn?.historical && !v.chat.activeTurnId;
  }, 'old comparison card retired on variant change');
  assert.equal(await s.panel.$('article[data-turn="' + previous + '"] button'), null);
  assert(await s.panel.$('article[data-turn="' + previous + '"] .history-label'));
  await shot(s, r, 'retired');
  r.caseChecks['S8-U06'] = [
    'A labelled long-name comparison rendered at larger text. Its focusable labelled table scrolled horizontally while the document and transcript kept their widths and the composer stayed visible.',
  ];
  r.caseChecks['S8-A02'] = [
    'Changing the fixture variant retired the active comparison, retained a historical label and removed every executable button from the old card.',
  ];
}

const forbiddenFile = /\.(?:exe|xpi|msi|zip|7z|dmg)(?:$|[?#])/i;
const forbiddenRoute =
  /\/(?:checkout|purchase|install|message\/send|vote|cart\/add|watch)(?:\/|$)/i;
const modelDomain = 'generativelanguage.googleapis.com';
function prohibited(raw) {
  const u = new URL(raw);
  return (
    u.hostname === modelDomain ||
    forbiddenFile.test(u.pathname) ||
    forbiddenRoute.test(u.pathname) ||
    (u.port === '4317' &&
      /^\/v1\/(?:chat|assist|explain|shopping\/explain|compare\/(?:intent|explain))/.test(
        u.pathname,
      ))
  );
}
async function run(name, width) {
  const r = {
    name,
    width,
    status: 'fail',
    source: name === 'longNames' ? 'labelled localhost fixture' : 'real public source',
    start: starts[name],
    caseChecks: {},
    screens: [],
    reads: [],
    forbidden: [],
  };
  let s;
  try {
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, r.start, {
      attachWorker: true,
      prepare: async (p) => {
        await p.setRequestInterception(true);
        p.on('request', (request) => {
          if (prohibited(request.url())) {
            const u = new URL(request.url());
            r.forbidden.push(u.origin + u.pathname);
            void request.abort().catch(() => {});
          } else void request.continue().catch(() => {});
        });
      },
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const ex = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    );
    assert(ex?.enabled && resolve(ex.path) === bundle);
    r.loaded = { id: ex.id, path: ex.path };
    const t = await s.browser.waitForTarget(
      (t) =>
        t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + s.id + '/'),
    );
    const network = (await t.worker()).client;
    await network.send('Network.enable');
    network.on('Network.responseReceived', (e) => {
      const u = new URL(e.response.url);
      if (
        (u.hostname === 'api.resell.store' && u.pathname.startsWith('/v1/')) ||
        (u.hostname === 'addons.mozilla.org' && u.pathname.startsWith('/api/')) ||
        (u.origin === lab.origin && u.pathname.includes('/source/'))
      )
        r.reads.push({ origin: u.origin, path: u.pathname, http: e.response.status });
    });
    await network.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*://' + modelDomain + '/*' },
        { urlPattern: '*://127.0.0.1:4317/v1/*' },
      ],
    });
    network.on('Fetch.requestPaused', (e) => {
      if (prohibited(e.request.url)) {
        const u = new URL(e.request.url);
        r.forbidden.push(u.origin + u.pathname);
        void network
          .send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Aborted' })
          .catch(() => {});
      } else void network.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    });
    await s.page.waitForFunction(
      () => document.readyState === 'complete' && !!document.querySelector('h1'),
      { timeout: 30000 },
    );
    if (name === 'longNames') await longNames(s, r);
    else {
      await assess(s, r, name === 'mozilla' ? 'product' : 'seller');
      const b = await prepare(s, r),
        config = await configure(s, name);
      await result(s, r, b, config);
      assert(
        r.reads.some((z) => z.http >= 200 && z.http < 300),
        'No successful public source request recorded.',
      );
    }
    assert.deepEqual(r.forbidden, []);
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message).slice(0, 470);
    if (e instanceof SourceUnavailable || /net::ERR_/.test(r.error)) r.status = 'blocked';
    if (s) await shot(s, r, 'diagnostic').catch(() => {});
  } finally {
    if (s) await s.browser.close();
    results.push(r);
    await save();
    console.log(r.status, name, width, r.error ?? '');
  }
}
for (const w of [1440, 1366]) {
  if (widthFlag && Number(widthFlag) !== w) continue;
  // The variant-switch case deliberately changes its server-side practice item.
  // Give each measured width its own fixture state before taking the baseline.
  lab = await startFixture(0);
  starts.longNames = lab.origin + '/comparison-lab/original';
  try {
    for (const name of cases) await run(name, w);
  } finally {
    lab.server.close();
  }
}
if (!results.length || results.some((r) => r.status !== 'pass')) process.exitCode = 1;
