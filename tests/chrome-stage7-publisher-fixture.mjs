// Harmless Stage 7 publisher mechanism check. All website resources are intercepted.
// Local package guidance in this file earns no live-site or Gemini credit.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { view } from './support/chrome-cases.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { guidedMode, openArea } from './support/stage7-panel.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle),
  dir = join('.test-artifacts', 'stage7', sha256.slice(0, 12));
await mkdir(dir, { recursive: true });
const trial = process.env.SAFESTEP_S7_TRIAL ?? '';
assert(!trial || /^[a-z0-9-]{1,45}$/.test(trial));
const widthFilter = Number(process.env.SAFESTEP_WIDTH || 0);
const base = 'https://www.videolan.org',
  terminal = '/vlc/download-windows.html';
const lab = await readFile(new URL('./fixtures/download-lab.html', import.meta.url), 'utf8');
const menu = (heading, label, href) =>
  '<!doctype html><title>Labelled publisher fixture</title><main><h1>' +
  heading +
  '</h1>' +
  '<p>Labelled SafeStep practice · publisher navigation fixture.</p><a href="' +
  href +
  '">' +
  label +
  '</a>' +
  '<div aria-label="Sponsored"><b>Sponsored</b><a href="https://ads.example.test/offer">Download now</a></div></main>';
const pages = new Map([
  ['/', menu('Publisher practice home', 'VLC media player', '/vlc/')],
  ['/vlc/', menu('VLC media player', 'VLC for Windows', terminal)],
  [terminal, lab],
]);
const results = [],
  target = join(
    dir,
    ['run', 'publisher-fixture', widthFilter || 'both', trial].filter(Boolean).join('-') + '.json',
  );
