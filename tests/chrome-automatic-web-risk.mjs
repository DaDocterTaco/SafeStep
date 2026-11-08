// Installed Chrome, controlled public-shaped pages and labelled source responses.
// No provider key is read. The positive download URL is never visited or fetched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './support/functional-navigation-fixture.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import { verifyFoldedPositive } from './support/folded-warning.mjs';

const id = process.argv[2],
  bundle = resolve('artifacts', id, 'chrome-mv3');
const digest = await fingerprint(bundle);
assert.equal(id, 'stage-8-' + digest.sha256.slice(0, 12));
const refs = JSON.parse(await readFile('docs/evidence/' + id + '/current-reference.json', 'utf8'));
assert.equal(refs.extensionSHA256, digest.sha256);
const dir = resolve(
  'docs/evidence',
  id,
  'automatic-protection-native',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(dir, { recursive: true });
const button = (p, text) => p.locator('::-p-aria(' + text + '[role="button"])').setTimeout(8500);
const until = async (fn, label, timeout = 16000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await fn().catch(() => null);
    if (r) return r;
    await delay(90);
  }
  throw Error('Timed out: ' + label);
};
const spec = {
  name: 'vlc-auto',
  profile: 'vlc_windows_x64',
  goal: 'Help me find the VLC Windows x64 EXE download on the official website.',
};
const results = [];
for (const width of [1440, 1366]) {
  const row = {
    width,
    checks: [],
    requests: [],
    screens: [],
    connector: [],
    fileRequests: 0,
    automaticWebsiteClicksByDriver: 0,
    status: 'fail',
  };
  let session, fixture;
  try {
    const provider = {
      readiness: () => ({ provider: 'url_threat', status: 'ready', credentialPresent: false }),
      check: async (q) => {
        row.requests.push({ ...q });
        const match =
          q.purpose === 'target' || q.url === 'https://en.wikipedia.org/wiki/Atmosphere_of_Earth';
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
    };
    fixture = await startFixture(spec, row, '127.0.0.6', provider);
    const initial = 'https://en.wikipedia.org/wiki/Main_Page';
    session = await nativeSession(bundle, width, width === 1440 ? 900 : 768, initial, {
      requireUsablePanel:true,
      apiHost: '127.0.0.6',
      prepare: async (p) => {
        await p.setRequestInterception(true);
        p.on('request', (req) => {
          const url = new URL(req.url());
          if (/\.(?:exe|zip|msi|7z)$/i.test(url.pathname)) {
            row.fileRequests++;
            void req.abort().catch(() => {});
            return;
          }
          if (url.hostname === 'www.videolan.org') {
            void req.continue().catch(() => {});
            return;
          }
          void (
            req.isNavigationRequest()
              ? req.respond({
                  status: 200,
                  contentType: 'text/html',
                  body: '<!doctype html><html><title>SafeStep public route fixture</title><main><h1>Public route fixture</h1></main></html>',
                })
              : req.abort()
          ).catch(() => {});
        });
      },
    });
    const s = session;
    let panel = s.panel;
    const state = async () => (await view(panel)).v;
    const screenshot = async (p, name) => {
      const file = width + '-' + name + '.png';
      await p.screenshot({ path: join(dir, file) });
      row.screens.push(file);
    };
    const loaded = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (e) => e.id === s.id,
    );
    assert(loaded?.enabled && resolve(loaded.path) === bundle);
    row.dimensions = s.dimensions;
    row.chrome = await s.browser.version();
    await button(panel, 'Settings').click();
    await panel.locator('summary::-p-text(Connect local AI)').click();
    await panel.type('input[type=password]', fixture.token);
    await button(panel, 'Connect').click();
    await until(
      () => panel.evaluate(() => /Connected[. ]/.test(document.body.innerText)),
      'pairing',
    );
    assert.equal(row.requests.length, 0);
    await panel.select('[aria-label="Auto protection settings"] select', 'all');
    await panel
      .locator('::-p-aria(Allow automatic public URL checks with Google Web Risk[role="checkbox"])')
      .click();
    await button(panel, 'Apply protection settings').click();
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
    await until(
      async () => (await state()).prefs.protection?.automaticUrlConsent === 2,
      'actual grant and new consent',
    );
    await until(async () => row.requests.some((x) => x.url === initial), 'automatic first enable');
    row.checks.push('Consent/grant checks initial public URL');
    await panel
      .evaluate(async () =>
        chrome.sidePanel.close({ windowId: (await chrome.windows.getCurrent()).id }),
      )
      .catch(() => {});
    await until(
      async () =>
        !(await s.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
          t.url.endsWith(s.id + '/sidepanel.html'),
        ),
      'panel closed',
    );
    const urls = [
      'https://en.wikipedia.org/wiki/Atmosphere_of_Earth',
      'https://www.videolan.org/support/',
      'https://resell.store/discover',
      'http://example.org/docs/setup',
    ];
    for (const url of urls) {
      await s.page.goto(url, { waitUntil: 'domcontentloaded' });
      const committed = s.page.url();
      (row.committedURLs ??= []).push({ requested: url, committed });
      await until(
        async () => row.requests.some((q) => q.url === committed && q.purpose === 'arrival'),
        'closed panel ' + committed,
      );
      if (url === urls[0]) {
        await s.page.waitForSelector('[data-safestep-protection]', { timeout: 12000 });
        await screenshot(s.page, 'closed-warning');
        if (process.env.SAFESTEP_FOLDED_ATTRIBUTION === '1') await verifyFoldedPositive(s,row,dir);
        const count = row.requests.filter((q) => q.url === url).length;
        await s.page.evaluate(() => {
          location.hash = 'History';
        });
        await delay(500);
        assert.equal(row.requests.filter((q) => q.url === url).length, count);
      }
    }
    row.checks.push(
      'Closed panel: Wikipedia, VideoLAN, Resell and held-out origin match Chrome’s committed scheme/path; heading anchor charged zero',
    );
    const genericOrigin = new URL(s.page.url()).origin;
    await s.page.evaluate(() => history.pushState({}, '', '/docs/changed'));
    await until(
      async () => row.requests.some((q) => q.url === genericOrigin + '/docs/changed'),
      'SPA route',
    );
    const before = row.requests.length;
    await s.page.goto('http://example.org/account?token=synthetic-private', {
      waitUntil: 'domcontentloaded',
    });
    await delay(500);
    assert.equal(row.requests.length, before);
    row.checks.push('Public history change covered; private route sent no request');
    await s.page.goto('https://www.videolan.org/', { waitUntil: 'domcontentloaded' });
    await s.page.bringToFront();
    await s.activate(s.page);
    panel = await (
      await s.browser.waitForTarget((t) => t.url().endsWith(s.id + '/sidepanel.html'))
    ).asPage();
    await panel.locator('#chat-composer').fill(spec.goal);
    await panel.keyboard.press('Enter');
    await until(async () => {
      const v = await state(),
        turn = v.chat?.turns.at(-1);
      if (turn?.choices?.includes('VLC · Windows x64 EXE'))
        await button(panel, 'VLC · Windows x64 EXE').click();
      return v.task?.state === 'awaiting_confirmation';
    }, 'download task');
    await button(panel, 'Take me there').click();
    await button(panel, 'Start automatic').click();
    await until(async () => {
      const v = await state();
      row.lastProtection={url:s.page.url(),task:v.task?.state,status:v.task?.adaptive?.status,
        destination:v.protection?.destination?.result?.status};
      return v.task?.state === 'paused' && v.protection?.destination?.result?.status === 'match';
    }, 'pre-dispatch pause');
    assert.equal(s.page.url(), 'https://www.videolan.org/');
    assert.equal(row.fileRequests, 0);
    await screenshot(panel, 'target-paused');
    row.checks.push(
      'Product automatic action held on a reported target; original website stayed visible',
    );
    await button(panel, 'Settings').click();
    await panel.select('[aria-label="Auto protection settings"] select', 'off');
    await button(panel, 'Apply protection settings').click();
    await until(async () => (await state()).prefs.protection?.scope === 'off', 'off');
    const after = row.requests.length;
    await s.page.goto('http://example.org/docs/off', { waitUntil: 'domcontentloaded' });
    await delay(500);
    assert.equal(row.requests.length, after);
    row.checks.push('Switching off stopped subsequent requests');
    row.status = 'pass';
  } catch (e) {
    row.error = String(e?.message ?? e).slice(0, 400);
  } finally {
    if (session) await session.browser.close();
    if (fixture) {
      fixture.server.closeAllConnections();
      await new Promise((done) => fixture.server.close(done));
    }
    results.push(row);
    await writeFile(
      join(dir, 'results.json'),
      JSON.stringify(
        {
          role: 'builder',
          id,
          refs,
          provider:
            'Controlled Web Risk and model transport. Real installed Chrome; real VideoLAN site. Other public route templates intercepted for safety.',
          results,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(width, row.status, row.error ?? '', dir);
  }
}
if (results.some((r) => r.status !== 'pass')) process.exitCode = 1;
