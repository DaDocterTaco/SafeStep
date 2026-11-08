import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { openArea, openAdvanced, guidedMode } from './support/stage7-panel.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { fingerprint } from '../scripts/stage1.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
const out = resolve('.test-artifacts/stage7', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const fix = await startFixture(0),
  results = [],
  widths = process.env.SAFESTEP_WIDTH ? [Number(process.env.SAFESTEP_WIDTH)] : [1440, 1366];
const scenarios = (
    process.env.SAFESTEP_S7_CASES ??
    'ui,setup,unsupported,guidedSafety,restoreData,longCompare,conflict,downloadEdges,publisherOffline,downloadVlcGuide,downloadVlcAuto,download7Guide,download7Auto'
  ).split(','),
  trial = process.env.SAFESTEP_S7_TRIAL ?? '';
assert(!trial || /^[a-z0-9-]{1,50}$/i.test(trial));
const realAI = process.env.SAFESTEP_S7_LIVE === '1';
const btn = (p, name) => p.locator('::-p-aria(' + name + '[role="button"])').setTimeout(7000);
const wait = async (fn, why, ms = 18000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(110);
  }
  throw Error('Timed out: ' + why);
};
const screen = async (s, r, name, page = false) => {
  const file = [r.name, r.width, name, trial].filter(Boolean).join('-') + '.png';
  await (page ? s.page : s.panel).screenshot({ path: join(out, file) });
  r.screens.push(file);
};
const check = (r, ids, observation) => {
  for (const id of ids.split(' ')) (r.caseChecks[id] ??= []).push(observation);
  r.checks.push(observation);
};
const current = async (s) => (await view(s.panel)).v;
const goal = async (s, text) => {
  await openArea(s.panel, 'Guide');
  await s.panel.focus('#goal');
  await s.panel.$eval('#goal', (e) => e.select());
  await s.panel.keyboard.type(text);
  await s.panel.keyboard.press('Enter');
};
async function pair(s) {
  await openArea(s.panel, 'Settings');
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  const token = (await readFile('apps/api/.env.safestep-session', 'utf8')).trim();
  await s.panel.type('input[type=password]', token);
  await btn(s.panel, 'Connect').click();
  await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'));
  await openArea(s.panel, 'Guide');
}
function saved() {
  return writeFile(
    join(
      out,
      [
        'run',
        scenarios.join('-'),
        widths.length === 2 ? 'both' : String(widths[0]),
        realAI ? 'live' : 'local',
        trial,
      ]
        .filter(Boolean)
        .join('-') + '.json',
    ),
    JSON.stringify(
      { role: 'builder', at: new Date().toISOString(), sha256, bundle, pairedProvider: realAI, results },
      null,
      2,
    ) + '\n',
  );
}
const starts = {
  ui: fix.origin + '/settings-lab',
  setup: fix.origin + '/settings-lab',
  unsupported: 'chrome://version/',
  guidedSafety: fix.origin + '/settings-lab',
  restoreData: fix.origin + '/cleanup-lab',
  longCompare: fix.origin + '/comparison-lab/original',
  conflict: fix.origin + '/settings-lab',
  downloadEdges: fix.origin + '/download-lab?product=vlc',
  publisherOffline: fix.origin + '/download-lab?product=vlc',
  downloadVlcGuide: 'https://www.videolan.org/',
  downloadVlcAuto: 'https://www.videolan.org/',
  download7Guide: 'https://www.7-zip.org/download.html',
  download7Auto: 'https://www.7-zip.org/download.html',
};
async function unsupported(s, r) {
  const v = await current(s);
  assert.equal(v.access, 'unsupported_page');
  assert.equal(v.snapshot, null);
  assert(!v.protection);
  assert(
    (await s.panel.$eval('[aria-label="Current page"]', (e) => e.innerText)).includes(
      'Unsupported page',
    ),
  );
  await screen(s, r, 'unsupported');
  check(
    r,
    'S7-N01 S7-R07 S7-U04',
    'On a restricted Chrome page the native panel explained that access was unavailable, with no injected inspection or automatic protection.',
  );
}
async function guidedSafety(s, r) {
  await goal(s, 'Find my username settings');
  await wait(
    async () => (await current(s)).task?.state === 'awaiting_confirmation',
    'local goal ready',
  );
  await guidedMode(s.panel, false);
  const original = await wait(async () => {
    const t = (await current(s)).task;
    return t?.state === 'showing_step' && t;
  }, 'guided target');
  assert(await s.page.$('[data-safestep-outline]'));
  await openArea(s.panel, 'Safety checks');
  await btn(s.panel, 'Check this website').click();
  const checked = await wait(async () => {
    const v = await current(s);
    return v.review?.selection.kind === 'website' && v;
  }, 'website findings');
  assert.equal(checked.task.id, original.id);
  assert.equal(checked.task.goal, original.goal);
  assert(await s.page.$('[data-safestep-outline]'));
  await btn(s.panel, 'Return to guide').click();
  await btn(s.panel, 'Pause navigation').click();
  await wait(async () => (await current(s)).task.state === 'paused', 'paused');
  await btn(s.panel, 'Resume guide').click();
  await wait(async () => (await current(s)).task.state === 'showing_step', 'freshly resumed');
  assert.equal((await current(s)).task.id, original.id);
  assert(await s.page.$('[data-safestep-outline]'));
  await screen(s, r, 'resume');
  check(
    r,
    'S7-I01 S7-N04',
    'A website check preserved the original goal, task and guided target. Return to guide, Pause and Resume produced a fresh cue on the same task.',
  );
}
async function restoreData(s, r) {
  const p = s.panel;
  await s.page.focus('#private');
  await s.page.$eval('#private', (e) => e.select());
  await s.page.keyboard.type('Retain this local practice note');
  await s.page.evaluate(() => sessionStorage.setItem('practice-unrelated', 'preserved'));
  if (realAI) {
    await pair(s);
    assert(
      await p.evaluate(
        async () => !!(await chrome.storage.session.get('local-ai-session'))['local-ai-session'],
      ),
    );
  }
  await openAdvanced(p);
  await btn(p, 'Inspect page').click();
  await btn(p, 'Highlight Account settings').click();
  await s.page.waitForSelector('[data-safestep-outline]', { timeout: 7000 });
  await openArea(p, 'Guide');
  await btn(p, 'Preview cleanup').click();
  await btn(p, 'Apply cleanup').click();
  await wait(async () => (await current(s)).cleanup?.hidden > 0, 'hidden promo');
  assert(!(await s.page.$eval('#ad', (e) => e.checkVisibility())));
  await screen(s, r, 'cleanup');
  await btn(p, 'Restore page').click();
  await wait(async () => !(await current(s)).cleanup, 'restore');
  assert.equal(await s.page.$('[data-safestep-outline]'), null);
  assert(await s.page.$eval('#ad', (e) => e.checkVisibility()));
  assert.equal(await s.page.$eval('#private', (e) => e.value), 'Retain this local practice note');
  await openArea(p, 'Safety checks');
  await btn(p, 'Check this website').click();
  await wait(
    async () => (await current(s)).review?.selection.kind === 'website',
    'captured evidence',
  );
  await openArea(p, 'Shopping');
  await btn(p, 'Find alternatives').click();
  await wait(
    async () => (await current(s)).comparison?.status === 'unsupported',
    'unsupported page captured',
  );
  await openArea(p, 'Settings');
  await p.locator('summary::-p-text(Access & preferences)').click();
  await btn(p, 'Clear SafeStep data').click();
  const clear = await wait(async () => {
    const v = await current(s);
    return (
      !v.task && !v.review && !v.comparison && !v.cleanup && v.access === 'permission_required' && v
    );
  }, 'full reset');
  assert.equal(clear.prefs.sites.length, 0);
  assert(
    !(await p.evaluate(
      async () => !!(await chrome.storage.session.get('local-ai-session'))['local-ai-session'],
    )),
  );
  assert.deepEqual(
    await s.page.evaluate(() => [
      document.querySelector('#private').value,
      sessionStorage.getItem('practice-unrelated'),
    ]),
    ['Retain this local practice note', 'preserved'],
  );
  check(
    r,
    'S7-I08 S7-R04 S7-F09',
    'Restored the actual hidden ad and cleared SafeStep’s guide outline. Clear removed the task, website findings, comparison, site grant and pairing while retaining unrelated site input and session storage.',
  );
}
async function longCompare(s, r) {
  const p = s.panel;
  await s.page.select('#comparison-scenario', 'long-text');
  await s.page.waitForFunction(
    () => document.querySelector('#fixture-state')?.textContent === 'long-text',
  );
  await openArea(p, 'Shopping');
  await btn(p, 'Find alternatives').click();
  await p.waitForSelector('form.comparison-form');
  await p.type(
    '::-p-aria(Comparison goal[role="textbox"])',
    'Compare selected writing instruments from other sellers',
  );
  await btn(p, 'Find options').click();
  const result = await wait(async () => {
    const v = (await current(s)).comparison;
    return v?.candidates.some((c) => c.offer.id === 'long-item') && v;
  }, 'long option');
  const card = result.candidates.find((x) => x.offer.id === 'long-item');
  assert(card.offer.title.length > 90 && card.offer.sellerName.length > 50);
  await openArea(p, 'Settings');
  await p.locator('summary::-p-text(Access & preferences)').click();
  await p.locator('::-p-aria(Larger text[role="checkbox"])').click();
  await openArea(p, 'Shopping');
  await btn(p, 'Compare selected').click();
  await p.waitForSelector('.comparison-scroll table');
  await p.focus('.comparison-scroll');
  await p.keyboard.press('ArrowRight');
  assert(
    await p.$eval('.comparison-scroll', (e) => e.clientWidth > 0 && e.scrollWidth >= e.clientWidth),
  );
  assert(await p.$eval('body', (e) => e.scrollWidth <= innerWidth));
  assert.equal((await current(s)).comparison.id, result.id);
  await screen(s, r, 'large-comparison');
  check(
    r,
    'S7-U02 S7-U03 S7-F10',
    'The large-text table retained long listing/seller names, the original choices and keyboard-operable horizontal scrolling without widening the native panel.',
  );
}
async function ui(s, r) {
  const p = s.panel,
    labels = await p.$$eval('[role=tab]', (els) => els.map((e) => e.innerText));
  assert.deepEqual(labels, ['Guide', 'Safety checks', 'Shopping', 'Settings']);
  assert.equal((await current(s)).origin, fix.origin);
  assert(await p.$eval('[aria-label="Current page"]', (e) => e.innerText.includes('localhost')));
  await screen(s, r, 'guide');
  await screen(s, r, 'page', true);
  await p.focus('#goal');
  await p.keyboard.type('Find my username settings');
  const before = await current(s);
  const storageBefore = await p.evaluate(() => chrome.storage.session.get(null));
  for (const name of labels.slice(1)) {
    await openArea(p, name);
    assert.deepEqual(
      await p.$$eval('[role=tabpanel]', (els) =>
        els.filter((e) => !e.hidden).map((e) => e.getAttribute('aria-labelledby')),
      ),
      ['tab-' + name.toLowerCase().replace(' ', '-')],
    );
    await screen(s, r, name.replace(' ', '-'));
  }
  assert.equal((await current(s)).task?.id, before.task?.id);
  assert.equal((await current(s)).comparison, before.comparison);
  assert.deepEqual(await p.evaluate(() => chrome.storage.session.get(null)), storageBefore);
  await p.focus('#tab-settings');
  await p.keyboard.press('Home');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'tab-guide');
  await p.keyboard.press('ArrowRight');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'tab-safety-checks');
  await p.keyboard.press('End');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'tab-settings');
  await p.locator('summary::-p-text(Access & preferences)').click();
  await p.locator('::-p-aria(Larger text[role="checkbox"])').click();
  await wait(async () => (await current(s)).prefs.largeText, 'large preference');
  await openArea(p, 'Guide');
  assert.equal(await p.$eval('#goal', (el) => el.value), 'Find my username settings');
  assert.equal(await p.$eval('body', (el) => el.scrollWidth <= innerWidth), true);
  await screen(s, r, 'large-text');
  check(
    r,
    'S7-N01 S7-N02 S7-N03 S7-N06 S7-U01 S7-U02 S7-U03',
    'Measured native panel showed current host, grant and four reachable areas. Tab selection obeyed Arrow/Home/End and selected/focus state. The typed goal survived all four areas without starting a task, source request or grant. Larger text fit without horizontal page overflow.',
  );
}
async function setup(s, r) {
  const p = s.panel;
  await openArea(p, 'Settings');
  await p.locator('summary::-p-text(Connect local AI)').click();
  assert(await p.$('input[type=password]'));
  await screen(s, r, 'connection');
  await openAdvanced(p);
  assert(await p.$eval('section[aria-label="Manual page inspector"]', (e) => e.checkVisibility()));
  await p.locator('summary::-p-text(Access & preferences)').click();
  await btn(p, 'Clear SafeStep data').click();
  await wait(async () => {
    const v = await current(s);
    return !v.task && !v.comparison && v.access === 'permission_required';
  }, 'clear owned data');
  await screen(s, r, 'access-required');
  check(
    r,
    'S7-N05 S7-R04 S7-U04',
    'Settings explained site access, pairing and the separate automatic option. Advanced exposed manual inspection only after expansion. Clear SafeStep data removed tab authorization and owned tasks.',
  );
}
async function conflict(s, r) {
  const p = s.panel;
  await goal(s, 'Find my username settings');
  await wait(async () => {
    const t = (await current(s)).task;
    return t?.state === 'awaiting_confirmation' && t;
  }, 'local intent');
  await btn(p, 'Take me there').click();
  assert.equal((await current(s)).task.adaptive.authorized, false);
  await openArea(p, 'Shopping');
  assert.equal((await current(s)).task.adaptive.authorized, false);
  await openArea(p, 'Guide');
  let held;
  const pending = new Promise((ok) => {
    held = ok;
  });
  await s.page.setRequestInterception(true);
  s.page.on('request', (req) => {
    if (req.isNavigationRequest() && new URL(req.url()).pathname === '/settings-lab/account') {
      r.automaticPageRequests++;
      void pending.then(() => req.continue().catch(() => {}));
    } else void req.continue().catch(() => {});
  });
  try {
    await btn(p, 'Start automatic').click();
    await wait(() => r.automaticPageRequests, 'permitted product-issued navigation');
    await openArea(p, 'Shopping');
    await btn(p, 'Find alternatives').click();
    await wait(async () => {
      const t = (await current(s)).task;
      return t?.state === 'paused' && !t.adaptive.authorized;
    }, 'conflicting inspection pauses automatic');
    await screen(s, r, 'paused');
  } finally {
    held();
  }
  await sleep(550);
  assert((await current(s)).task?.state !== 'completed');
  assert.equal(r.automaticPageRequests, 1);
  check(
    r,
    'S7-N04 S7-I03 S7-F08 S7-R01',
    'The preview and area switch performed no site action. After approval the product dispatched one public navigation. Starting a shopping check paused automation, retired the pending step and allowed no second dispatch. The harness clicked no website controls.',
  );
}
async function edges(s, r) {
  const p = s.panel;
  await goal(s, 'Help me find the download button');
  assert(await p.waitForSelector('button::-p-text(VLC · Windows x64 EXE)'));
  assert(!(await current(s)).task);
  await screen(s, r, 'clarification');
  await goal(s, 'Find the VLC download for macOS');
  assert(
    await p.waitForFunction(() =>
      document.body.innerText.includes('different product, package or constraint'),
    ),
  );
  assert(!(await current(s)).task);
  assert.equal(await p.$eval('#goal', (e) => e.value), 'Find the VLC download for macOS');
  check(
    r,
    'S7-F02 S7-X07 S7-X26',
    'An unqualified download request asked for product and platform; a macOS request stayed intact without starting a Windows task or file request.',
  );
}
async function download(s, r) {
  const vlc = r.name.includes('Vlc'),
    auto = r.name.endsWith('Auto'),
    p = s.panel;
  const text = vlc
    ? 'Help me find the Windows VLC download.'
    : 'Help me find the right Windows x64 download.';
  await s.page.waitForFunction(() => document.readyState === 'complete', { timeout: 25000 });
  if (realAI) {
    const health = await (await fetch('http://127.0.0.1:4317/v1/assist/health')).json();
    const recent = health.recent.filter((x) => Date.now() - Date.parse(x.at) < 61000);
    if (recent.length > 2)
      await sleep(Math.max(0, 61000 - (Date.now() - Date.parse(recent.at(-1).at))));
    await pair(s);
  }
  const started = new Date().toISOString();
  await goal(s, text);
  if (vlc) await btn(p, 'VLC · Windows x64 EXE').click();
  const task = await wait(async () => {
    const t = (await current(s)).task;
    if (t?.state === 'paused') throw Error(t.adaptive?.status);
    return t?.state === 'awaiting_confirmation' && t;
  }, 'accepted publisher goal');
  assert.equal(task.goal, text);
  assert.equal(task.adaptive.download, vlc ? 'vlc_windows_x64' : 'seven_zip_windows_x64_exe');
  await screen(s, r, 'goal');
  await guidedMode(p, auto);
  let last = '';
  const done = await wait(
    async () => {
      const v = await current(s),
        t = v.task;
      if (!t) return false;
      if (t.state === 'completed') return v;
      if (['paused', 'failed', 'cancelled'].includes(t.state))
        throw Error(t.adaptive?.status ?? t.state);
      if (!auto && t.state === 'showing_step' && t.revision !== last) {
        const h = await s.page.evaluateHandle(() => {
          const ring = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
          if (!ring) return null;
          return (
            [...document.querySelectorAll('a[href]')].find((a) => {
              const b = a.getBoundingClientRect();
              return (
                b.width &&
                Math.abs(b.left - ring.left - 3) < 1 &&
                Math.abs(b.top - ring.top - 3) < 1
              );
            }) ?? null
          );
        });
        if (!h.asElement()) return false;
        const href = await h.evaluate((a) => a.href),
          url = new URL(href);
        assert.equal(url.origin, new URL(starts[r.name]).origin);
        assert(['/vlc/', '/vlc/download-windows.html', '/download.html'].includes(url.pathname));
        last = t.revision;
        await h.asElement().click();
        r.manualPageClicks.push(url.pathname);
      }
      return false;
    },
    'verified publisher terminal',
    60000,
  );
  const d = done.review;
  assert.equal(d.selection.kind, 'download');
  assert(d.selected && d.binding.taskId === done.task.id);
  const candidate = d.candidates.find((c) => c.ref === d.selected);
  assert(candidate);
  r.finalReview = {
    selection: d.selection,
    selected: candidate,
    source: d.sources.map((x) => x.kind),
    alternatives: d.candidates.length,
    stop: done.task.adaptive.status,
    steps: done.task.steps,
    path: new URL(s.page.url()).pathname,
  };
  assert(await s.page.$('[data-safestep-outline]'));
  assert.equal(r.fileAttempts, 0);
  assert.equal(r.downloads, 0);
  assert(!auto || !r.manualPageClicks.length);
  await screen(s, r, 'handoff');
  await screen(s, r, 'highlight', true);
  await btn(p, 'View publisher and destination').click();
  await screen(s, r, 'publisher-evidence');
  assert(
    await p.$eval('section[aria-label="Website and download checks"]', (e) =>
      e.innerText.includes('Ready for your review'),
    ),
  );
  if (realAI) {
    r.health = await (await fetch('http://127.0.0.1:4317/v1/assist/health')).json();
    r.operations = r.health.recent.filter((x) => x.at >= started);
    assert(r.operations.some((x) => x.operation === 'intent' && x.status === 'available'));
    if (vlc) assert(r.operations.some((x) => x.operation === 'step' && x.status === 'available'));
  }
  check(
    r,
    'S7-F05 S7-V04 ' + (auto ? 'S7-X09' : 'S7-X08'),
    'The natural ' +
      (vlc ? 'VLC' : '7-Zip') +
      ' goal reached the verified Windows x64 EXE control in ' +
      (auto ? 'approved automatic' : 'guide') +
      ' mode. The installed extension highlighted the current file and stopped. No installer request, download or account action occurred.',
  );
}
async function publisherOffline(s, r) {
  // Seed a labelled, deliberately invalid old pairing into this fresh test profile.
  await s.panel.evaluate(() =>
    chrome.storage.session.set({ 'local-ai-session': 'ss3_' + 'a'.repeat(43) }),
  );
  const text = 'Find the VLC Windows x64 download button.';
  await goal(s, text);
  const old = await wait(async () => {
    const t = (await current(s)).task;
    return t?.state === 'paused' && t;
  }, 'unavailable AI');
  assert.equal(old.goal, text);
  assert(!old.adaptive.authorized);
  await screen(s, r, 'provider-unavailable');
  await btn(s.panel, 'Use local publisher steps').click();
  const fresh = await wait(async () => {
    const t = (await current(s)).task;
    return t?.id !== old.id && t?.state === 'awaiting_confirmation' && t;
  }, 'explicit local route');
  assert.equal(fresh.goal, text);
  assert.equal(fresh.adaptive.calls, 0);
  await guidedMode(s.panel, false);
  const done = await wait(async () => {
    const v = await current(s);
    return v.task?.state === 'completed' && v.review?.selected && v;
  }, 'local verified control');
  assert.equal(done.review.selection.profile, 'vlc_windows_x64');
  assert.equal(r.fileAttempts, 0);
  check(
    r,
    'S7-R05 S7-X26',
    'A labelled invalid prior pairing produced a paused source error. The user explicitly chose the local publisher route, reconfirmed the same unchanged goal and reached a verified fixture control with zero model calls and zero installer activations.',
  );
}
try {
  for (const width of widths)
    for (const name of scenarios) {
      assert(starts[name]);
      let s;
      const r = {
        name,
        width,
        status: 'fail',
        checks: [],
        caseChecks: {},
        screens: [],
        fileAttempts: 0,
        downloads: 0,
        automaticPageRequests: 0,
        manualPageClicks: [],
      };
      try {
        s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, starts[name], {
          prepare: async (page) => {
            if (name.startsWith('download') || name === 'publisherOffline') {
              await page.setRequestInterception(true);
              page.on('request', (q) => {
                if (/\.(exe|msi|dmg|xpi|zip|7z)(?:$|[?#])/i.test(q.url())) {
                  r.fileAttempts++;
                  void q.abort();
                } else void q.continue();
              });
            }
          },
        });
        r.dimensions = s.dimensions;
        r.chrome = await s.browser.version();
        r.loaded = (await s.root.send('Extensions.getExtensions')).extensions
          .filter((x) => x.id === s.id)
          .map((x) => ({ id: x.id, path: x.path, enabled: x.enabled }))[0];
        assert(r.loaded.enabled && resolve(r.loaded.path) === bundle);
        await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
        s.root.on('Browser.downloadWillBegin', () => r.downloads++);
        const local = {
          ui,
          setup,
          unsupported,
          guidedSafety,
          restoreData,
          longCompare,
          conflict,
          downloadEdges: edges,
          publisherOffline,
        };
        await (local[name] ?? download)(s, r);
        assert.equal(r.downloads, 0);
        assert.equal(r.fileAttempts, 0);
        r.status = 'pass';
      } catch (e) {
        r.error = e.message.slice(0, 450);
        if (s) {
          const v = await current(s).catch(() => null);
          r.diagnostic = {
            task: v?.task?.state,
            status: v?.task?.adaptive?.status ?? null,
            review: v?.review?.selection,
            stale: v?.reviewStale,
          };
          await screen(s, r, 'failure').catch(() => {});
        }
      } finally {
        if (s) await s.browser.close();
        results.push(r);
        await saved();
        console.log(r.status, name, width, r.error ?? '', r.diagnostic ?? '');
      }
    }
} finally {
  fix.server.close();
}
if (results.some((x) => x.status !== 'pass')) process.exitCode = 1;
