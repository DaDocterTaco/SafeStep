// Installed product verification. Public shopping evidence is real; planner and classifier are local fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { observeShoppingGuards } from './support/shopping-diagnostics.mjs';

const build = process.env.SAFESTEP_NAV_BUILD;
assert.match(build, /^stage-8-[0-9a-f]{12}$/);
const bundle = resolve('artifacts', build, 'chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
assert.equal(build, 'stage-8-' + sha256.slice(0, 12));
const pointer = JSON.parse(
  await readFile(resolve('docs/evidence', build, 'current-reference.json'), 'utf8'),
);
const reference = JSON.parse(await readFile(pointer.path, 'utf8'));
assert.equal(reference.extensionSHA256, sha256);
const runtimeRoot = resolve(process.env.SAFESTEP_SHOP_BUILD_RUNTIME ?? '.');
assert(runtimeRoot === resolve('.') || runtimeRoot.startsWith(resolve('.test-artifacts') + sep));
for (const group of [reference.api, reference.compiledContracts])
  for (const [file, digest] of Object.entries(group.files))
    assert.equal(
      createHash('sha256')
        .update(await readFile(resolve(runtimeRoot, file)))
        .digest('hex'),
      digest,
      'Release inputs changed: ' + file,
    );
if (runtimeRoot !== resolve('.'))
  for (const [file, digest] of Object.entries(reference.compiledContracts.files)) {
    const importTarget = file.replace(
      /^packages\/contracts\//,
      'node_modules/@safestep/contracts/',
    );
    assert.equal(
      createHash('sha256')
        .update(await readFile(resolve(runtimeRoot, importTarget)))
        .digest('hex'),
      digest,
      'Isolated API imports a different contract: ' + file,
    );
  }
const moduleAt = (path) => import(pathToFileURL(resolve(runtimeRoot, path)).href);
const { makeApi } = await moduleAt('apps/api/dist/app.js');
const { GeminiService, newPairToken } = await moduleAt('apps/api/dist/gemini.js');
const { localPilotStep, automaticThreatSubject } = await moduleAt(
  'packages/contracts/dist/index.js',
);
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
  await s.panel.click('#chat-composer');
  await s.panel.keyboard.type(text);
  await s.panel.keyboard.press('Enter');
}
async function contextNow(s) {
  const v = await state(s);
  const browser = await s.panel.evaluate(async () => {
    const w = await chrome.windows.getCurrent();
    const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
    const [doc] = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: () => location.origin + location.pathname,
    });
    return { focused: w.focused, active: t.active, url: doc.result, document: doc.documentId };
  });
  return {
    ...browser,
    epoch: v.epoch,
    access: v.access,
    taskId: v.task?.id,
    taskState: v.task?.state,
    reason: v.task?.adaptive?.status,
  };
}
async function watchNativeOwnership(s) {
  await s.panel.evaluate(async () => {
    const win = await chrome.windows.getCurrent(),
      [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    const events = (globalThis.__safeStepTestLifecycle = []);
    const note = (kind, data) => {
      events.push({ at: new Date().toISOString(), kind, ...data });
      if (events.length > 120) events.shift();
    };
    let focused;
    setInterval(async () => {
      const actual = await chrome.windows.get(win.id).catch(() => null);
      if (actual?.focused !== focused) {
        focused = actual?.focused;
        note('focus sample', { focused });
      }
    }, 300);
    chrome.windows.onFocusChanged.addListener(async (id) => {
      const current = await chrome.windows.get(win.id).catch(() => null);
      note('focus', {
        to: id === win.id ? 'this' : id === chrome.windows.WINDOW_ID_NONE ? 'none' : 'other',
        ownFocusAtRead: current?.focused,
      });
    });
    chrome.tabs.onActivated.addListener((a) => {
      if (a.windowId === win.id) note('active tab', { own: a.tabId === tab.id });
    });
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (id === tab.id && (change.url || change.status))
        note('tab update', { status: change.status, changedURL: !!change.url });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      const cp = changes['task:' + tab.id]?.newValue;
      if (area === 'session' && cp) {
        const active = cp.chat?.turns?.find((t) => t.id === cp.chat?.activeTurnId);
        note('checkpoint', {
          epoch: cp.epoch,
          taskState: cp.task?.state,
          active: active?.feature,
          turnState: active?.state,
          turnId: active?.id,
        });
      }
    });
  });
}
async function scopedSubmit(s, r, text, ready) {
  r.submissionContexts ??= [];
  const evidence = { text, before: await contextNow(s) };
  r.submissionContexts.push(evidence);
  await submit(s, text);
  let retried = false;
  return until(async () => {
    const v = await state(s);
    const result = ready(v);
    if (result) return result;
    const turn = v.chat?.turns.find((t) => t.id === v.chat?.activeTurnId);
    if(turn?.original===text && turn.state==='unavailable') {
      const source=v.shopping?.seller?.data;
      evidence.unavailable={message:turn.text,status:source?.status,note:source?.note};
      throw Error('Unavailable current-page result: '+(source?.status??turn.text));
    }
    if (turn?.state === 'stale' && turn.original === text) {
      if (retried && turn.id === evidence.staleTurn) return false;
      if (retried) throw Error('A second deliberate current-page request was rejected as stale');
      evidence.rejected = await contextNow(s);
      evidence.staleTurn = turn.id;
      evidence.originalRetained = v.chat.turns.some((t) => t.role === 'user' && t.text === text);
      assert(evidence.originalRetained);
      assert.equal(evidence.before.url, evidence.rejected.url);
      assert.equal(evidence.before.document, evidence.rejected.document);
      await capture(s, r, 'first-request-stale');
      const editor = await s.panel.$$('button');
      const edit = await Promise.all(
        editor.map(async (e) => ({ e, label: await e.evaluate((x) => x.innerText) })),
      );
      const button = edit.filter((x) => x.label === 'Edit request').at(-1);
      assert(button);
      await button.e.click();
      assert.equal(await s.panel.$eval('#chat-composer', (e) => e.value), text);
      await grantFocused(s);
      await btn(s.panel, 'Send').click();
      retried = true;
    }
    return false;
  }, 'Bound current-page request: ' + text);
}
async function directTool(s, feature) {
  await btn(s.panel, 'Help').click();
  const tool = await s.panel.waitForSelector('.help-tools button[data-feature="' + feature + '"]');
  await tool.click();
}
async function enableThreatFixture(s, source) {
  const eligible = automaticThreatSubject(source);
  assert(eligible);
  await btn(s.panel, 'Settings').click();
  await s.panel.select('[aria-label="Auto protection settings"] select', 'all');
  await s.panel
    .locator('::-p-aria(Allow automatic public URL checks with Google Web Risk[role="checkbox"])')
    .click();
  await btn(s.panel, 'Apply protection settings').click();
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('tests/support/permission.ps1'),
      '-BrowserProcessId',
      String(s.browser.process().pid),
      '-Choice',
      'Allow',
    ],
    { windowsHide: true, timeout: 16000 },
  ).catch(() => {});
  await until(async () => {
    const v = await state(s);
    return (
      v.prefs.protection?.automaticUrlConsent === 2 &&
      v.protection?.threat?.url === eligible.url &&
      v.protection.threat.status === 'no_match'
    );
  }, 'Consented current URL check with its actual coverage');
  await btn(s.panel, 'Close Settings').click();
}
async function catalogCue(s, selector) {
  return (
    await s.page.evaluateHandle((selector) => {
      const outline = document.querySelector('[data-safestep-outline]'),
        ring = outline?.getBoundingClientRect();
      if (
        !ring ||
        ring.width <= 6 ||
        ring.height <= 6 ||
        getComputedStyle(outline).visibility === 'hidden'
      )
        return null;
      const mid = document.elementFromPoint(
        (ring.left + ring.right) / 2,
        (ring.top + ring.bottom) / 2,
      );
      return (
        [...document.querySelectorAll(selector)].find(
          (el) =>
            (el.contains(mid) || mid?.closest('label')?.control === el) &&
            [...el.getClientRects(), el.getBoundingClientRect()].some(
              (b) =>
                b.width > 0 &&
                b.left <= ring.left + 4 &&
                b.top <= ring.top + 4 &&
                b.right >= ring.right - 4 &&
                b.bottom >= ring.bottom - 4,
            ),
        ) ?? null
      );
    }, selector)
  ).asElement();
}
async function followCatalogCue(s, task, r) {
  const el = await catalogCue(s, 'input[type=search],a[href]');
  if (!el) {
    const reveal = await s.panel.evaluateHandle(
      () =>
        document.querySelector('button[data-show-step]') ??
        [...document.querySelectorAll('button')].find((b) =>
          ['Show step', 'Show this target'].includes(b.innerText.trim()),
        ) ??
        null,
    );
    if (task.mode === 'guide' && r.revealedRevision !== task.revision && reveal.asElement()) {
      r.revealedRevision = task.revision;
      await reveal.asElement().click();
    }
    await reveal.dispose();
    return null;
  }
  const fact = await el.evaluate((e) => ({
    tag: e.localName,
    href: e.href || null,
    label: e.getAttribute('aria-label') || e.innerText || null,
  }));
  if (fact.tag === 'input') {
    assert(task.adaptive.searchQuery);
    await el.click();
    await s.page.keyboard.down('Control');
    await s.page.keyboard.press('a');
    await s.page.keyboard.up('Control');
    await el.type(task.adaptive.searchQuery);
    await el.press('Enter');
  } else {
    const u = new URL(fact.href);
    assert.equal(u.origin, 'https://resell.store');
    assert.equal(u.pathname, '/discover');
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
    'resell-retry': 'https://nibdrawer.resell.store/lamy-2000-makrolon',
    'variant-stale': fixture.origin + '/comparison-lab/original',
    'resell-risk': 'https://nibdrawer.resell.store/lamy-2000-makrolon',
    'offer-risk': 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
    cleanup: fixture.origin + '/cleanup-lab',
  };
  let s, api, stopDiagnostics;
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
        slots:
          feature === 'shopping_alternatives'
            ? { subjectRef: null, mode: 'similar_products' }
            : feature === 'page_cleanup'
              ? {}
              : { subjectRef: null },
      });
    };
    const assist = async (i) => {
      r.calls.push({
        kind: i.kind,
        path: i.snapshot?.path ?? null,
        limited: i.snapshot?.limited,
        controls: i.snapshot?.controls.map((c) => ({
          role: c.role,
          action: c.action,
          label: c.label,
          path: c.path,
          targetOrigin: c.targetOrigin ?? null,
        })),
      });
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
    const risk =
      name === 'resell-risk' || name === 'offer-risk'
        ? {
            readiness: () => ({
              provider: 'url_threat',
              status: 'ready',
              credentialPresent: false,
            }),
            check: async (q) => {
              (r.threatFixtureRequests ??= []).push({
                purpose: q.purpose,
                url: q.url,
                scope: q.scope,
              });
              const match = q.purpose === 'target';
              return {
                ...q,
                reason: null,
                status: match ? 'match' : 'no_match',
                source: 'Google Web Risk Lookup',
                checkedAt: new Date().toISOString(),
                expiresAt: match ? new Date(Date.now() + 240000).toISOString() : null,
                categories: match ? ['UNWANTED_SOFTWARE'] : [],
              };
            },
          }
        : undefined;
    api = makeApi(undefined, service, undefined, risk);
    api.listen(4317, '127.0.0.8');
    await once(api, 'listening');
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, starts[name], {
      requireUsablePanel: true,
      attachWorker: process.env.SAFESTEP_DIAGNOSE_BINDING === '1',
      apiHost: '127.0.0.8',
      prepare: async (page) => {
        await page.setRequestInterception(true);
        r.pageSourceResponses = [];
        const source = (raw) => {
          const u = new URL(raw);
          return (u.hostname === 'api.resell.store' && u.pathname.startsWith('/v1/')) ||
            (u.hostname === 'addons.mozilla.org' && u.pathname.startsWith('/api/'))
            ? u.origin + u.pathname
            : null;
        };
        page.on('response', (response) => {
          const endpoint = source(response.url());
          if (endpoint)
            r.pageSourceResponses.push({
              at: new Date().toISOString(),
              endpoint,
              http: response.status(),
            });
        });
        page.on('requestfailed', (request) => {
          const endpoint = source(request.url());
          if (endpoint)
            r.pageSourceResponses.push({
              at: new Date().toISOString(),
              endpoint,
              error: request.failure()?.errorText ?? 'transport_error',
            });
        });
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
    await watchNativeOwnership(s);
    r.initialPageReady = await s.page.evaluate(() => document.readyState);
    await s.page.waitForFunction(
      () => document.readyState === 'complete' && !!document.body?.innerText.trim(),
      { timeout: 20000 },
    );
    if (process.env.SAFESTEP_DIAGNOSE_BINDING === '1')
      stopDiagnostics = await observeShoppingGuards(s, bundle, r);
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
      const guide = name === 'resell-guide';
      r.catalogMode = guide ? 'guide' : 'automatic';
      r.manualCatalogActions = [];
      if (guide) await btn(s.panel, 'Show me').click();
      else {
        await btn(s.panel, 'Take me there').click();
        await btn(s.panel, 'Start automatic').click();
      }
      let acted;
      const handoff = await until(async () => {
        const t = (await state(s)).task;
        if (t?.state === 'paused' || t?.state === 'failed')
          throw Error(t.adaptive?.status ?? t.state);
        if (t?.state === 'showing_step' && t.adaptive?.status.includes('Click SafeStep there'))
          return t;
        if (guide && t?.state === 'showing_step' && t.revision !== acted) {
          const fact = await followCatalogCue(s, t, r);
          if (fact) {
            acted = t.revision;
            r.manualCatalogActions.push(fact);
          }
        }
        return false;
      }, 'Observed storefront handoff');
      assert.equal(handoff.adaptive.authorized, false);
      assert(new URL(s.page.url()).hostname === 'resell.store');
      r.verifiedCatalogSteps = handoff.steps;
      const target = await catalogCue(s, 'a[href]');
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
      await s.page.waitForFunction(
        (u) =>
          location.href === u &&
          document.readyState === 'complete' &&
          document.body.innerText.toLowerCase().includes('lamy 2000'),
        {},
        tenant.href,
      );
      const prior = await until(async () => {
        const v = await state(s);
        return !v.task?.adaptive?.authorized && v;
      }, 'Tenant committed and prior automatic authority retired');
      assert.notEqual(prior.access, 'site');
      await s.activate(s.page);
      await until(async () => {
        const v = await state(s);
        return v.origin === tenant.origin && ['temporary', 'site'].includes(v.access);
      }, 'Explicit new tenant access');
      const seller = await scopedSubmit(s, r, 'Check this seller.', (v) => {
        const data = v.shopping?.seller?.data;
        return data?.records?.length && data;
      });
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
      r.r03 =
        'verified current listing/variant, exact store and source-attributed seller-service evidence';
      await capture(s, r, 'seller');
      r.beforeCompare = await contextNow(s);
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
        if (await el.evaluate((e) => e.required && !e.checked)) await el.click();
      const reviewed = await s.panel.$$eval(
        '.comparison-form input,.comparison-form select',
        (els) => els.map((e) => [e.value, e.checked]),
      );
      const beforeFind = await state(s);
      await btn(s.panel, 'Find options').click();
      const c = await until(
        async () => {
          const current = await state(s),
            x = current.comparison;
          const rejection = await s.panel.evaluate(
            () =>
              [...document.querySelectorAll('[role=alert]')].find((e) =>
                e.textContent.includes('page or task changed'),
              )?.textContent,
          );
          if (x?.status === 'idle' && rejection) {
            if (r.firstFindRejection)
              throw Error('Reviewed Find remained stale after deliberate foreground retry');
            const snapshot = await s.panel.evaluate(async () => {
              const w = await chrome.windows.getCurrent();
              const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
              const probe = await chrome.scripting.executeScript({
                target: { tabId: t.id },
                func: () => ({
                  watchCurrent: globalThis.__safeStepComparison?.check?.() === true,
                  location: location.origin + location.pathname,
                }),
              });
              return {
                focused: w.focused,
                tab: t.active,
                document: probe[0]?.documentId,
                observed: probe[0]?.result,
              };
            });
            r.firstFindRejection = {
              rejection,
              snapshot,
              epochBefore: beforeFind.epoch,
              epochAfter: current.epoch,
              unchangedTask: beforeFind.task?.id === current.task?.id,
              unchangedVersion: x.version === beforeFind.comparison.version,
            };
            assert.equal(s.page.url(), tenant.href);
            assert.equal(x.id, beforeFind.comparison.id);
            assert.equal(x.version, beforeFind.comparison.version);
            assert.deepEqual(
              await s.panel.$$eval('.comparison-form input,.comparison-form select', (els) =>
                els.map((e) => [e.value, e.checked]),
              ),
              reviewed,
              'A rejected Find must retain every reviewed requirement',
            );
            await capture(s, r, 'first-find-rejected');
            await grantFocused(s);
            await btn(s.panel, 'Find options').click();
            return false;
          }
          return (
            x &&
            ['ready', 'partial', 'no_matches', 'only_baseline', 'needs_checking'].includes(
              x.status,
            ) &&
            x
          );
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
      r.r04 = 'confirmed similar-product search retained the reviewed nib requirement';
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
      const cleanupView = await until(async () => {
        const v = await state(s);
        return v.cleanup?.binding.origin === tenant.origin && v.cleanup;
      }, 'Actual storefront cleanup preview');
      assert(!cleanupView.enabled && cleanupView.hidden === 0);
      r.realListingCleanup = {
        eligible: cleanupView.items.length,
        uncertain: cleanupView.uncertain,
        limited: cleanupView.limited,
        applied: 0,
      };
      await capture(s, r, 'storefront-cleanup');
    } else if (name === 'offer-risk') {
      r.provider =
        'Controlled exact no-match arrival and selected offer match; not a genuine URL threat finding.';
      await enableThreatFixture(s, starts[name]);
      await directTool(s, 'shopping_alternatives');
      const baseline = await until(async () => {
        const c = (await state(s)).comparison;
        return c?.baseline && c.baseline;
      }, 'Mozilla baseline for selected option');
      await typeField(s, 'Comparison goal', 'Compare similar Firefox ad blockers.');
      await (await field(s, 'Comparison mode')).select('similar_products');
      await typeField(s, 'Public search terms', 'ad blocker');
      for (const key of ['product', 'model', 'version']) {
        const el = await field(s, key);
        if (!(await el.evaluate((e) => e.checked))) await el.click();
      }
      for (const el of await s.panel.$$('.comparison-form input[type=checkbox][required]'))
        await el.click();
      await btn(s.panel, 'Find options').click();
      const c = await until(
        async () => {
          const c = (await state(s)).comparison;
          return (
            c?.candidates?.length &&
            !['searching', 'checking_candidates', 'comparing'].includes(c.status) &&
            c
          );
        },
        'Actual Mozilla candidate from reviewed search',
        35000,
      );
      assert(
        !r.threatFixtureRequests.some((q) => q.purpose === 'target'),
        'Candidates must not be scanned before selection',
      );
      const target = c.candidates[0].offer,
        before = (await s.browser.pages()).length,
        eligible = automaticThreatSubject(target.url, 'target');
      assert.equal(new URL(target.url).origin, 'https://addons.mozilla.org');
      assert(eligible);
      const card = await s.panel.$('article[data-offer-id="' + target.id + '"] button:not([type])');
      assert(card && (await card.evaluate((e) => e.innerText)) === 'Open offer');
      await card.click();
      const result = await until(async () => {
        const p = (await state(s)).protection?.destination;
        return p?.kind === 'offer' && p.result?.url === eligible.url && p;
      }, 'Selected offer protection result');
      assert(
        result.result.status === 'match' ||
          (eligible.scope === 'root' &&
            result.result.status === 'no_match' &&
            result.limitedTicket),
      );
      assert.equal(result.result.scope, eligible.scope);
      assert.equal(s.page.url(), starts[name]);
      assert.equal((await s.browser.pages()).length, before);
      assert(
        r.threatFixtureRequests
          .filter((q) => q.purpose === 'target')
          .every((q) => q.url === eligible.url),
      );
      r.offerProof = {
        baseline: baseline.id,
        candidate: target.id,
        url: target.url,
        candidates: c.candidates.length,
        source: c.searchSource,
        checkedScope: eligible.scope,
        checkedUrl: result.result.url,
        fixtureStatus: result.result.status,
        newTabs: 0,
      };
      await capture(s, r, 'blocked-offer');
    } else if (name === 'resell-risk') {
      r.provider = 'Controlled exact no-match arrival, positive target; not Google upstream.';
      await enableThreatFixture(s, starts[name]);
      await directTool(s, 'product_assessment');
      const product = await until(async () => {
        const d = (await state(s)).shopping?.product?.data;
        return d?.status === 'limited_evidence' && d;
      }, 'Physical product check');
      assert.equal(product.inspectedUrl, starts[name]);
      assert.equal(product.records.length, 0);
      await s.panel.waitForFunction(
        (url) =>
          [...document.querySelectorAll('[data-security]')].some(
            (e) =>
              e.textContent.includes('Website URL check') &&
              e.textContent.includes(url) &&
              e.textContent.includes('does not establish merchant reliability'),
          ),
        {},
        starts[name],
      );
      await directTool(s, 'seller_assessment');
      const seller = await until(async () => {
        const d = (await state(s)).shopping?.seller?.data;
        return d?.records.length && d;
      }, 'Current exact seller evidence');
      assert.equal(seller.inspectedUrl, starts[name]);
      assert.equal(seller.context.seller, 'nibdrawer');
      assert(
        seller.records.every(
          (x) => x.channel === 'seller_received_feedback' && x.subject === seller.context.seller,
        ),
      );
      assert(
        !r.threatFixtureRequests.some((q) => q.purpose === 'target'),
        'Evidence display must not scan candidate sources',
      );
      await capture(s, r, 'separate-evidence');
      const before = (await s.browser.pages()).length;
      await s.panel.locator('article[aria-label="Seller assessment"] a[data-source-url]').click();
      const target = await until(async () => {
        const p = (await state(s)).protection?.destination;
        return p?.result?.status === 'match' && p;
      }, 'Selected source stopped by controlled threat receipt');
      assert.equal(target.result.url, seller.source);
      assert.equal(target.result.purpose, 'target');
      assert.equal((await s.browser.pages()).length, before);
      assert.equal(s.page.url(), starts[name]);
      await directTool(s, 'page_cleanup');
      const cv = await until(async () => {
        const c = (await state(s)).cleanup;
        return c?.binding.origin === new URL(starts[name]).origin && c;
      }, 'Source warning remains separate from cleanup preview');
      const warning = await s.panel.evaluate(() =>
        [...document.querySelectorAll('[data-security]')].some((e) =>
          e.textContent.includes('possible unwanted software'),
        ),
      );
      assert(warning, 'Source warning remains visible outside cleanup');
      r.separateEvidence = {
        productRecords: product.records.length,
        sellerRecords: seller.records.length,
        source: seller.source,
        attemptedTarget: target.result.url,
        newTabs: 0,
        hiddenByCleanup: cv.hidden,
        warning,
      };
      await capture(s, r, 'blocked-source');
    } else if (name === 'variant-stale') {
      await directTool(s, 'shopping_alternatives');
      const owner = await until(async () => {
        const v = await state(s);
        return v.comparison?.baseline && v;
      }, 'Bound practice listing');
      await typeField(s, 'Public search terms', 'fountain pen');
      await s.page.click('#change-variant');
      const after = await until(async () => {
        const v = await state(s);
        return v.chat?.turns.some((t) => t.id === owner.chat.activeTurnId && t.historical) && v;
      }, 'Replaced listing retired the bound conversation');
      assert(!after.chat.activeTurnId);
      assert(!(await s.panel.$('section[aria-label="Compare alternatives"] form')));
      assert(!after.comparison || ['stale', 'cancelled'].includes(after.comparison.status));
      r.changedItem = {
        fixture: true,
        oldTurnHistorical: true,
        oldFindGone: true,
        searchStarted: false,
      };
      await capture(s, r, 'variant-stale');
    } else if (name === 'resell-hard' || name === 'resell-retry') {
      const goal = 'Find similar pens. They must have an ultraviolet coating. Exclude broad nibs.';
      await submit(s, goal);
      const baseline = await until(async () => {
        const c = (await state(s)).comparison;
        return c?.baseline && c.baseline;
      }, 'Current selling offer');
      assert.equal(baseline.url, starts[name]);
      const initial = await s.panel.$$eval('.comparison-form input', (els) =>
        els.map((e) => e.value),
      );
      assert(initial.includes('ultraviolet coating') && initial.includes('broad'));
      await typeField(s, 'Public search terms', 'fountain pen');
      for (const name of ['product', 'model', 'condition']) {
        const el = await field(s, name);
        if (!(await el.evaluate((e) => e.checked))) await el.click();
      }
      for (const el of await s.panel.$$('.comparison-form input[type=checkbox][required]'))
        await el.click();
      if (name === 'resell-retry') {
        const before = (await state(s)).comparison;
        const inputs = await s.panel.$$eval(
          '.comparison-form input, .comparison-form select',
          (els) => els.map((e) => [e.value, e.checked]),
        );
        // Deliver a real edit before this first user-requested Find message. The original
        // Find remains unmodified and the installed worker must reject its stale version.
        await s.panel.evaluate((savedSettings) => {
          const original = chrome.runtime.sendMessage;
          chrome.runtime.sendMessage = async function (...args) {
            const message = args[0];
            if (
              message?.channel === 'panel' &&
              message.command?.kind === 'compare' &&
              message.command.action?.op === 'find'
            ) {
              chrome.runtime.sendMessage = original;
              const op = message.command.action;
              const edit = await original.call(chrome.runtime, {
                ...message,
                requestId: crypto.randomUUID(),
                command: {
                  kind: 'compare',
                  action: {
                    op: 'edit',
                    session: op.session,
                    version: op.version,
                    settings: savedSettings,
                  },
                },
              });
              if (!edit?.ok) throw Error('Controlled intervening edit was not accepted');
            }
            return original.apply(chrome.runtime, args);
          };
        }, before.settings);
        await btn(s.panel, 'Find options').click();
        await s.panel.waitForFunction(() =>
          [...document.querySelectorAll('[role=alert]')].some((e) =>
            e.textContent.includes('page or task changed'),
          ),
        );
        const rejected = (await state(s)).comparison;
        assert.equal(rejected.id, before.id);
        assert.equal(rejected.version, before.version + 1);
        assert.equal(rejected.status, 'idle');
        assert.deepEqual(
          await s.panel.$$eval('.comparison-form input,.comparison-form select', (els) =>
            els.map((e) => [e.value, e.checked]),
          ),
          inputs,
        );
        r.interrupted = {
          reason:
            'A controlled intervening edit changed the comparison version before the unmodified Find was delivered',
          currentSession: true,
          queryPreserved: true,
          requirementsPreserved: true,
          searchStarted: false,
        };
        await capture(s, r, 'rejected-preserved');
      }
      await btn(s.panel, 'Find options').click();
      const c = await until(async () => {
        const cur = (await state(s)).comparison;
        return (
          cur &&
          ['ready', 'partial', 'no_matches', 'only_baseline', 'needs_checking'].includes(
            cur.status,
          ) &&
          cur
        );
      }, 'Confirmed bounded search with the signed hard constraints');
      assert.equal(c.settings.goal, goal);
      assert(
        c.settings.hard.some(
          (h) => h.field === 'feature' && h.value === 'ultraviolet coating' && !h.exclude,
        ),
      );
      assert(c.settings.hard.some((h) => h.field === 'nib' && h.value === 'broad' && h.exclude));
      assert(
        c.candidates.every(
          (x) => !x.recommended || x.offer.attributes.feature === 'ultraviolet coating',
        ),
      );
      r.comparison = {
        goal: c.settings.goal,
        baseline: baseline.id,
        hard: c.settings.hard,
        source: c.searchSource,
        coverage: c.coverage,
        status: c.status,
        offers: c.candidates.length,
      };
      await capture(s, r, 'requirements');
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
      const preview = await scopedSubmit(s, r, 'Preview cleanup on this page.', (v) => {
        const c = v.cleanup;
        return c?.items.length >= 2 && c;
      });
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
      await submit(s, 'Clean up this page: hide ads but keep promotions.');
      await until(async () => {
        const v = await state(s);
        return (
          v.cleanup?.binding.operationId !== preview.binding.operationId &&
          v.cleanup?.items.length > 0
        );
      }, 'fresh user-scoped cleanup preview');
      await s.panel.waitForFunction(() =>
        document.body.innerText.includes('keep visible for this request'),
      );
      await btn(s.panel, 'Review these regions with Gemini').click();
      await s.panel.waitForSelector('::-p-aria(Apply suggested regions[role="button"])');
      assert(
        r.classifier.candidates.every((c) => c.reason === 'advertisement'),
        'Kept promotions must never be sent to the classifier for hiding',
      );
      await btn(s.panel, 'Use local preview').click();
      await btn(s.panel, 'Apply cleanup').click();
      await until(
        () => s.page.$eval('#ad', (e) => !e.checkVisibility()),
        'local apply hides requested category',
      );
      assert(
        await s.page.$eval('#practice-offer', (e) => e.checkVisibility()),
        'explicit promotion exclusion survives local Apply',
      );
      await btn(s.panel, 'Restore page').click();
      await until(() => s.page.$eval('#ad', (e) => e.checkVisibility()), 'user-scoped restore');
      r.keptExplicitPromotions = true;
      await capture(s, r, 'kept-promotions');
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
        turnMessage:v?.chat?.turns?.at(-1)?.text,
        task: v?.task?.state,
        reason: v?.task?.adaptive?.status,
        message: v?.chat?.turns?.at(-1)?.message,
        comparison: v?.comparison?.status,
        comparisonMessage: v?.comparison?.message,
        site: new URL(s.page.url()).hostname,
      };
      await capture(s, r, 'diagnostic').catch(() => {});
    }
  } finally {
    if (s) {
      r.lifecycle = await s.panel
        .evaluate(() => globalThis.__safeStepTestLifecycle ?? [])
        .catch(() => []);
      if (stopDiagnostics) await stopDiagnostics();
      await s.browser.close();
    }
    if (api) {
      api.closeAllConnections();
      await new Promise((ok) => api.close(ok));
    }
    r.ended = new Date().toISOString();
    rows.push(r);
    await writeFile(
      join(out, 'results.json'),
      JSON.stringify(
        {
          role: 'builder',
          build,
          sha256,
          bundle,
          source: reference.source.sha256,
          api: reference.api.sha256,
          contracts: reference.compiledContracts.sha256,
          rows,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(name, width, r.status, r.error ?? '');
  }
}
try {
  const names = (process.argv[2] ?? 'resell,mozilla,cleanup').split(',');
  assert(
    names.every((x) =>
      [
        'resell',
        'resell-guide',
        'resell-hard',
        'resell-retry',
        'variant-stale',
        'resell-risk',
        'offer-risk',
        'mozilla',
        'cleanup',
      ].includes(x),
    ),
  );
  const widths = process.env.SAFESTEP_SHOP_WIDTH
    ? [Number(process.env.SAFESTEP_SHOP_WIDTH)]
    : [1440, 1366];
  assert(widths.every((width) => width === 1440 || width === 1366));
  for (const width of widths) for (const name of names) await run(name, width);
} finally {
  fixture.server.closeAllConnections();
  await new Promise((ok) => fixture.server.close(ok));
}
if (rows.some((r) => r.status !== 'pass')) process.exitCode = 1;
