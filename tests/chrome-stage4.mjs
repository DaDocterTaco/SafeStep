import assert from 'node:assert/strict';
import { openArea, openDetails } from './support/stage7-panel.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import { shoppingChoices } from '@safestep/contracts';
import { once } from 'node:events';
import {installRepairCases} from './support/stage4-repair-cases.mjs';
const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle),
  out = resolve('.test-artifacts/stage4', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const fixture = await startFixture(0),
  base = fixture.origin + '/shopping-lab/',
  shop = 'https://foxedandfound.resell.store/mastering-art-french-cooking-1961',
  addon = 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/';
const results = [],
  chosen = (process.env.SAFESTEP_S4_CASES ?? 'seller,product,practice,lifecycle,ai,recovery').split(
    ',',
  );
const button = (p, n) => p.locator('::-p-aria(' + n + '[role="button"])').setTimeout(8000);
async function until(f, label, ms = 13500) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const x = await f();
    if (x) return x;
    await sleep(70);
  }
  throw Error('Timed out: ' + label);
}
async function data(p, k) {
  return (await view(p)).v.shopping?.[k]?.data;
}
async function check(p, k, keyboard = false) {
  await openArea(p,'Shopping');
  const before = (await data(p, k))?.binding.operationId;
  const name = 'Check ' + k;
  if (keyboard) {
    const el = await p.waitForSelector('::-p-aria(' + name + '[role="button"])');
    await el.focus();
    await p.keyboard.press('Enter');
  } else await button(p, name).click();
  return until(async () => {
    const d = await data(p, k);
    return d && d.binding.operationId !== before && d;
  }, name);
}
async function screenshot(s, r, kind) {
  const selector =
    'article[aria-label="' + (kind === 'seller' ? 'Seller' : 'Product') + ' assessment"] h3';
  await s.panel.$eval(selector, (e) => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await s.panel.screenshot({ path: join(out, r.name + '-' + r.width + '.png') });
}
async function run(name, w, h, start, fn) {
  const r = {
    name,
    width: w,
    height: h,
    checks: [],
    status: 'fail',
    requests: [],
    consequentialAttempts: 0,
    downloads: 0,
  };
  let s;
  try {
    s = await nativeSession(bundle, w, h, start, {
      prepare: async (p) => {
        await p.setRequestInterception(true);
        p.on('request', (q) => {
          const u = new URL(q.url());
          if (
            /(?:\/checkout|\/cart\/(?:add|buy)|\/purchase\/|\/vote\/|\/message\/send|\.xpi$)/i.test(
              u.pathname,
            )
          ) {
            r.consequentialAttempts++;
            void q.abort();
            return;
          }
          if (
            (u.hostname === 'api.resell.store' && u.pathname.startsWith('/v1/')) ||
            (u.hostname === 'addons.mozilla.org' && u.pathname.startsWith('/api/v5/'))
          ) {
            const keys = Object.keys(q.headers());
            r.requests.push({
              path: u.pathname,
              method: q.method(),
              credential: keys.some((k) => ['cookie', 'authorization'].includes(k)),
              fromSafeStep: (q.initiator()?.stack?.callFrames ?? []).some((f) =>
                f.url.startsWith('chrome-extension://'),
              ),
              parameters: [...u.searchParams.keys()],
            });
          }
          void q.continue();
        });
      },
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    await fn(s, r);
    assert.equal(r.consequentialAttempts, 0);
    assert.equal(r.downloads, 0);
    assert(
      !r.requests.some((q) => q.fromSafeStep && (q.method !== 'GET' || q.credential)),
      'SafeStep public read carried credentials or used a mutating method',
    );
    r.status = 'pass';
  } catch (e) {
    r.error = e.message.slice(0, 350);
    r.stack = e.stack
      ?.split('\n')
      .filter((line) => line.includes('chrome-stage4'))
      .slice(0, 2);
    if (s) {
      const v = (await view(s.panel).catch(() => ({ v: {} }))).v;
      r.diagnostic = {
        url: new URL(s.page.url()).origin,
        access: v.access,
        alerts: await s.panel.$$eval('[role=alert]', (els) => els.map((x) => x.textContent)),
        cards: Object.fromEntries(
          Object.entries(v.shopping ?? {}).map(([k, x]) => [
            k,
            { status: x.data.status, note: x.data.note },
          ]),
        ),
      };
    }
  } finally {
    if (s) await s.browser.close();
    results.push(r);
    await writeProgress('in_progress');
    console.log(r.status, r.name, w, r.error ?? '', JSON.stringify(r.diagnostic ?? {}));
  }
}
async function writeProgress(status) {
  const name = 'progress-' + chosen.join('-') + '-' + (process.env.SAFESTEP_WIDTH ?? 'both') + '.json';
  await writeFile(join(out, name), JSON.stringify({
    role: 'builder', sha256, bundle, status, at: new Date().toISOString(),
    completed: results.map(({name, width, status, error, diagnostic}) => ({name, width, status, error, diagnostic})),
  }, null, 2));
}
async function seller(s, r) {
  await s.page.waitForFunction(()=>document.readyState==='complete'&&document.body.innerText.includes('Mastering the Art of French Cooking'),{timeout:18000});
  const d = await check(s.panel, 'seller', true);
  r.observed = {
    subject: d.context,
    metrics: d.metrics,
    status: d.status,
    records: d.records.map((x) => ({
      listing: x.listing,
      id: x.platformId,
      published: x.published,
      rating: x.rating,
    })),
    scope: d.scope,
  };
  assert.equal(d.context.seller, 'foxedandfound');
  assert.equal(d.context.display, 'Foxed & Found');
  assert(
    d.context.listing && d.records.length && d.metrics.some((m) => m.label.includes('Average')),
  );
  assert(
    d.records.every(
      (x) => x.channel === 'seller_received_feedback' && x.subject === 'foxedandfound',
    ),
  );
  assert(d.records.some((x) => x.listing && x.listing !== d.context.listing));
  assert(!d.context.catalog);
  r.checks.push(
    'Live listing matched the exact Resell shop and listing UUID. Received shop reviews link a distinct listing. Date, capture time, aggregate and sampled count are separate.',
  );
  await screenshot(s, r, 'seller');
  const prod = await check(s.panel, 'product');
  assert.equal(prod.status, 'limited_evidence');
  assert.equal(prod.records.length, 0);
  assert.equal(prod.context.listing, d.context.listing);
  assert((await data(s.panel, 'seller')).binding.operationId === d.binding.operationId);
  const target = s.browser.waitForTarget((t) => t.type() === 'page' && t.url() === d.source, {
    timeout: 10000,
  });
  await s.panel.locator('article[aria-label="Seller assessment"] a::-p-text(View source)').click();
  const p = await (await target).asPage();
  await p.bringToFront();
  await until(async () => {
    const v = (await view(s.panel)).v;
    return !v.shopping?.seller && v.access === 'permission_required';
  }, 'new tab requires own access');
  await s.activate(p);
  await until(async () => (await view(s.panel)).v.access === 'temporary', 'new source invocation');
  const src = await check(s.panel, 'seller');
  assert.equal(src.context.seller, 'foxedandfound');
  assert.equal(src.context.listing, null);
  assert.notEqual(src.binding.tabId, d.binding.tabId);
  r.checks.push(
    'Explicitly opened official public feedback source in a new tab, reauthorized, captured matching shop without transferring listing refs.',
  );
}
async function product(s, r) {
  const d = await check(s.panel, 'product', true);
  r.observed = {
    context: d.context,
    metrics: d.metrics,
    status: d.status,
    sample: d.records.length,
    versions: [...new Set(d.records.map((x) => x.version))],
    dates: d.records.map((x) => x.published),
    scope: d.scope,
  };
  assert.equal(d.context.catalog, 'amo_607454');
  assert(d.context.variant);
  assert(d.records.length > 1 && d.records.length <= 20);
  assert(d.metrics.some((m) => m.label === 'Written reviews (catalog)'));
  assert(
    d.records.every(
      (x) => x.subject === d.context.catalog && x.channel === 'catalog_product_review' && !x.soldBy,
    ),
  );
  await screenshot(s, r, 'product');
  const seller = await check(s.panel, 'seller');
  assert.equal(seller.status, 'unsupported');
  assert.equal(seller.records.length, 0);
  const a = await s.page.$('a[href*="/addon/ublock-origin/reviews/"]');
  assert(a);
  await a.click();
  await s.page.waitForFunction(() => location.pathname.includes('/reviews/'));
  await until(async () => !(await data(s.panel, 'product')), 'old product card invalidated');
  const next = await check(s.panel, 'product');
  assert.equal(next.context.catalog, d.context.catalog);
  assert.notEqual(next.binding.operationId, d.binding.operationId);
  await s.page.goto(addon + 'reviews/?score=5', { waitUntil: 'domcontentloaded' });
  const filtered = await check(s.panel, 'product');
  r.filtered = {
    scope: filtered.filter,
    records: filtered.records.length,
    ratings: filtered.records.map((x) => x.rating),
    route: s.page.url(),
  };
  assert(filtered.filter.includes('5 stars'), 'filtered scope: ' + filtered.filter);
  assert(
    filtered.records.length && filtered.records.every((x) => x.rating === 5),
    'filtered sample did not contain matching ratings',
  );
  r.checks.push(
    'Live catalog ID, version, product average, ratings, written counts, dates and capped sample confirmed on listing and reviews page. Publisher was not treated as seller.',
  );
}
async function practice(s, r) {
  const modes = [
    'mixed',
    'inverse',
    'sparse',
    'cross-seller',
    'wrong-seller',
    'wrong-product',
    'pooled',
    'device-variant',
    'buyer',
    'left',
    'duplicate',
    'automated',
    'zero',
    'empty',
    'loading',
    'denied',
    'conflict',
    'hostile',
    'truncated',
    'node-limit',
    'duplicate-source',
  ];
  for (const mode of modes) {
    if(mode!==modes[0]){
      await openArea(s.panel,'Settings'); await openDetails(s.panel, 'Access & preferences');
      await button(s.panel,'Clear SafeStep data').click();await until(async()=>(await view(s.panel)).v.access==='permission_required','separate practice session');
      await s.activate(s.page);await until(async()=>(await view(s.panel)).v.access==='temporary','practice access');
    }
    await s.page.select('#scenario', mode);
    const seller = await check(s.panel, 'seller'),
      product = await check(s.panel, 'product');
    const text = await s.panel.$eval('section[aria-label="Shopping checks"]', (e) => e.innerText);
    assert(
      !/PRIVATE_BUYER_HANDLE|PRIVATE_SHOP_|person@example.org|555-123/.test(
        JSON.stringify([seller, product]) + text,
      ),
    );
    assert(!seller.records.some((x) => x.channel !== 'seller_received_feedback'));
    assert(!product.records.some((x) => x.channel === 'seller_received_feedback'));
    if (mode === 'mixed') {
      assert.equal(seller.context.seller, 'second.sale');
      assert.equal(seller.context.store, 'secondsalecom');
      assert.equal(product.context.isbn, '9780525947059');
      assert.equal(product.context.year, '2003');
      assert(text.includes('Recurring in 2 distinct comments'));
      assert(product.records.every((x) => x.soldBy === 'discover-books'));
      assert(text.includes('Concern · packaging'));
      await screenshot(s, r, 'seller');
    }
    if (mode === 'wrong-seller') assert.equal(seller.status, 'identity_uncertain');
    if (mode === 'wrong-product') assert.equal(product.status, 'identity_uncertain');
    if (mode === 'buyer' || mode === 'left') assert.equal(seller.records.length, 0);
    if (mode === 'pooled') assert(product.scope.includes('Pooled'));
    if (mode === 'device-variant') {
      assert.equal(product.context.isbn, null);
      assert.equal(product.context.catalog, 'device_64_red');
      assert.equal(product.context.condition, 'New');
      await s.page.click('#variant');
      const other = await check(s.panel, 'product');
      assert.equal(other.context.catalog, 'device_128_blue');
      assert.equal(other.context.variant, '128 GB · blue');
      assert.equal(other.context.condition, 'Refurbished');
      await s.page.click('#variant');
    }
    if (mode === 'inverse') {
      assert.equal(seller.metrics.find((m) => m.unit === 'percent')?.value, 98);
      assert.equal(product.metrics.find((m) => m.unit === 'stars')?.value, 2);
    }
    if (mode === 'node-limit') {
      assert(product.limited && seller.limited);
      assert.equal(product.records.length, 0);
    }
    if (mode === 'duplicate-source') {
      assert.equal(seller.target, null);
      assert(product.target);
    }
    if (mode === 'duplicate' || mode === 'automated') assert(!text.includes('Recurring in'));
    if (mode === 'automated') assert.equal(seller.records.filter((x) => x.automated).length, 2);
    if (mode === 'zero') assert.equal(product.status, 'explicit_zero');
    if (mode === 'empty') {
      assert.equal(seller.status, 'no_reviews_in_view');
      assert(seller.filter.includes('page 2'));
      assert(seller.metrics.some(m=>m.label==='Feedback records'&&m.value>0));
    }
    if (mode === 'loading') assert.equal(seller.status, 'loading');
    if (mode === 'denied') assert.equal(product.status, 'source_unavailable');
    if (mode === 'conflict')
      assert.equal(product.metrics.filter((x) => x.label === 'Catalog average').length, 2);
    if (mode === 'cross-seller' || mode === 'sparse') {
      assert.equal(product.records[0].published, '2017-02-04');
      assert.equal(product.status, 'limited_evidence');
    }
    if (mode === 'truncated') {
      assert.equal(product.records.length, 20);
      assert(product.limited);
    }
    r.checks.push({
      mode,
      seller: seller.status,
      product: product.status,
      sample: [seller.records.length, product.records.length],
    });
  }
  assert.equal(await s.page.$eval('#transactions', (e) => e.textContent), '0');
}
async function lifecycle(s, r) {
  await s.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const d = await check(s.panel, 'seller', true);
  assert(d.target);
  let a = await s.panel.$('article[aria-label="Seller assessment"]');
  assert(a);
  await button(s.panel, 'Show evidence on page').click();
  await until(async () => s.page.$('[data-safestep-outline]'), 'source cue');
  await s.page.click('#switchshop');
  await until(
    async () => !(await data(s.panel, 'seller')) && !(await s.page.$('[data-safestep-outline]')),
    'changed subject cleared',
  );
  const other = await check(s.panel, 'seller');
  assert.equal(other.context.seller, 'second_sale');
  assert.equal((await view(s.panel)).v.shopping.seller.history.length, 1);
  const source = await check(s.panel, 'product');
  await s.page.click('#variant');
  await until(async () => !(await data(s.panel, 'product')), 'edition changed');
  const edition = await check(s.panel, 'product');
  assert.notEqual(edition.context.isbn, source.context.isbn);
  await button(s.panel, 'Refresh current evidence').click();
  await until(
    async () => ((await view(s.panel)).v.shopping?.product?.history.length ?? 0) >= 2,
    'same exact scope refreshed',
  );
  await s.panel.locator('summary::-p-text(Gemini explanation)').click();
  await button(s.panel, 'Explain this summary with Gemini').click();
  await s.panel.waitForFunction(() => document.body.innerText.includes('Gemini unavailable'));
  const dismiss = await s.panel.$(
    'article[aria-label="Product assessment"] button::-p-text(Dismiss details)',
  );
  await dismiss.focus();
  await s.panel.keyboard.press('Enter');
  await until(async () => !(await data(s.panel, 'product')), 'dismiss');
  assert.equal(await s.panel.evaluate(() => document.activeElement.textContent), 'Check product');
  await s.page.select('#scenario', 'delayed');
  await button(s.panel, 'Check seller').click();
  await button(s.panel, 'Cancel analysis').click();
  await sleep(850);
  assert.equal(await data(s.panel, 'seller'), undefined);
  await changeEditionDuringRead(s, r);
  await s.page.select('#scenario', 'mixed');
  await check(s.panel, 'seller');
  await s.tabSession.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 301000 });
  await until(async () => !(await data(s.panel, 'seller')), 'five-minute evidence expiration');
  r.checks.push(
    'Chrome advanced document time past five minutes. The card expired and required a fresh inspection.',
  );
  r.checks.push(
    'Reduced motion and keyboard; source found beyond 38 controls, valid outline. Seller change, edition change and cancellation fenced stale and late results; exact-source history isolated. Offline AI preserved the local card. Dismiss restored focus.',
  );
}
async function changeEditionDuringRead(s, r) {
  assert.equal(await s.page.$eval('#product-section', (el) => el.dataset.delay), '650');
  const before = await s.page.$eval('#shop-listing', (el) => el.dataset.isbn);
  const session = s.tabSession;
  const scripts = [];
  const onScript = (event) => {
    if (event.url.includes(s.id) || (event.length > 100000 && !event.url)) scripts.push(event);
  };
  let breakpoint, pause;
  const onPause = (event) => { pause = event; };
  session.on('Debugger.scriptParsed', onScript);
  session.on('Debugger.paused', onPause);
  try {
    await session.send('Debugger.enable');
    let script, scriptSource;
    for (const candidate of scripts) {
      const source = await session.send('Debugger.getScriptSource', {scriptId: candidate.scriptId});
      if (source.scriptSource.includes('.dataset.delay') && source.scriptSource.includes('shop-result')) {
        script = candidate;
        scriptSource = source.scriptSource;
        break;
      }
    }
    assert(script, 'the tab exposes SafeStep’s compiled shopping bridge to DevTools');
    const hit = scriptSource.indexOf('.dataset.delay');
    assert(hit > 0 && scriptSource.indexOf('.dataset.delay', hit + 1) < 0, 'unique practice delay in compiled extension');
    const position = scriptSource.lastIndexOf('Number(document.getElementById(', hit);
    assert(position >= 0 && hit - position < 160, 'local practice reader call');
    const prefix = scriptSource.slice(0, position).split('\n');
    const location = {lineNumber: prefix.length - 1, columnNumber: prefix.at(-1).length};
    const bySource = script.url ? {url: script.url} : {scriptHash: script.hash};
    const installed = await session.send('Debugger.setBreakpointByUrl', {...bySource, ...location});
    breakpoint = installed.breakpointId;
    r.editionRace = {script: script.url, scriptHash: script.hash, location, resolved: installed.locations};
    assert(installed.locations.length, 'breakpoint resolves in the actual loaded bridge');
    await button(s.panel, 'Check product').click();
    await until(() => pause, 'execution paused inside compiled shopping reader');
    assert(pause.hitBreakpoints.includes(breakpoint), 'paused at the expected real reader');
    const frame = pause.callFrames[0];
    const seen = await session.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId, returnByValue: true,
      expression: '({isbn:document.querySelector("#shop-listing").dataset.isbn, delay:document.querySelector("#product-section").dataset.delay, at:performance.now()})',
    });
    assert(!seen.exceptionDetails && seen.result.value);
    const received = seen.result.value;
    assert.equal(received.isbn, before);
    assert.equal(received.delay, '650');
    // The worker checkpoint binds the already-running read to this document and operation.
    const binding = await s.panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      const key = 'task:' + tab.id;
      return (await chrome.storage.session.get(key))[key]?.shopping?.product;
    });
    assert(binding?.operationId && binding.documentId);
    await session.send('Debugger.removeBreakpoint', {breakpointId: breakpoint});
    breakpoint = null;
    await session.send('Debugger.resume');
    pause = null;
    await s.page.click('#variant');
    const switched = await s.page.$eval('#shop-listing', (el) => ({isbn: el.dataset.isbn, at: performance.now()}));
    const elapsed = switched.at - received.at;
    Object.assign(r.editionRace, {received, switched, elapsed, document: binding.documentId, operation: binding.operationId});
    assert.notEqual(switched.isbn, before);
    assert(elapsed >= 0 && elapsed < 650, 'edition changed during the delayed page read: ' + elapsed + ' ms');
    await sleep(900);
    const returned = await data(s.panel, 'product');
    r.editionRace.returned = returned ? {isbn: returned.context.isbn, operation: returned.binding.operationId} : null;
    assert.equal(returned, undefined, 'capture survived the in-flight edition change: ' + JSON.stringify(r.editionRace));
  } finally {
    if (breakpoint) await session.send('Debugger.removeBreakpoint', {breakpointId: breakpoint}).catch(() => {});
    if (pause) await session.send('Debugger.resume').catch(() => {});
    await session.send('Debugger.disable').catch(() => {});
    session.off('Debugger.scriptParsed', onScript);
    session.off('Debugger.paused', onPause);
  }
}
async function ai(s, r) {
  let count = 0,
    mode = 'valid';
  const pair = newPairToken(),
    inputs = [];
  const svc = new GeminiService(
    { GEMINI_API_KEY: 'labelled-test-only', GEMINI_MODEL: 'gemini-test-fixture' },
    pair,
    async () => ({ text: '', tokens: null }),
    2800,
    async (input) => {
      count++;
      inputs.push(input);
      const c = shoppingChoices(input);
      const answer = { ...c, strengths: c.strengths.slice(0, 3), concerns: c.concerns.slice(0, 3) };
      if (mode === 'late') await sleep(1100);
      return {
        text: JSON.stringify(
          mode === 'invalid' ? { ...answer, summary: 'Fraud verdict without evidence' } : answer,
        ),
        tokens: null,
      };
    },
  );
  const server = makeApi(undefined, svc);
  server.listen(4317, '127.0.0.1');
  await once(server, 'listening');
  try {
    await openArea(s.panel,'Settings'); await openDetails(s.panel, 'Connect local AI');
    await s.panel.type('input[type=password]', pair);
    await button(s.panel, 'Connect').click();
    await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'));
    await check(s.panel, 'seller');
    await s.panel.locator('summary::-p-text(Gemini explanation)').click();
    await button(s.panel, 'Explain this summary with Gemini').click();
    await s.panel.waitForFunction(() =>
      document
        .querySelector('.shopping-card details:last-child')
        ?.innerText.includes('Service feedback applies'),
    );
    const d = await data(s.panel, 'seller');
    assert.equal(inputs[0].operationId, d.binding.operationId);
    assert.equal(inputs[0].kind, 'seller');
    assert(
      !/PRIVATE|second.sale|packaged|Poor packaging|foxedandfound|https:|reviewer/i.test(
        JSON.stringify(inputs),
      ),
    );
    mode = 'invalid';
    await button(s.panel, 'Explain this summary with Gemini').click();
    await s.panel.waitForFunction(() => document.body.innerText.includes('invalid response'));
    mode = 'late';
    await button(s.panel, 'Explain this summary with Gemini').click();
    await until(() => count === 3, 'mock shopping call started');
    await s.page.click('#switchshop');
    await until(
      async () => !(await data(s.panel, 'seller')),
      'changed seller discarded pending AI',
    );
    await sleep(1200);
    assert(!(await s.panel.$eval('body', (e) => e.innerText)).includes('Service feedback applies'));
    await check(s.panel, 'product');
    await s.panel.locator('summary::-p-text(Gemini explanation)').click();
    mode = 'valid';
    await button(s.panel, 'Explain this summary with Gemini').click();
    await s.panel.waitForFunction(() =>
      document.body.innerText.includes('Product feedback applies'),
    );
    await openArea(s.panel,'Settings'); await button(s.panel, 'Disconnect').click();
    await until(
      async () => !(await data(s.panel, 'product')),
      'disconnect cleared protected state',
    );
    r.checks.push(
      'Labelled mock server, four protected calls. Exact seller/product operations carried normalized facts and citations only. Invalid output was rejected, stale seller response discarded, and disconnect cleared captured state. No provider key or live model call.',
    );
  } finally {
    r.mockCalls = count;
    r.aiState = await s.panel
      .$$eval('.shopping-card [role=status]', (els) => els.map((x) => x.textContent))
      .catch(() => []);
    server.close();
    await once(server, 'close');
  }
}
async function recovery(s, r) {
  const d = await check(s.panel, 'seller');
  assert(d.target);
  await button(s.panel, 'Show evidence on page').click();
  const start = Date.now();
  await until(
    async () =>
      !(
        await s.root.send('Target.getTargets', { filter: [{ type: 'service_worker' }] })
      ).targetInfos.some((t) => t.url.startsWith('chrome-extension://' + s.id + '/')),
    'natural worker sleep',
    110000,
  );
  r.idleMs = Date.now() - start;
  assert(await s.page.$('[data-safestep-outline]'));
  assert.equal(await data(s.panel, 'seller'), undefined);
  await until(
    async () => !(await s.page.$('[data-safestep-outline]')),
    'restart cleared shopping cue',
  );
  assert.equal(await s.page.$eval('#transactions', (e) => e.textContent), '0');
  await check(s.panel, 'product');
  await openArea(s.panel,'Settings'); await openDetails(s.panel, 'Access & preferences');
  await button(s.panel, 'Clear SafeStep data').click();
  await until(async () => {
    const v = (await view(s.panel)).v;
    return !v.shopping?.product && v.access === 'permission_required';
  }, 'forget cleared shopping access');
  r.checks.push(
    'Actual worker slept with a shopping cue. Wake retired both binding and cue without replay. Explicit forget cleared the next capture and tab authorization.',
  );
}
try {
  for (const [w, h] of [
    [1440, 900],
    [1366, 768],
  ]) {
    if (process.env.SAFESTEP_WIDTH && String(w) !== process.env.SAFESTEP_WIDTH) continue;
    if(chosen.includes('repairs'))await installRepairCases({run,check,data,button,until,base,addon})(w,h);
    if (chosen.includes('seller')) await run('public-seller', w, h, shop, seller);
    if (chosen.includes('product')) await run('public-product', w, h, addon, product);
    if (chosen.includes('practice')) await run('practice', w, h, base + 'listing', practice);
    if (chosen.includes('lifecycle')) await run('lifecycle', w, h, base + 'listing', lifecycle);
    if (chosen.includes('ai')) await run('mock-shopping-ai', w, h, base + 'listing', ai);
    if (chosen.includes('recovery'))
      await run('shopping-recovery', w, h, base + 'listing', recovery);
  }
} finally {
  fixture.server.close();
}
await writeFile(
  join(out, 'run-' + chosen.join('-') + '-' + (process.env.SAFESTEP_WIDTH ?? 'both') + '.json'),
  JSON.stringify(
    { role: 'builder', bundle, sha256, at: new Date().toISOString(), results },
    null,
    2,
  ) + '\n',
);
if (!results.length || results.some((x) => x.status !== 'pass')) process.exitCode = 1;
await writeProgress('completed');
