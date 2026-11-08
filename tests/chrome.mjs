import assert from 'node:assert/strict';
import { openAdvanced, openArea, openDetails } from './support/stage7-panel.mjs';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';
import { startFixture } from './fixtures/serve.mjs';
import { runCases, view } from './support/chrome-cases.mjs';
import { makeApi, apiPort } from '../apps/api/dist/app.js';
import { ProvidersService } from '../apps/api/dist/providers.js';
import { fingerprint } from '../scripts/stage1.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json')));
const { sha256, names } = await fingerprint(bundle);
for (const name of names.filter((n) => n.endsWith('.js'))) {
  assert(
    !/GEMINI_API_KEY|WEB_RISK_API_KEY|TRUSTPILOT_API_KEY|MARKETPLACE_SELLER_TOKEN|PRODUCT_REVIEWS_TOKEN|MARKETPLACE_BROWSE_TOKEN|TEST_SECRET_FOR_BOUNDARY_ONLY/.test(
      await readFile(resolve(bundle, name), 'utf8'),
    ),
  );
}
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
assert.equal(manifest.content_scripts, undefined);
const fixture = await startFixture(0);
const apiHost = process.env.SAFESTEP_TEST_API_HOST ?? '127.0.0.1';
assert(/^127\.0\.0\.[1-9]$/.test(apiHost), 'test API must use loopback');
const executablePath =
  process.env.CHROME_PATH ??
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/usr/bin/google-chrome');
const results = [];
function passed(name) {
  results.push(name);
  console.log('PASS ' + name);
}
const profile = await mkdtemp(join(tmpdir(), 'safestep-chrome-test-'));
const launch = () =>
  puppeteer.launch({
    executablePath,
    userDataDir: profile,
    pipe: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|COOKIE|PASSWORD)/i.test(key))),
    headless: false,
    defaultViewport: null,
    enableExtensions: true,
    args: [
      '--enable-unsafe-extension-debugging',
      ...(apiHost === '127.0.0.1' ? [] : ['--host-resolver-rules=MAP 127.0.0.1:4317 ' + apiHost + ':4317']),
      '--no-first-run',
      '--disable-background-networking',
      '--window-position=-1600,40',
      '--window-size=1260,900',
    ],
  });
