// Installed product verification. Public shopping evidence is real; planner and classifier are local fixtures.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localPilotStep } from '@safestep/contracts';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';

const build = process.env.SAFESTEP_NAV_BUILD;
assert.match(build, /^stage-8-[0-9a-f]{12}$/);
const bundle = resolve('artifacts', build, 'chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
assert.equal(build, 'stage-8-' + sha256.slice(0, 12));
const out = resolve(
  'docs/evidence',
  build,
  'shopping-cleanup',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(out, { recursive: true });
const fixture = await startFixture(0),
  rows = [],
  btn = (p, n) => p.locator('::-p-aria(' + n + '[role="button"])').setTimeout(9000);
const state = async (s) => (await view(s.panel)).v;
async function until(check, label, ms = 22000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const a = await check();
    if (a) return a;
    await delay(100);
  }
  throw Error(label);
}
async function submit(s, text) {
  await s.panel.focus('#chat-composer');
  await s.panel.keyboard.type(text);
  await s.panel.keyboard.press('Enter');
}
async function directTool(s, feature) {
  await btn(s.panel, 'Help').click();
  const tool = await s.panel.waitForSelector('.help-tools button[data-feature="' + feature + '"]');
  await tool.click();
}
async function followCatalogCue(s, task) {
  const el = (await s.page.evaluateHandle(() => {
    const ring = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
    if (!ring) return null;
    return [...document.querySelectorAll('input[type=search],a[href]')].find(e => {
      const b = e.getBoundingClientRect();
      return b.width && Math.abs(b.left - ring.left - 3) < 2 && Math.abs(b.top - ring.top - 3) < 2 && Math.abs(b.width - ring.width + 6) < 2;
    }) ?? null;
  })).asElement();
  if (!el) return null;
  const fact = await el.evaluate(e => ({tag:e.localName, href:e.href || null, label:e.getAttribute('aria-label') || e.innerText || null}));
  if (fact.tag === 'input') {
    assert(task.adaptive.searchQuery);
    await el.click();
    await s.page.keyboard.down('Control'); await s.page.keyboard.press('a'); await s.page.keyboard.up('Control');
    await el.type(task.adaptive.searchQuery); await el.press('Enter');
  } else {
    const u = new URL(fact.href);
    assert.equal(u.origin,'https://resell.store');
    assert.equal(u.pathname,'/discover');
    await el.click();
  }
  return fact;
}
async function grantFocused(s) {
  await s.page.bringToFront();
  await s.panel.evaluate(async () => {
    const w = await chrome.windows.getCurrent();
    await chrome.windows.update(w.id, { focused: true });
  });
}
async function capture(s, r, name) {
  const file = r.name + '-' + r.width + '-' + name + '.png';
  await s.panel.screenshot({ path: join(out, file) });
  r.screens.push(file);
}
async function field(s, label) {
  const handle = await s.panel.evaluateHandle(
    (label) =>
      [...document.querySelectorAll('.comparison-form label')]
        .find(
          (e) =>
            [...e.childNodes]
              .filter((x) => x.nodeType === Node.TEXT_NODE)
              .map((x) => x.textContent.trim())
              .join(' ')
              .trim() === label,
        )
        ?.querySelector('input,select'),
    label,
  );
  const el = handle.asElement();
  assert(el, 'Visible comparison field ' + label);
  return el;
}
async function typeField(s, label, value) {
  const el = await field(s, label);
  await el.click();
  await s.panel.keyboard.down('Control');
  await s.panel.keyboard.press('a');
  await s.panel.keyboard.up('Control');
  await s.panel.keyboard.press('Backspace');
  await s.panel.keyboard.type(value);
}
async function run(name, width) {
  const r = {
    name,
    width,
    status: 'fail',
    screens: [],
    source: 'installed native panel; fixture-proposed operations, zero Gemini calls',
    websiteActions: [],
    calls: [],
    fileRequests: 0,
    downloads: 0,
    started: new Date().toISOString(),
  };
  const starts = {
    resell: 'https://resell.store/',
    'resell-guide': 'https://resell.store/',
    mozilla: 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
    'resell-hard': 'https://nibdrawer.resell.store/lamy-2000-makrolon',
    cleanup: fixture.origin + '/cleanup-lab',
  };
  let s, api;
  try {
    const token = newPairToken(),
      reply = (x) => ({ text: JSON.stringify(x), tokens: 0 });
    const chat = async (i) => {
      const text = i.text.toLowerCase();
      const feature = text.startsWith('open a confirmed')
        ? 'automatic_navigation'
        : text.includes('similar pens')
          ? 'shopping_alternatives'
        : text.includes('clean')
          ? 'page_cleanup'
          : text.includes('seller')
            ? 'seller_assessment'
            : 'product_assessment';
      r.calls.push({ kind: 'route', feature });
      return reply({
        kind: 'routed',
        feature,
        reason: 'Labelled product verification proposal.',
        slots: feature==='shopping_alternatives'?{subjectRef:null,mode:'similar_products'}:feature==='page_cleanup'?{}:{subjectRef:null},
      });
    };
    const assist = async (i) => {
      r.calls.push({ kind: i.kind, path: i.snapshot?.path ?? null,limited:i.snapshot?.limited,
        controls:i.snapshot?.controls.map(c=>({role:c.role,action:c.action,label:c.label,path:c.path,targetOrigin:c.targetOrigin??null})) });
      if (i.kind === 'intent')
        return reply({
          action: 'find_document',
          subjects: [{ text: i.goal, start: 0, end: i.goal.length }],
          constraints: [],
          excluded: [],
          question: '',
          choices: [],
        });
      return reply(localPilotStep(i.goal, i.snapshot));
    };
    const cleanup = async (i) => {
      r.classifier = {
        candidates: i.candidates.map((c) => ({ id: c.id, reason: c.reason, signal: c.signal })),
        sawPrivate: JSON.stringify(i).includes('PRIVATE_CLEAN_FIELD'),
      };
      return reply({
        regions: i.candidates.map((c) => ({
          id: c.id,
          choice: c.signal === 'labelled_sponsored' ? 'offer_hide' : 'keep_visible',
        })),
      });
    };
    const service = new GeminiService(
      { GEMINI_API_KEY: 'local-fixture', GEMINI_MODEL: 'gemini-fixture-only' },
      token,
      async () => reply({}),
      9000,
      undefined,
      assist,
      undefined,
      chat,
      cleanup,
    );
    api = makeApi(undefined, service);
    api.listen(4317, '127.0.0.8');
    await once(api, 'listening');
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, starts[name], {
      apiHost: '127.0.0.8',
      prepare: async (page) => {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const u = new URL(req.url());
          if (/\.(exe|msi|dmg|zip|7z)$/.test(u.pathname)) {
            r.fileRequests++;
            void req.abort().catch(() => {});
          } else void req.continue().catch(() => {});
        });
      },
    });
    await grantFocused(s);
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    r.loaded = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    )?.path;
    assert.equal(resolve(r.loaded), bundle);
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    await btn(s.panel, 'Settings').click();
    await s.panel.locator('summary::-p-text(Connect local AI)').click();
    await s.panel.type('input[type=password]', token);
    await btn(s.panel, 'Connect').click();
    await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'));
    await btn(s.panel, 'Close Settings').click();
    if (name === 'resell' || name === 'resell-guide') {
      const g = 'Open a confirmed current Lamy 2000 extra-fine offer, then check this seller.';
      await submit(s, g);
      const accepted = await until(async () => {
        const t = (await state(s)).task;
        return t?.state === 'awaiting_confirmation' && t;
      }, 'Original navigation task accepted');
      assert.equal(accepted.goal, g);
      assert(!accepted.adaptive.authorized);
      const guide = name==='resell-guide';
      r.catalogMode=guide?'guide':'automatic';
      r.manualCatalogActions=[];
      if(guide) await btn(s.panel,'Show me').click();
      else {
        await btn(s.panel, 'Take me there').click();
        await btn(s.panel, 'Start automatic').click();
      }
      let acted;
      const handoff = await until(async () => {
        const t = (await state(s)).task;
        if (t?.state === 'paused' || t?.state === 'failed')
          throw Error(t.adaptive?.status ?? t.state);
        if(t?.state === 'showing_step' && t.adaptive?.status.includes('Click SafeStep there'))return t;
        if(guide && t?.state==='showing_step' && t.revision!==acted){
          const fact=await followCatalogCue(s,t);
          if(fact){acted=t.revision;r.manualCatalogActions.push(fact);}
        }
        return false;
      }, 'Observed storefront handoff');
      assert.equal(handoff.adaptive.authorized, false);
      assert(new URL(s.page.url()).hostname === 'resell.store');
      r.verifiedCatalogSteps = handoff.steps;
      const target = (
        await s.page.evaluateHandle(() => {
          const ring = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
          if (!ring) return null;
          return [...document.querySelectorAll('a[href]')].find((el) => {
            const b = el.getBoundingClientRect();
            return (
              b.width &&
              Math.abs(b.left - ring.left - 3) < 3 &&
              Math.abs(b.top - ring.top - 3) < 3 &&
              Math.abs(b.width - ring.width + 6) < 3
            );
          });
        })
      ).asElement();
      assert(target, 'Current tenant control has visible highlight');
      const info = await target.evaluate((e) => ({ label: e.innerText, url: e.href }));
      const tenant = new URL(info.url);
      assert(
        tenant.protocol === 'https:' &&
          tenant.hostname.endsWith('.resell.store') &&
          /lamy/i.test(info.label) &&
          /extra[ -]fine/i.test(info.label),
      );
      r.tenant = { label: info.label, url: tenant.href };
      await capture(s, r, 'handoff');
      await target.click();
      r.websiteActions.push('User clicked only the product-highlighted tenant listing.');
      await s.page.waitForFunction((u) => location.href === u && document.readyState==='complete' &&
        document.body.innerText.toLowerCase().includes('lamy 2000'), {}, tenant.href);
      const prior = await until(async()=>{const v=await state(s);return !v.task?.adaptive?.authorized && v;},'Tenant committed and prior automatic authority retired');
      assert.notEqual(prior.access, 'site');
      await s.activate(s.page);
      await until(async () => {
        const v = await state(s);
        return v.origin === tenant.origin && ['temporary', 'site'].includes(v.access);
      }, 'Explicit new tenant access');
      await submit(s, 'Check this seller.');
      const seller = await until(async () => {
        const data = (await state(s)).shopping?.seller?.data;
        return data?.records?.length && data;
      }, 'Source-attributed seller evidence');
      assert.equal(seller.context.seller, tenant.hostname.split('.')[0]);
      assert(
        seller.context.listing &&
          seller.context.variant &&
          /extra[ -]fine/i.test(seller.context.variant),
      );
      assert(
        seller.records.every(
          (x) => x.channel === 'seller_received_feedback' && x.subject === seller.context.seller,
        ),
      );
      r.seller = {
        account: seller.context.seller,
        listing: seller.context.listing,
        title: seller.context.title,
        variant: seller.context.variant,
        condition: seller.context.condition,
        source: seller.source,
        status: seller.status,
        sample: seller.records.length,
        captured: seller.captured,
      };
      r.r03='verified current listing/variant, exact store and source-attributed seller-service evidence';
      await capture(s, r, 'seller');
      await btn(s.panel, 'Compare alternatives for this item').click();
      await until(
        async () => !!(await state(s)).comparison?.baseline,
        'Current listing entered comparison editor',
      );
      const comparison = (await state(s)).comparison;
      assert.equal(comparison.baseline.url, tenant.href);
      await typeField(s, 'Comparison goal', 'Find similar pens, must have extra fine nib.');
      await (await field(s, 'Comparison mode')).select('similar_products');
      await typeField(s, 'Public search terms', 'fountain pen');
      for (const name of ['product', 'model', 'condition']) {
        const input = await field(s, name);
        if (!(await input.evaluate((x) => x.checked))) await input.click();
      }
      await btn(s.panel, 'Add requirement').click();
      await typeField(s, 'Required attribute 1', 'nib');
      await typeField(s, 'Required value 1', 'extra fine');
      const confirms = await s.panel.$$('.comparison-form input[type=checkbox]');
      for (const el of confirms)
        if (await el.evaluate((e) => e.required && !e.checked))
          await el.click();
      await btn(s.panel, 'Find options').click();
      const c = await until(
        async () => {
          const x = (await state(s)).comparison;
          return x && ['ready', 'partial', 'no_matches','only_baseline','needs_checking'].includes(x.status) && x;
        },
        'Bounded reviewed discovery',
        35000,
      );
      assert(c.settings.hard.some((q) => q.field === 'nib' && q.value === 'extra fine'));
      assert(c.baseline.url === tenant.href);
      assert(c.candidates.every((v) => !v.recommended || v.fit === 'confirmed'));
      r.comparison = {
        status: c.status,
        query: c.settings.query,
        hard: c.settings.hard,
        source: c.searchSource,
        offers: c.candidates.map((x) => ({
          id: x.offer.id,
          fit: x.fit,
          recommended: x.recommended,
          price: x.offer.cost.amount,
          shipping: x.offer.cost.shipping,
          seller: x.offer.seller,
        })),
      };
      r.r04='confirmed similar-product search retained the reviewed nib requirement';
      await capture(s, r, 'compare');
      await directTool(s, 'product_assessment');
      const product = await until(async () => {
        const data = (await state(s)).shopping?.product?.data;
        return data?.context.listing === seller.context.listing && data;
      }, 'Exact listing evidence');
      assert.equal(product.records.length, 0);
      assert.match(product.note, /independent product reviews/i);
      r.product = {
        id: product.context.listing,
        variant: product.context.variant,
        source: product.source,
        sample: 0,
        note: product.note,
      };
      await directTool(s, 'page_cleanup');
      const cleanupView=await until(async()=>{const v=await state(s);return v.cleanup?.binding.origin===tenant.origin&&v.cleanup;},'Actual storefront cleanup preview');
      assert(!cleanupView.enabled&&cleanupView.hidden===0);
      r.realListingCleanup={eligible:cleanupView.items.length,uncertain:cleanupView.uncertain,limited:cleanupView.limited,applied:0};
      await capture(s,r,'storefront-cleanup');
    } else if(name==='resell-hard') {
      const goal='Find similar pens. They must have an ultraviolet coating. Exclude broad nibs.';
      await submit(s,goal);
      const baseline=await until(async()=>{const c=(await state(s)).comparison;return c?.baseline&&c.baseline;},'Current selling offer');
      assert.equal(baseline.url,starts[name]);
      const initial=await s.panel.$$eval('.comparison-form input',els=>els.map(e=>e.value));
      assert(initial.includes('ultraviolet coating')&&initial.includes('broad'));
      await typeField(s,'Public search terms','fountain pen');
      for(const name of ['product','model','condition']){const el=await field(s,name);if(!await el.evaluate(e=>e.checked))await el.click();}
      for(const el of await s.panel.$$('.comparison-form input[type=checkbox][required]'))await el.click();
      await btn(s.panel,'Find options').click();
      const c=await until(async()=>{const cur=(await state(s)).comparison;return cur&&['ready','partial','no_matches','only_baseline','needs_checking'].includes(cur.status)&&cur;},'Confirmed bounded search with the signed hard constraints');
      assert.equal(c.settings.goal,goal);
      assert(c.settings.hard.some(h=>h.field==='feature'&&h.value==='ultraviolet coating'&&!h.exclude));
      assert(c.settings.hard.some(h=>h.field==='nib'&&h.value==='broad'&&h.exclude));
      assert(c.candidates.every(x=>!x.recommended || x.offer.attributes.feature==='ultraviolet coating'));
      r.comparison={goal:c.settings.goal,baseline:baseline.id,hard:c.settings.hard,source:c.searchSource,coverage:c.coverage,status:c.status,offers:c.candidates.length};
      await capture(s,r,'requirements');
    } else if (name === 'mozilla') {
      await submit(s, 'Check the product reviews and Firefox compatibility.');
      const p = await until(async () => {
        const d = (await state(s)).shopping?.product?.data;
        return d?.records.length && d;
      }, 'Mozilla product source');
      assert(p.context.catalog && p.context.variant);
      assert(
        p.records.every(
          (x) => x.subject === p.context.catalog && x.channel === 'catalog_product_review',
        ),
      );
      const card = await s.panel.waitForSelector('article[aria-label="Product assessment"]');
      const text = await card.evaluate((e) => e.innerText);
      assert(
        text.includes('Mozilla identifies this exact catalogue product') &&
          text.includes('name the selected version'),
      );
      r.product = {
        subject: p.context.catalog,
        version: p.context.variant,
        records: p.records.length,
        source: p.source,
        scope: p.scope,
        filter: p.filter,
      };
      await capture(s, r, 'product');
    } else {
      await s.page.evaluate(() => {
        const aside = document.createElement('aside');
        aside.id = 'disguised-consent';
        aside.setAttribute('aria-label', 'Sponsored');
        const control = document.createElement('button');
        control.textContent = 'Accept all cookies';
        aside.append(control);
        document.body.append(aside);
      });
      await submit(s, 'Preview cleanup on this page.');
      const preview = await until(async () => {
        const c = (await state(s)).cleanup;
        return c?.items.length >= 2 && c;
      }, 'Two eligible local cleanup candidates');
      assert(!preview.enabled);
      await btn(s.panel, 'Review these regions with Gemini').click();
      await s.panel.waitForSelector('::-p-aria(Apply suggested regions[role="button"])');
      assert(r.classifier && !r.classifier.sawPrivate);
      await capture(s, r, 'preview');
      await btn(s.panel, 'Apply suggested regions').click();
      const cleaned = await until(async () => {
        const c = (await state(s)).cleanup;
        return c?.enabled && c.hidden === 1 && c;
      }, 'Applied only reviewed ad ID');
      const bits = await s.page.evaluate(() => ({
        adHidden: !document.querySelector('#ad').checkVisibility(),
        keptPromo: document.querySelector('#practice-offer').checkVisibility(),
        consent: document.querySelector('[data-consent]').checkVisibility(),
        warning: document.querySelector('[data-security]').checkVisibility(),
        evidence: document.querySelector('[data-shopping-evidence] aside').checkVisibility(),
        manualDialog: document.querySelector('#unknown').checkVisibility(),
        disguisedConsent: document.querySelector('#disguised-consent button').checkVisibility(),
        privateField: document.querySelector('#private').value === 'PRIVATE_CLEAN_FIELD',
      }));
      assert(Object.values(bits).every(Boolean));
      r.applied = { ...bits, held: cleaned.hidden };
      await s.page.click('#more');
      await delay(700);
      assert(
        (await state(s)).cleanup.hidden === 1,
        'new unseen region cannot enter selected subset',
      );
      await btn(s.panel, 'Restore page').click();
      await until(() => s.page.$eval('#ad', (e) => e.checkVisibility()), 'Exact restore');
      r.restored = true;
      await capture(s, r, 'restored');
      await submit(s,'Clean up this page: hide ads but keep promotions.');
      await until(async()=>{const v=await state(s);return v.cleanup?.binding.operationId!==preview.binding.operationId && v.cleanup?.items.length>0;},'fresh user-scoped cleanup preview');
      await s.panel.waitForFunction(()=>document.body.innerText.includes('keep visible for this request'));
      await btn(s.panel,'Review these regions with Gemini').click();
      await s.panel.waitForSelector('::-p-aria(Apply suggested regions[role="button"])');
      assert(r.classifier.candidates.every(c=>c.reason==='advertisement'),'Kept promotions must never be sent to the classifier for hiding');
      await btn(s.panel,'Use local preview').click();await btn(s.panel,'Apply cleanup').click();
      await until(()=>s.page.$eval('#ad',e=>!e.checkVisibility()),'local apply hides requested category');
      assert(await s.page.$eval('#practice-offer',e=>e.checkVisibility()),'explicit promotion exclusion survives local Apply');
      await btn(s.panel,'Restore page').click();await until(()=>s.page.$eval('#ad',e=>e.checkVisibility()),'user-scoped restore');
      r.keptExplicitPromotions=true;await capture(s,r,'kept-promotions');
    }
    assert.equal(r.fileRequests, 0);
    assert.equal(r.downloads, 0);
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message)
      .replace(/ss3_[\w-]+/g, '[redacted]')
      .slice(0, 250);
    if (s) {
      const v = await state(s).catch(() => null);
      r.last = {
        turn: v?.chat?.turns?.at(-1)?.state,
        task: v?.task?.state,
        reason: v?.task?.adaptive?.status,
        message: v?.chat?.turns?.at(-1)?.message,
        comparison: v?.comparison?.status,
        site: new URL(s.page.url()).hostname,
      };
      await capture(s, r, 'diagnostic').catch(() => {});
    }
  } finally {
    if (s) await s.browser.close();
    if (api) {
      api.closeAllConnections();
      await new Promise((ok) => api.close(ok));
    }
    r.ended = new Date().toISOString();
    rows.push(r);
    await writeFile(
      join(out, 'results.json'),
      JSON.stringify({ role: 'builder', build, sha256, bundle, rows }, null, 2) + '\n',
    );
    console.log(name, width, r.status, r.error ?? '');
  }
}
try {
  const names = (process.argv[2] ?? 'resell,mozilla,cleanup').split(',');
  assert(names.every((x) => ['resell', 'resell-guide', 'resell-hard', 'mozilla', 'cleanup'].includes(x)));
  for (const width of [1440, 1366]) for (const name of names) await run(name, width);
} finally {
  fixture.server.closeAllConnections();
  await new Promise((ok) => fixture.server.close(ok));
}
if (rows.some((r) => r.status !== 'pass')) process.exitCode = 1;
