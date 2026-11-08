// Builder verification. A real unpacked extension, native Chrome panel and actual website clicks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeSession, measure } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { openArea } from './support/stage7-panel.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
const out = resolve('.test-artifacts/stage2', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const chosen = process.env.SAFESTEP_CASES ?? 'wiki,video,edges';
assert(chosen.split(',').every((group) => ['wiki', 'video', 'edges'].includes(group)), 'unknown Stage 2 test group');
if (process.env.SAFESTEP_WIDTH) assert(['1440', '1366'].includes(process.env.SAFESTEP_WIDTH), 'unknown Stage 2 desktop size');
const results = [];
const setups = {
  wiki: {
    url: 'https://en.wikipedia.org/wiki/Phishing',
    goal: 'Help me find the APA citation for this article.',
    steps: ['Open Tools', 'Choose Cite this page', 'Choose APA'],
    selectors: ['#vector-page-tools-dropdown-label', '#t-cite a', 'main a[href$="#APA_style"]'],
    names: ['Tools', 'Cite this page', 'APA'],
    host: 'en.wikipedia.org',
    domain: 'wikipedia.org',
  },
  video: {
    url: 'https://www.videolan.org/',
    goal: 'Help me find VLC for Windows.',
    steps: ['Open the VLC menu', 'Choose Download', 'Choose Windows'],
    selectors: ['#main-navbar .dropdown-toggle', '#main-navbar .dropdown-menu a', '.windows a'],
    names: ['VLC', 'Download', 'Windows'],
    host: 'www.videolan.org',
    domain: 'videolan.org',
  },
};
const button = (panel, name) =>
  panel.locator('::-p-aria(' + name + '[role="button"])').setTimeout(5500);
async function waitUI(panel, selector, contains) {
  await panel.waitForFunction(
    (sel, text) => [...document.querySelectorAll(sel)].some((el) =>
      el.getClientRects().length && el.innerText.includes(text)),
    { timeout: 10000 },
    selector,
    contains,
  );
}
async function until(f, why) {
  for (let i = 0; i < 70; i++) {
    if (await f()) return;
    await delay(100);
  }
  throw Error('Did not reach ' + why);
}
async function target(page, selector, name) {
  const matches = [];
  for (const el of await page.$$(selector)) {
    if (
      (await el.isVisible()) &&
      (await el.evaluate((e, n) => e.textContent.trim().replace(/\s+/g, ' ') === n, name))
    )
      matches.push(el);
  }
  assert.equal(matches.length, 1, 'unique visible ' + name);
  return matches[0];
}
async function ring(el) {
  return el.evaluate((e) => {
    const cue = document.querySelector('[data-safestep-outline]');
    if (!cue) return false;
    const a = e.getBoundingClientRect(),
      b = cue.getBoundingClientRect();
    return (
      Math.abs(a.left - b.left - 3) < 1 &&
      Math.abs(a.top - b.top - 3) < 1 &&
      Math.abs(a.width - b.width + 6) < 1 &&
      getComputedStyle(cue).pointerEvents === 'none' &&
      document.querySelectorAll('[data-safestep-outline]').length === 1
    );
  });
}
async function capture(s, prefix) {
  await s.page.screenshot({ path: join(out, prefix + '-page.png') });
  await s.panel.screenshot({ path: join(out, prefix + '-panel.png') });
}
async function safeDiagnostic(s) {
  try {
    const { v } = await view(s.panel);
    return {
      state: v.task?.state,
      issue: v.issue,
      facts: v.snapshot?.guide?.result,
      step: v.task?.guide?.step,
      path: new URL(s.page.url()).pathname,
      instruction: await s.panel
        .$eval('[data-testid=instruction]', (e) => e.textContent)
        .catch(() => null),
    };
  } catch {
    return {};
  }
}
async function journey(site, width, height) {
  const c = setups[site],
    r = { kind: 'live', site, width, height, steps: [] };
  let s;
  try {
    s = await nativeSession(bundle, width, height, c.url);
    r.chrome = await s.browser.version();
    r.dimensions = s.dimensions;
    // Count (and abort) any installer request rather than allow a test to download a file.
    const files = [];
    await s.page.setRequestInterception(true);
    s.page.on('request', (q) => {
      let u = new URL(q.url());
      if (/\.(?:exe|msi|dmg|zip|7z)$/i.test(u.pathname)) {
        files.push(true);
        void q.abort();
      } else void q.continue();
    });
    await s.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const { panel, page } = s;
    await openArea(panel, 'Guide');
    await panel.focus('#goal');
    await panel.keyboard.type(c.goal);
    await panel.keyboard.press('Enter');
    for (let i = 0; i < 3; i++) {
      await waitUI(panel, '[data-testid=instruction]', c.steps[i]);
      const a = (await view(panel)).v;
      assert.equal(a.task.guide.step, i + 1);
      assert.equal(a.snapshot.address.host, c.host);
      assert.equal(a.snapshot.address.domain, c.domain);
      assert(a.snapshot.address.allowed);
      assert.equal(a.snapshot.address.relationship, 'expected_host');
      const el = await target(page, c.selectors[i], c.names[i]);
      await until(() => ring(el), 'outline alignment');
      if (a.snapshot.guide.placement !== 'visible') {
        await button(panel, 'Show me').click();
        await until(
          async () => (await view(panel)).v.snapshot?.guide?.placement === 'visible',
          'visible target',
        );
        assert(await ring(el));
      }
      if (i === 0 || i === 2) await capture(s, site + '-' + width + '-step' + (i + 1));
      r.steps.push({
        step: i + 1,
        name: c.names[i],
        observedPlacement: a.snapshot.guide.placement,
        aligned: true,
      });
      // Screenshotting the native panel may focus that target. Click in the live page
      // after its menu scripts have loaded, as a user returning to the site would.
      await page.bringToFront();
      if (i === 0) await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 });
      if(site==='video'&&i===0){
        // VideoLAN's desktop hover handler toggles the same menu as a click.
        // A second activation would close a menu the pointer just opened.
        await el.hover();
        const opened=await page.waitForFunction(()=>Array.from(document.querySelectorAll('#main-navbar .dropdown-menu a')).some(a=>a.textContent.trim()==='Download'&&a.checkVisibility({checkVisibilityCSS:true})&&a.getBoundingClientRect().height>0),{timeout:900}).then(()=>true,()=>false);
        if(!opened)await el.click();
        r.steps[i].activation=opened?'pointer opened menu on hover':'clicked closed menu';
      }else await el.click();
    }
    await waitUI(panel, '[data-testid=task-state]', 'Completed');
    const done = (await view(panel)).v;
    assert.equal(done.snapshot.guide.result, 'complete');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    if (site === 'wiki') {
      assert(
        await page.evaluate(() => {
          const u = new URL(location.href),
            h = document.querySelector('h3#APA_style'),
            b = h?.getBoundingClientRect();
          return (
            u.pathname === '/w/index.php' &&
            u.searchParams.get('title') === 'Special:CiteThisPage' &&
            u.searchParams.get('page') === 'Phishing' &&
            u.hash === '#APA_style' &&
            b &&
            b.bottom > 0 &&
            b.top < innerHeight
          );
        }),
      );
    } else {
      assert.equal(new URL(page.url()).pathname, '/vlc/download-windows.html');
      assert(
        await page.$$eval('h1', (els) =>
          els.some((e) => e.textContent.trim() === 'VLC for Windows'),
        ),
      );
    }
    assert.equal(files.length, 0);
    r.installerRequests = files.length;
    await capture(s, site + '-' + width + '-complete');
    await button(panel, 'Restart task').click();
    await until(async () => {
      const v = (await view(panel)).v;
      return v.task?.id !== done.task.id && v.task?.state === 'completed';
    }, 'new completed task');
    const restarted = (await view(panel)).v;
    assert.notEqual(restarted.task.id, done.task.id);
    assert.equal(restarted.task.state, 'completed');
    r.alreadyComplete = true;
    r.status = 'pass';
    console.log('PASS live journey', site, width, r.steps);
  } catch (e) {
    r.status = 'fail';
    r.error = e.message.split('\n')[0];
    r.diagnostic = s ? await safeDiagnostic(s) : {};
    console.log('FAIL', site, width, r.error, r.diagnostic);
  } finally {
    if (s) await s.browser.close();
  }
  return r;
}
for (const [width, height] of [
  [1440, 900],
  [1366, 768],
]) {
  if (process.env.SAFESTEP_WIDTH && width !== Number(process.env.SAFESTEP_WIDTH)) continue;
  for (const site of ['wiki', 'video'])
    if (chosen.split(',').includes(site)) results.push(await journey(site, width, height));
}
if (chosen.split(',').includes('edges')) {
  const { edgeCases } = await import('./support/stage2-edges.mjs');
  results.push(
    ...(await edgeCases({ bundle, out, button, waitUI, until, ring, capture, safeDiagnostic })),
  );
}
const record = { role: 'builder', sha256, bundle, checkedAt: new Date().toISOString(), results };
await writeFile(
  join(
    out,
    chosen === 'wiki,video,edges' && !process.env.SAFESTEP_WIDTH && !process.env.SAFESTEP_EDGE
      ? 'stage2.json'
      : 'stage2-' +
          chosen.replaceAll(',', '-') +
          (chosen.includes('edges') && process.env.SAFESTEP_EDGE ? '-' + process.env.SAFESTEP_EDGE : '') +
          '-' +
          (process.env.SAFESTEP_WIDTH ?? 'both') +
          '.json',
  ),
  JSON.stringify(record, null, 2) + '\n',
);
if (!results.length || results.some((r) => r.status !== 'pass')) process.exitCode = 1;