const api = makeApi(new ProvidersService({}));
let browser;
let panel, page;
try {
  api.listen(apiPort, apiHost);
  await once(api, 'listening');
  browser = await launch();
  const version = await browser.version(),
    root = await browser.target().createCDPSession();
  // Match the user's normal unpacked-install setup. This preference exists only in our disposable profile.
  const management = await browser.newPage();
  await management.goto('chrome://extensions/');
  await management.evaluate(async () => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
  });
  await management.close();
  const { id } = await root.send('Extensions.loadUnpacked', { path: bundle });
  passed(version + ' loaded the production MV3 bundle ' + sha256.slice(0, 12));
  page = await browser.newPage();
  await page.goto(fixture.origin);
  await page.bringToFront();
  const initialWorker = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes(id),
    { timeout: 6000 },
  );
  const log = await initialWorker.createCDPSession();
  await log.send('Runtime.enable');
  const iw = await initialWorker.worker();
  assert(await iw.evaluate(() => chrome.action.onClicked.hasListeners()));
  const tabTarget = async (p) =>
    (await root.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find(
      (t) => t.url === p.url(),
    ).targetId;
  const targetId = await tabTarget(page);
  await root.send('Extensions.triggerAction', { id, targetId });
  const pt = await browser.waitForTarget(
    (t) => t.url() === 'chrome-extension://' + id + '/sidepanel.html',
    { timeout: 8500 },
  );
  panel = await pt.asPage();
  panel.setDefaultTimeout(6500);
  const contexts = await panel.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }),
  );
  assert(contexts.length > 0);
  const button = (name) => ({
    click: async () => {
      if (/^(?:Inspect page|Highlight |Clear highlight|Pause$|Resume$|Check local service)/.test(name)) {
        await openAdvanced(panel);
      } else if (/^(?:Clear SafeStep data|Enable on this site|Restore page)$/.test(name)) {
        await openArea(panel, 'Settings');
        await openDetails(panel, 'Access & preferences');
      }
      await panel.locator('::-p-aria(' + name + '[role="button"])').setTimeout(6000).click();
    },
  });
  const waitText = async (s) =>
    panel.waitForFunction((text) => document.body.innerText.includes(text), {}, s);
  await waitText('Access for this visit');
  passed('toolbar action opened native SIDE_PANEL and acquired temporary access');
  await panel.type('#goal', 'Find practice settings');
  await button('Inspect page').click();
  await waitText('Practice settings');
  const dump = await panel.evaluate(() => document.body.innerText);
  assert(!/PRIVATE_|HIDDEN_SENTINEL|FRAME_SENTINEL|omit-this/.test(dump));
  assert(dump.includes('Embedded frames were not inspected'));
  passed('native panel reads bounded controls without form values, query tokens or frame data');
  await button('Highlight Practice settings').click();
  await page.waitForSelector('[data-safestep-outline]');
  await waitText('Showing highlight');
  passed('content script outlined the selected control without clicking it');
  const dimensions = (p) =>
    p.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  const viewport = {
    page: await dimensions(page),
    sidePanel: await dimensions(panel),
    window: (await root.send('Browser.getWindowForTarget', { targetId })).bounds,
  };
  await mkdir('.test-artifacts', { recursive: true });
  await panel.screenshot({ path: '.test-artifacts/panel.png' });
  await page.screenshot({ path: '.test-artifacts/highlight.png' });
  await button('Clear highlight').click();
  await page.waitForFunction(() => !document.querySelector('[data-safestep-outline]'));
  passed('panel cleared the outline');
  await openAdvanced(panel);
  const sourceDetails = await openDetails(panel, 'Sources & coverage');
  await button('Check local service').click();
  await waitText('Local service connected.');
  const sourceRows = await sourceDetails.$$eval(':scope > ul > li', (items) =>
    items.map((item) => item.innerText.trim()),
  );
  assert.deepEqual(sourceRows, [
    'intent', 'url threat', 'website reputation', 'seller feedback', 'product feedback', 'shopping comparison',
  ].map((name) => name + ' · Not configured'));
  passed('native panel reached the loopback API and displayed six unconfigured providers');
  await runCases({
    browser,
    root,
    id,
    fixture,
    page,
    panel,
    button,
    waitText,
    tabTarget,
    passed,
    worker: iw,
    log,
  });
  // Reload the installed extension, not just its React document.
  await page.bringToFront();
  await page.goto(fixture.origin);
  const priorPanel = panel.target();
  const priorWorker = browser
    .targets()
    .find((t) => t.type() === 'service_worker' && t.url().includes(id));
  const gone = new Promise((resolve) => {
    const handler = (t) => {
      if (t === priorPanel) {
        browser.off('targetdestroyed', handler);
        resolve();
      }
    };
    browser.on('targetdestroyed', handler);
  });
  await panel.evaluate(() => {
    setTimeout(() => chrome.runtime.reload(), 50);
  });
  await Promise.race([
    gone,
    new Promise((_, no) => {
      const timer = setTimeout(() => no(Error('Extension reload did not close panel')), 7000);
      timer.unref();
    }),
  ]);
  // An idle extension need not start its worker solely because the extension reloaded.
  const wake = await browser.newPage();
  await wake.goto(fixture.origin);
  await wake.close();
  const reloadTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t !== priorWorker && t.url().includes(id),
    { timeout: 8500 },
  );
  const reloadWorker = await reloadTarget.worker();
  assert(await reloadWorker.evaluate(() => chrome.action.onClicked.hasListeners()));
  await page.bringToFront();
  await root.send('Extensions.triggerAction', { id, targetId: await tabTarget(page) });
  panel = await (
    await browser.waitForTarget(
      (t) => t !== priorPanel && t.url() === 'chrome-extension://' + id + '/sidepanel.html',
      { timeout: 8500 },
    )
  ).asPage();
  await waitText('Access for this visit');
  const reloaded = await view(panel);
  assert(reloaded.v.prefs.largeText);
  assert.equal(reloaded.v.task, null);
  await button('Inspect page').click();
  await waitText('Practice settings');
  assert((await view(panel)).v.task);
  passed('extension reload preserved local preferences and required fresh inspection');
  await browser.close();
  panel = null;
  browser = await launch();
  const after = await browser.target().createCDPSession();
  const installed = (await after.send('Extensions.getExtensions')).extensions;
  if (!installed.some((e) => e.id === id && e.enabled))
    assert.equal((await after.send('Extensions.loadUnpacked', { path: bundle })).id, id);
  page = await browser.newPage();
  await page.goto(fixture.origin);
  await page.bringToFront();
  const target = (
    await after.send('Target.getTargets', { filter: [{ type: 'tab' }] })
  ).targetInfos.find((t) => t.url === page.url());
  await after.send('Extensions.triggerAction', { id, targetId: target.targetId });
  const fresh = await browser.waitForTarget(
    (t) => t.url() === 'chrome-extension://' + id + '/sidepanel.html',
    { timeout: 8000 },
  );
  panel = await fresh.asPage();
  await panel.waitForSelector('#goal');
  const restarted = await view(panel);
  assert.equal(restarted.v.task, null);
  assert.equal(restarted.v.snapshot, null);
  assert(restarted.v.prefs.largeText);
  const sessions = await panel.evaluate(() => chrome.storage.session.get(null));
  assert(!Object.values(sessions).some((c) => c.task));
  passed(
    'browser restart with the same profile preserved preferences and had no previous tasks or handles',
  );
  await button('Clear SafeStep data').click();
  await waitText('Access needed');
  const empty = await view(panel);
  assert.equal(empty.v.prefs.largeText, false);
  assert.deepEqual(empty.v.prefs.sites, []);
  assert.equal(empty.v.task, null);
  passed('Clear SafeStep data reset preferences, task state and application access');
  await writeFile(
    '.test-artifacts/chrome-results.json',
    JSON.stringify(
      {
        version,
        manifest: manifest.manifest_version,
        bundle,
        sha256,
        viewport,
        verifiedAt: new Date().toISOString(),
        checks: results,
      },
      null,
      2,
    ) + '\n',
  );
} catch (e) {
  if (browser?.connected) {
    const diagnostic = await browser.target().createCDPSession();
    console.error(
      'Test extensions:',
      (await diagnostic.send('Extensions.getExtensions')).extensions,
    );
    console.error(
      'Test profile targets:',
      (await diagnostic.send('Target.getTargets', { filter: [{}] })).targetInfos.map((t) => [
        t.type,
        t.url,
      ]),
    );
  }
  console.error(
    'Fixture panel:',
    panel
      ? await panel.evaluate(() => document.body.innerText).catch(() => '(closed)')
      : 'not open',
  );
  throw e;
} finally {
  if (browser?.connected) await browser.close();
  fixture.server.close();
  api.closeAllConnections();
  api.close();
  if (
    dirname(resolve(profile)) === resolve(tmpdir()) &&
    basename(profile).startsWith('safestep-chrome-test-')
  )
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