const current = async (s) => (await view(s.panel)).v;
async function until(f, why, ms = 16000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await f();
    if (result) return result;
    await delay(75);
  }
  throw Error('Timed out: ' + why);
}
async function goal(s, t) {
  await openArea(s.panel, 'Guide');
  await s.panel.$eval('#goal', (e) => e.select());
  await s.panel.keyboard.type(t);
  await s.panel.keyboard.press('Enter');
}
async function outlined(page) {
  const handle = await page.evaluateHandle(() => {
    const ring = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
    if (!ring) return null;
    return (
      [...document.querySelectorAll('a[href]')].find((a) => {
        const box = a.getBoundingClientRect();
        return (
          box.width &&
          Math.abs(box.left - ring.left - 3) < 1 &&
          Math.abs(box.top - ring.top - 3) < 1
        );
      }) ?? null
    );
  });
  return handle.asElement();
}
async function run(width, automatic) {
  const r = {
    name: automatic ? 'fixtureDownloadAuto' : 'fixtureDownloadGuide',
    width,
    status: 'fail',
    checks: [],
    caseChecks: {},
    source:
      'labelled intercepted publisher pages and existing harmless Stage 3 download lab; keyless local route',
    navigations: [],
    manualPageClicks: [],
    forbiddenRequests: [],
    downloads: 0,
    screens: [],
  };
  let s;
  try {
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, base + '/', {
      prepare: async (page) => {
        await page.setRequestInterception(true);
        page.on('request', (q) => {
          const u = new URL(q.url());
          if (
            q.isNavigationRequest() &&
            q.frame() === page.mainFrame() &&
            u.origin === base &&
            !u.search &&
            pages.has(u.pathname)
          ) {
            r.navigations.push(u.pathname);
            void q.respond({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              headers: { 'Cache-Control': 'no-store' },
              body: pages.get(u.pathname),
            });
            return;
          }
          if (
            q.isNavigationRequest() ||
            u.hostname === 'ads.example.test' ||
            /\.(?:exe|msi|zip|7z|dmg)(?:$|[?#])/i.test(q.url())
          )
            r.forbiddenRequests.push({ host: u.host, path: u.pathname });
          void q.abort();
        });
      },
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const ext = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    );
    assert(ext?.enabled && resolve(ext.path) === bundle);
    r.loaded = { id: ext.id, path: ext.path, enabled: ext.enabled };
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    const ambiguous = 'Help me find the download button';
    await goal(s, ambiguous);
    await s.panel.waitForSelector('button::-p-text(VLC · Windows x64 EXE)');
    assert(!(await current(s)).task);
    assert.equal(await s.panel.$eval('#goal', (e) => e.value), ambiguous);
    assert.deepEqual(r.navigations, ['/']);
    const text = 'Help me find the VLC Windows x64 EXE download';
    await goal(s, text);
    const ready = await until(async () => {
      const t = (await current(s)).task;
      return t?.state === 'awaiting_confirmation' && t;
    }, 'package confirmation');
    assert.equal(ready.goal, text);
    assert.equal(ready.adaptive.download, 'vlc_windows_x64');
    await guidedMode(s.panel, automatic);
    const done = await until(
      async () => {
        const v = await current(s),
          t = v.task;
        if (t?.state === 'completed') return v;
        if (['paused', 'cancelled', 'failed'].includes(t?.state))
          throw Error(t.adaptive?.status ?? t.state);
        if (!automatic && t?.state === 'showing_step') {
          const index = r.manualPageClicks.length;
          if (index >= 2) return false;
          const link = await outlined(s.page);
          if (!link) return false;
          const next = ['/vlc/', terminal][index];
          if (new URL(s.page.url()).pathname !== ['/', '/vlc/'][index]) return false;
          assert.equal(await link.evaluate((a) => a.href), base + next);
          // The tester follows only the product's actual live outline in guide mode.
          r.manualPageClicks.push(next);
          await link.click();
        }
        return false;
      },
      'two publisher information steps and user-controlled package handoff',
      35000,
    );
    assert.deepEqual(r.navigations, ['/', '/vlc/', terminal]);
    assert.deepEqual(r.manualPageClicks, automatic ? [] : ['/vlc/', terminal]);
    assert.equal(done.task.id, ready.id);
    assert.equal(done.task.goal, text);
    assert(done.task.steps >= 2);
    assert.equal(done.task.adaptive.calls, 0);
    const d = done.review;
    assert(d?.selected && d.binding.taskId === ready.id);
    const selected = d.candidates.find((x) => x.ref === d.selected),
      sponsor = d.candidates.find((x) => x.reason === 'sponsored');
    assert.equal(d.fileState, 'identified');
    assert.equal(selected?.reason, 'publisher_vlc');
    assert.equal(selected.publisherPath, '/vlc/4.2.0/win64/vlc-4.2.0-win64.exe');
    assert(sponsor && sponsor.ref !== selected.ref && sponsor.relation === 'warning_pattern');
    const final = await until(() => outlined(s.page), 'outlined unique file control');
    assert.equal(await final.evaluate((a) => a.id), 'downloadButton2');
    assert.equal(await s.page.$eval('#count', (e) => e.textContent), '0');
    assert.deepEqual(r.forbiddenRequests, []);
    assert.equal(r.downloads, 0);
    r.finalReview = {
      selected,
      sponsor,
      steps: done.task.steps,
      fileState: d.fileState,
      activationCount: 0,
      modelCalls: 0,
    };
    r.checks.push(
      'Local, labelled publisher navigation crossed two fresh information pages; ' +
        (automatic
          ? 'automatic mode had zero harness page clicks.'
          : 'guide mode followed two inspected highlights.') +
        ' At the final page the exact VLC x64 EXE was outlined, the Sponsored control was reported separately, and zero file, ad or unrelated actions were requested.',
    );
    r.caseChecks['S7-X07'] = [
      'The ambiguous goal was preserved without navigation; the final evidence distinguished the actual Windows package from a deceptive sponsored option.',
    ];
    r.caseChecks['S7-X08'] = r.checks.slice();
    for (const [area, surface] of [
      ['panel', s.panel],
      ['page', s.page],
    ]) {
      const file = [r.name, width, area, trial].filter(Boolean).join('-') + '.png';
      await surface.screenshot({ path: join(dir, file) });
      r.screens.push(file);
    }
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message ?? e).slice(0, 420);
    if (s) {
      const v = await current(s).catch(() => null);
      r.diagnostic = {
        state: v?.task?.state,
        info: v?.task?.adaptive?.status,
        at: new URL(s.page.url()).pathname,
        review: v?.review?.fileState,
      };
    }
  } finally {
    if (s) await s.browser.close();
    results.push(r);
    await writeFile(
      target,
      JSON.stringify(
        {
          role: 'builder',
          at: new Date().toISOString(),
          bundle,
          sha256,
          pairedProvider: false,
          results,
        },
        null,
        2,
      ),
    );
    console.log(r.status, r.name, width, r.error ?? '', r.diagnostic ?? '');
  }
}
for (const w of [1440, 1366])
  if (!widthFilter || widthFilter === w) for (const auto of [false, true]) await run(w, auto);
if (!results.length || results.some((r) => r.status !== 'pass')) process.exitCode = 1;
