import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { openArea, openDetails } from './support/stage7-panel.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import { explanationChoices, ExplanationInput } from '@safestep/contracts';
const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle),
  out = resolve('.test-artifacts/stage3', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const lab = await startFixture(0);
const chosen = process.env.SAFESTEP_S3_CASES?.split(',') ?? [
  'live',
  'labs',
  'pair',
  'idle',
  'isolation',
  'additional',
  'repairs',
];
const results = [];
const btn = (p, n) => p.locator('::-p-aria(' + n + '[role="button"])').setTimeout(6500);
const state = async (p, match) =>
  p.waitForFunction(
    (m) =>
      /^(?:Connected|Disconnected)/.test(m) ? document.body.innerText.includes(m) : document.querySelector('[aria-label="Website and download checks"]')?.innerText.includes(m),
    { timeout: 6500 },
    match,
  );
async function until(fn, what) {
  for (let n = 0; n < 65; n++) {
    if (await fn()) return;
    await sleep(80);
  }
  throw Error('Did not observe ' + what);
}
async function review(p) {
  return (await view(p)).v.review;
}
async function clickCheck(s) {
  await openArea(s.panel,'Safety checks');
  const prior = (await review(s.panel))?.binding.operationId;
  await btn(s.panel, 'Check this website').click();
  await until(async () => {
    const d = await review(s.panel);
    return d && d.binding.operationId !== prior && d.selection.kind === 'website';
  }, 'fresh website check');
  return review(s.panel);
}
async function file(s, profile) {
  await openArea(s.panel,'Safety checks');
  const p = s.panel;
  const download = await openDetails(p, 'Download help');
  const sel = await download.$$('select');
  assert.equal(sel.length, 2, 'Download help has product and Windows package selectors');
  await sel[0].select(profile);
  await sel[1].select('x64');
  const prior = (await review(p))?.binding.operationId;
  await btn(p, 'Identify button').click();
  await until(async () => {
    const d = await review(p);
    return d?.selection.kind === 'download' && d.binding.operationId !== prior;
  }, 'fresh download comparison');
  return review(p);
}
async function aligned(page, el) {
  return page.evaluate((e) => {
    const host = document.querySelector('[data-safestep-outline]'),
      a = e?.getBoundingClientRect(),
      b = host?.getBoundingClientRect();
    return (
      a &&
      b &&
      Math.abs(a.left - b.left - 3) < 1 &&
      Math.abs(a.top - b.top - 3) < 1 &&
      getComputedStyle(host).pointerEvents === 'none'
    );
  }, el);
}
async function run(name, w, h, url, fn, attachWorker = false, synthetic = false) {
  const r = {
    name,
    width: w,
    height: h,
    checks: [],
    installerAttempts: 0,
    downloads: 0,
    status: 'fail',
  };
  let s;
  try {
    s = await nativeSession(bundle, w, h, url, {
      attachWorker,
      prepare: async (p) => {
        await p.setRequestInterception(true);
        p.on('request', (req) => {
          const u = new URL(req.url());
          if (synthetic && u.hostname === 'xn--bcher-kva.test') {
            if (req.isNavigationRequest())
              void req.respond({
                status: 200,
                contentType: 'text/html',
                body: '<title>Labelled ordinary IDN page</title><h1>Practice information</h1><p>A well-designed HTTPS page with an ordinary external reference.</p><a href="https://example.org/">Further reading</a>',
              });
            else void req.abort();
            return;
          }
          if (
            u.hostname === 'get.videolan.org' ||
            /\/releases\/download\/|\.(?:exe|msi|7z|zip|dmg)$/i.test(u.pathname)
          ) {
            r.installerAttempts++;
            void req.abort();
          } else void req.continue();
        });
      },
    });
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    await fn(s, r);
    assert.equal(r.installerAttempts, 0);
    assert.equal(r.downloads, 0);
    r.status = 'pass';
  } catch (e) {
    r.error = e.message.split('\n')[0];
    if (s) {
      const v = (await view(s.panel).catch(() => ({ v: {} }))).v;
      r.diagnostic = {
        state: v.task?.state,
        review: v.review?.fileState,
        observations: v.review?.observations?.map((o) => o.code),
        stale: v.reviewStale,
        panelError: await s.panel.$eval('[role=alert]', (e) => e.textContent).catch(() => null),
      };
    }
  } finally {
    if (s) await s.browser.close();
  }
  console.log(r.status, name, w, JSON.stringify(r.checks), r.error ?? '');
  results.push(r);
  await writeProgress('in_progress');
  return r;
}
async function writeProgress(status) {
  const name = 'progress-' + chosen.join('-') + '-' + (process.env.SAFESTEP_WIDTH ?? 'both') + '.json';
  await writeFile(join(out, name), JSON.stringify({
    role: 'builder', sha256, bundle, status, at: new Date().toISOString(),
    completed: results.map(({name, width, status, error, diagnostic}) => ({name, width, status, error, diagnostic})),
  }, null, 2));
}
const livePages = [
  ['vlc_windows_x64', 'https://www.videolan.org/vlc/download-windows.html'],
  ['seven_zip_windows_x64_exe', 'https://www.7-zip.org/download.html'],
];
async function live(s, r, profile) {
  const { page, panel } = s;
  const d = await clickCheck(s);
  assert.equal(d.address.host, new URL(page.url()).hostname);
  assert(!d.fixture);
  assert(d.sources.every((x) => x.state === 'unavailable'));
  r.checks.push('S01 current hostname, source scope and time');
  await panel.$eval('article.review h2',e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  await panel.screenshot({path:join(out,profile+'-'+r.width+'-website-panel.png')});
  await btn(panel, 'Explain this check').click();
  await state(panel, 'AI explanation unavailable');
  const wrong = await file(
    s,
    profile === 'vlc_windows_x64' ? 'seven_zip_windows_x64_exe' : 'vlc_windows_x64',
  );
  assert.equal(wrong.fileState, 'unsupported');
  assert.equal(await page.$('[data-safestep-outline]'), null);
  const f = await file(s, profile);
  assert.equal(f.fileState, 'identified');
  const c = f.candidates.find((c) => c.ref === f.selected);
  assert.equal(c.relation, 'publisher_link');
  const expected = profile === 'vlc_windows_x64' ? 'get.videolan.org' : 'github.com';
  assert.equal(c.address.host, expected);
  const el =
    profile === 'vlc_windows_x64'
      ? await page.$('#downloadButton2')
      : await page.evaluateHandle(() => {
          for (const tr of document.querySelectorAll('tr')) {
            if (
              tr.cells[1]?.innerText.trim() === '.exe' &&
              tr.cells[2]?.innerText.trim() === '64-bit Windows x64'
            )
              return tr.cells[0].querySelector('a');
          }
        });
  const actual = await el.evaluate((e) => ({
    host: new URL(e.href).hostname,
    path: new URL(e.href).pathname,
  }));
  assert.equal(actual.host, expected);
  assert(
    profile === 'vlc_windows_x64'
      ? /^\/vlc\/([\d.]+)\/win64\/vlc-\1-win64\.exe$/.test(actual.path)
      : /^\/ip7z\/7zip\/releases\/download\/[\d.]+\/7z\d+-x64\.exe$/.test(actual.path),
  );
  await until(() => aligned(page, el), 'single publisher outline');
  await state(panel, 'Ready for your review');
  const bounds = (await s.root.send('Browser.getWindowBounds', { windowId: s.windowId })).bounds;
  await s.root.send('Browser.setWindowBounds', {
    windowId: s.windowId,
    bounds: { width: bounds.width - 55, height: bounds.height - 25 },
  });
  await page.waitForFunction((w) => innerWidth < w, { timeout: 6000 }, r.dimensions.page.width);
  await until(() => aligned(page, el), 'publisher outline aligned after Chrome resize');
  r.resizedPage = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(r.resizedPage.width < r.dimensions.page.width);
  await s.root.send('Browser.setWindowBounds', {
    windowId: s.windowId,
    bounds: { width: bounds.width, height: bounds.height },
  });
  await sleep(120);
  await btn(panel, 'Why this button?').click();
  await state(panel, 'AI explanation unavailable');
  await panel.$eval('article.review h2',e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  await Promise.all([
    panel.screenshot({ path: join(out, profile + '-' + r.width + '-panel.png') }),
    page.screenshot({ path: join(out, profile + '-' + r.width + '-page.png') }),
  ]);
  r.officialDestination = actual;
  r.checks.push(
    'D01/D02/D10/D11 exact package, row or version, publisher, native highlight and user owns final click',
    'A01 local website and download features work while unpaired',
  );
}
async function repairEdges(s,r) {
  const {page,panel}=s;
  const baseline=process.env.SAFESTEP_S3_ORIGINAL==='1';
  for(const mode of ['deep','unusable']){
    await page.goto(lab.origin+'/download-lab?product=vlc',{waitUntil:'load'});
    await page.click('#'+mode);
    if(mode==='unusable') for(let i=0;i<4;i++){
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.id==='downloadButton2'),false);
    }
    const facts=await page.$$eval('#downloadButton2', els=>els.map(e=>{
      const b=e.getBoundingClientRect(); return {visible:b.top>=0&&b.bottom<=innerHeight,
        buttonHit:e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),
        disabled:e.getAttribute('aria-disabled'),tabIndex:e.tabIndex,host:new URL(e.href).hostname};
    }));
    assert.equal(facts.length,mode==='deep'?2:1);
    assert(facts.every(e=>e.visible));
    if(mode==='unusable') assert(!facts[0].buttonHit&&facts[0].disabled==='true'&&facts[0].tabIndex===-1);
    const d=await file(s,'vlc_windows_x64');
    const outlines=(await page.$$('[data-safestep-outline]')).length;
    r.checks.push({mode,facts,state:d.fileState,limited:d.limited,outlines});
    assert.equal(d.fileState==='identified',baseline);
    assert.equal(outlines,baseline?1:0);
    assert.equal(await page.$eval('#count',e=>e.textContent),'0');
  }
  if(!baseline){
    await page.goto(lab.origin+'/download-lab?product=vlc',{waitUntil:'load'});
    assert.equal((await file(s,'vlc_windows_x64')).fileState,'identified');
    await page.click('#unusable');
    await until(async()=>!(await review(panel))&&!(await page.$('[data-safestep-outline]')),'disabled after selection cleared');
    assert.equal((await file(s,'vlc_windows_x64')).fileState,'missing');
    r.checks.push('newly disabled active target invalidated, recheck refused');
  }
}
async function labs(s, r) {
  const { page, panel } = s;
  let d = await clickCheck(s);
  assert.equal(d.status, 'limited_information');
  assert(d.frames);
  assert(d.observations.some((o) => o.code === 'http'));
  assert(!d.observations.some((o) => o.code === 'urgent_dialog'));
  assert(!JSON.stringify(d).includes('PRIVATE_STAGE3'));
  await page.click('#warning');
  await until(async () => !(await review(panel)), 'old site result invalidated');
  d = await clickCheck(s);
  assert.equal(d.status, 'warning_signs');
  for (const code of ['label_mismatch', 'urgent_dialog', 'self_claim'])
    assert(
      d.observations.some((o) => o.code === code),
      code,
    );
  await page.click('#large');
  await until(async () => !(await review(panel)), 'changed page invalidated');
  d = await clickCheck(s);
  assert(d.limited);
  assert(d.observations.length <= 16);
  for (const variant of ['match', 'clear', 'zero', 'stale', 'wrong', 'no-coverage']) {
    await page.goto(lab.origin + '/trust-lab?source=' + variant, { waitUntil: 'load' });
    await sleep(90);
    d = await clickCheck(s);
    assert(d.fixture);
    assert(d.sources.every((x) => x.source === 'labelled_fixture'));
    if (variant === 'match') assert.equal(d.status, 'reported_threat');
    if (variant === 'stale') assert(d.sources.every((x) => x.state === 'stale'));
    if (variant === 'zero') assert.equal(d.sources[0].state, 'zero_reviews');
  }
  r.checks.push(
    'S02–S06/S09 neutral, fake dialog, educational text, HTTP, own review claim, truncation, private markers, separated synthetic source states',
  );
  const info = await panel.waitForSelector('article.review summary');
  await info.focus();
  await panel.keyboard.press('Enter');
  assert(await info.evaluate((e) => e.parentElement.open));
  const dismiss = await panel.waitForSelector('::-p-aria(Dismiss check[role="button"])');
  await dismiss.focus();
  await panel.keyboard.press('Enter');
  await until(async () => !(await review(panel)), 'dismissal');
  assert(await panel.evaluate(() => document.activeElement.textContent === 'Check this website'));
  await panel.keyboard.press('Enter');
  await state(panel, 'Website summary');
  r.checks.push('S08 keyboard dismiss/revisit and source details');
  for (const [key, profile] of [
    ['vlc', 'vlc_windows_x64'],
    ['7zip', 'seven_zip_windows_x64_exe'],
  ]) {
    const url = lab.origin + '/download-lab?product=' + key;
    await page.goto(url, { waitUntil: 'load' });
    await sleep(90);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.click('#off');
    const f = await file(s, profile);
    assert(f.fixture);
    assert.equal(f.fileState, 'identified');
    assert.equal(f.placement, 'below');
    assert(f.candidates.some((c) => c.reason === 'sponsored'));
    assert(f.candidates.some((c) => c.relation === 'unknown'));
    await btn(panel, 'Show me').click();
    await until(async () => (await review(panel))?.placement === 'visible', 'revealed target');
    assert.equal(await page.$eval('#count', (e) => e.textContent), '0');
    await page.evaluate(() => document.querySelector('#replace').click());
    await until(async () => !(await review(panel)), 'replaced target invalidated');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await file(s, profile);
    await page.evaluate(() => document.querySelector('#wrong').click());
    await until(async () => !(await review(panel)), 'changed href invalidated');
    assert.equal((await file(s, profile)).fileState, 'missing');
    await page.goto(url, { waitUntil: 'load' });
    await page.click('#duplicate');
    assert.equal((await file(s, profile)).fileState, 'ambiguous');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await page.goto(url, { waitUntil: 'load' });
    await page.click('#remove');
    assert.equal((await file(s, profile)).fileState, 'missing');
  }
  r.checks.push(
    'D03–D09 both product fixtures: sponsored/other/unknown, old release, wrong owner/path, duplicate, removal, fresh reveal with zero activations',
  );
  const sel = await panel.$$('section[aria-label="Website and download checks"] details select');
  await sel[1].select('mac');
  await btn(panel, 'Identify button').click();
  await state(panel, 'supports Windows x64');
  assert.equal(await page.$('[data-safestep-outline]'), null);
}
async function pairing(s, r) {
  const { page, panel } = s;
  const token = newPairToken();
  const origins = new Set();
  const bodies = [];
  panel.on('request', (req) => {
    if (req.url() === 'http://127.0.0.1:4317/v1/explain') bodies.push(req.postData() ?? '');
  });
  let calls = 0,
    headersOK = true;
  const api = makeApi(undefined, new GeminiService({}, token));
  api.prependListener('request', (req) => {
    if (req.url?.startsWith('/v1/explain')) {
      origins.add(req.headers.origin ?? 'omitted');
      headersOK &&= req.headers.authorization === 'Bearer ' + token && !req.headers.cookie;
      if (req.url === '/v1/explain') calls++;
    }
  });
  await new Promise((ok, no) => {
    api.once('error', no);
    api.listen(4317, '127.0.0.1', ok);
  });
  try {
    await page.goto(lab.origin + '/trust-lab?marker=PRIVATE_STAGE3_QUERY', { waitUntil: 'load' });
    await page.evaluate(() => {
      document.cookie = 'fixture=PRIVATE_STAGE3_COOKIE; SameSite=Strict';
    });
    await openArea(panel, 'Settings'); await openDetails(panel, 'Connect local AI');
    await panel.type('input[type=password]', token);
    await btn(panel, 'Connect').click();
    await state(panel, 'Connected. Gemini is unavailable');
    const d = await clickCheck(s);
    await btn(panel, 'Explain this check').click();
    await state(panel, 'not configured');
    assert.equal((await review(panel)).binding.operationId, d.binding.operationId);
    assert.equal(calls, 1);
    assert(headersOK);
    assert(origins.has('chrome-extension://' + s.id));
    assert.equal(bodies.length, 1);
    assert(ExplanationInput.safeParse(JSON.parse(bodies[0])).success);
    assert(
      !bodies[0].includes('PRIVATE_STAGE3') &&
        !bodies[0].includes(token) &&
        !bodies[0].includes('localhost'),
    );
    r.checks.push(
      'A01/A06 native Chrome paired to exact extension Origin, authenticated POST, zero model calls, explicit not configured',
    );
    api.closeAllConnections();
    await new Promise((ok) => api.close(ok));
    await btn(panel, 'Explain this check').click();
    await state(panel, 'local check is still available');
    assert((await review(panel)).binding.operationId === d.binding.operationId);
    await openArea(panel,'Settings'); await btn(panel, 'Disconnect').click();
    await state(panel, 'Disconnected');
    assert(
      !JSON.stringify(await panel.evaluate(() => chrome.storage.session.get(null))).includes(token),
    );
    r.checks.push('A05 stopped service preserved findings; disconnect removed session token');
  } finally {
    api.closeAllConnections();
    if (api.listening) await new Promise((ok) => api.close(ok));
  }
}
async function idle(s, r) {
  const { page, panel } = s;
  const f = await file(s, 'vlc_windows_x64');
  assert.equal(f.fileState, 'identified');
  const start = Date.now();
  await sleep(97000);
  r.idleMs = Date.now() - start;
  assert.equal(
    (
      await s.root.send('Target.getTargets', { filter: [{ type: 'service_worker' }] })
    ).targetInfos.filter((t) => t.url.startsWith('chrome-extension://' + s.id + '/')).length,
    0,
  );
  assert(await aligned(page, await page.$('#downloadButton2')));
  await state(panel, 'Button identified');
  const after = (await view(panel)).v;
  assert(!after.review);
  assert(after.reviewStale);
  await until(async () => !(await page.$('[data-safestep-outline]')), 'recovered cue cleared');
  assert.equal(await page.$eval('#count', (e) => e.textContent), '0');
  r.checks.push(
    'R03 cue aligned through worker sleep; wake retired old operation, explicit recheck needed; zero activation or AI replay',
  );
}
async function lateAI(s, r) {
  const { panel, page } = s,
    token = newPairToken();
  let release, signal;
  const fixture = new GeminiService(
    { GEMINI_API_KEY: 'NONLIVE_TEST', GEMINI_MODEL: 'gemini-test' },
    token,
    async (input, abort) => {
      signal = abort;
      await new Promise((ok) => {
        release = ok;
      });
      const choices = explanationChoices(input);
      return {
        text: JSON.stringify({
          summary: choices.summary,
          reasons: [choices.reasons[0]],
          nextStep: choices.nextStep,
          coverageLimits: [choices.limits[0]],
        }),
        tokens: null,
      };
    },
  );
  const api = makeApi(undefined, fixture);
  await new Promise((ok, no) => {
    api.once('error', no);
    api.listen(4317, '127.0.0.1', ok);
  });
  try {
    await openArea(panel, 'Settings'); await openDetails(panel, 'Connect local AI');
    await panel.type('input[type=password]', token);
    await btn(panel, 'Connect').click();
    await state(panel, 'Connected to Gemini');
    for (const action of ['cancel', 'navigate']) {
      release = undefined;
      await clickCheck(s);
      await btn(panel, 'Explain this check').click();
      await until(() => !!release, 'pending fixture explanation');
      if (action === 'cancel') await btn(panel, 'Cancel explanation').click();
      else await page.goto(lab.origin + '/trust-lab?source=zero', { waitUntil: 'load' });
      await until(() => signal?.aborted, 'upstream cancellation');
      release();
      await sleep(100);
      assert.equal(await panel.$('::-p-text(Gemini explanation)'), null);
      assert.equal(await panel.$('::-p-text(Waiting for Gemini…)'), null);
      if (action === 'navigate') assert(!(await review(panel)));
    }
    r.checks.push(
      'A05 labelled delayed connector aborted on user cancel and document navigation; no late explanation or stuck spinner',
    );
  } finally {
    release?.();
    api.closeAllConnections();
    await new Promise((ok) => api.close(ok));
  }
}
async function isolation(s, r) {
  const { page, panel } = s;
  await clickCheck(s);
  const w = await (
    await s.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(s.id))
  ).worker();
  await w.evaluate(() => {
    const orig = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      if (args[1]?.channel === 'review-page' && args[1]?.command.kind === 'read') {
        chrome.tabs.sendMessage = orig;
        const result = await orig(...args);
        await new Promise((res) => (globalThis.releaseReview = res));
        return result;
      }
      return orig(...args);
    };
  });
  await btn(panel, 'Check this website').click();
  await until(
    () => w.evaluate(() => typeof globalThis.releaseReview === 'function'),
    'held review reply',
  );
  const second = await s.browser.newPage();
  await second.goto('about:blank');
  await second.bringToFront();
  await until(async () => !(await view(panel)).v.review, 'other tab empty');
  await w.evaluate(() => globalThis.releaseReview());
  await page.bringToFront();
  await sleep(150);
  assert(!(await view(panel)).v.review);
  await second.close();
  await clickCheck(s);
  await page.goto(lab.origin + '/trust-lab?warning', { waitUntil: 'load' });
  await until(async () => !(await review(panel)), 'navigation cleared old findings');
  r.checks.push('S07 late review after tab switch and previous document rejected');
  // Start the real supported citation guide, then run a website check alongside it.
  await page.goto('https://en.wikipedia.org/wiki/Phishing', { waitUntil: 'domcontentloaded' });
  await s.activate(page);
  await openArea(panel,'Guide'); await panel.focus('#goal');
  await panel.keyboard.type('Find an APA citation');
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() =>
    document.querySelector('[data-testid=instruction]')?.textContent.includes('Open Tools'),
  );
  const before = (await view(panel)).v.task;
  await clickCheck(s);
  assert.equal((await view(panel)).v.task.id, before.id);
  assert(await page.$('[data-safestep-outline]'));
  const download = await openDetails(panel, 'Download help');
  const sel = await download.$$('select');
  await sel[0].select('vlc_windows_x64');
  await sel[1].select('x64');
  await btn(panel, 'Identify button').click();
  await state(panel, 'Pause the current task');
  assert.equal((await view(panel)).v.task.id, before.id);
  await openArea(panel,'Guide');await btn(panel, 'Cancel task').click();
  await until(async () => !(await review(panel)), 'cancel cleared website operation');
  assert.equal(await page.$('[data-safestep-outline]'), null);
  r.checks.push('D12 website check kept active goal/cue; explicit cancel cleared both');
}
try {
  for (const [w, h] of [
    [1440, 900],
    [1366, 768],
  ]) {
    if (process.env.SAFESTEP_WIDTH && Number(process.env.SAFESTEP_WIDTH) !== w) continue;
    if (chosen.includes('live')) {
      for (const [profile, url] of livePages)
        if (!process.env.SAFESTEP_S3_PROFILE || process.env.SAFESTEP_S3_PROFILE === profile)
          await run(profile, w, h, url, (s, r) => live(s, r, profile));
      if (!process.env.SAFESTEP_S3_PROFILE)
        await run('neutral ordinary page', w, h, 'https://example.org/', async (s, r) => {
          const d = await clickCheck(s);
          assert.equal(d.address.host, 'example.org');
          assert.equal(d.status, 'limited_information');
          assert(d.sources.every((x) => x.state === 'unavailable'));
          r.checks.push(
            'S01/S02/S04 HTTPS ordinary page, no-service coverage, no fraud or safety verdict',
          );
        });
    }
    if (chosen.includes('additional')) {
      await run(
        'labelled IDN website',
        w,
        h,
        'https://xn--bcher-kva.test/',
        async (s, r) => {
          const d = await clickCheck(s);
          assert(d.address.flags.includes('international'));
          assert.equal(d.status, 'limited_information');
          assert.equal(d.address.domain, null);
          r.checks.push(
            'S04 neutral IDN, unrecognized hostname, external link and polished HTTPS page remain limited',
          );
        },
        false,
        true,
      );
      await run(
        'stale reveal and chronological releases',
        w,
        h,
        lab.origin + '/download-lab?product=7zip',
        async (s, r) => {
          const d = await file(s, 'seven_zip_windows_x64_exe'),
            before = await view(s.panel);
          assert(d.selected);
          await s.page.evaluate(() => document.querySelector('#wrong').click());
          const stale = await s.panel.evaluate((m) => chrome.runtime.sendMessage(m), {
            channel: 'panel',
            v: 2,
            requestId: crypto.randomUUID(),
            tabId: d.binding.tabId,
            windowId: before.windowId,
            epoch: before.v.epoch,
            documentId: before.v.snapshot?.context.documentId ?? null,
            revision: before.v.snapshot?.context.revision ?? null,
            command: { kind: 'reviewReveal', operationId: d.binding.operationId },
          });
          assert.equal(stale.ok, false);
          assert.equal(await s.page.$eval('#count', (e) => e.textContent), '0');
          await s.page.goto(lab.origin + '/download-lab?product=7zip', { waitUntil: 'load' });
          await s.page.evaluate(() => {
            const main = document.querySelector('main');
            const [oldHeader, oldTable] = [...main.children].slice(-2);
            main.querySelector('h1').after(oldHeader, oldTable);
          });
          assert.equal((await file(s, 'seven_zip_windows_x64_exe')).fileState, 'ambiguous');
          r.checks.push(
            'D06/D07 old table moved ahead of current release refused; stale reveal after changed href rejected, no activation',
          );
          await s.page.goto(lab.origin + '/download-lab?product=7zip', { waitUntil: 'load' });
          assert((await file(s, 'seven_zip_windows_x64_exe')).selected);
          await s.page.evaluate(() => document.querySelector('[data-safestep-outline]').remove());
          await until(async () => !(await review(s.panel)), 'page removed cue invalidated review');
          r.checks.push('R03 removal of the painted outline cleared the reported recommendation');
            const packageSelect=(await s.panel.$$('section[aria-label="Website and download checks"] details select'))[1];
            await packageSelect.select('');await btn(s.panel,'Identify button').click();
            await state(s.panel,'Choose the product and the Windows package');assert.equal(await s.page.$('[data-safestep-outline]'),null);
            r.checks.push('D04 unspecified architecture required an explicit package choice');
            await openArea(s.panel,'Settings');const features = await openDetails(s.panel, 'Product features');
            const rows=await features.$$eval('ol > li',els=>els.map(e=>e.innerText));
            assert.equal(rows.length,9);
            if(await s.panel.$('[role=tablist]')){
              assert.equal(rows.filter(t=>t.endsWith('Guide')).length,3);assert.equal(rows.filter(t=>t.endsWith('Shopping')).length,3);assert.equal(rows.filter(t=>t.endsWith('Safety checks')).length,3);
              r.checks.push('R04 all nine features have a user-facing area in the current release.');return;
            }
            assert.equal(rows.filter(t=>t.includes('Available in Stage 2')).length,2);
            assert.equal(rows.filter(t=>t.includes('Available in Stage 3')).length,2);
            const shoppingBuilt=await s.panel.evaluate(()=>Number(chrome.runtime.getManifest().version.split('.')[1])>=4);
            assert.equal(rows.filter(t=>t.includes('Available in Stage 4')).length,shoppingBuilt?2:0);
            const assistBuilt=await s.panel.evaluate(()=>Number(chrome.runtime.getManifest().version.split('.')[1])>=5);
            assert.equal(rows.filter(t=>t.includes('Available in Stage 5')).length,assistBuilt?2:0);
            const compareBuilt=await s.panel.evaluate(()=>Number(chrome.runtime.getManifest().version.split('.')[1])>=6);
            assert.equal(rows.filter(t=>t.includes('Available in Stage 6')).length,compareBuilt?1:0);
            assert.equal(rows.filter(t=>t.includes('Planned')).length,compareBuilt?0:assistBuilt?1:shoppingBuilt?3:5);
            r.checks.push('R04 nine displayed features and stage-specific availability agree with the loaded manifest');
        },
      );
    }
    if (chosen.includes('repairs')) await run('SS3-01 and SS3-02', w,h,lab.origin+'/download-lab?product=vlc',repairEdges);
    if (chosen.includes('labs')) await run('labelled labs', w, h, lab.origin + '/trust-lab', labs);
  }
  const sizes = [[1440, 900], [1366, 768]];
  if (process.env.SAFESTEP_WIDTH) assert(sizes.some(([w]) => w === Number(process.env.SAFESTEP_WIDTH)), 'unknown Stage 3 desktop size');
  const sizesFor = (historicalWidth) => sizes.filter(([w]) => w === Number(process.env.SAFESTEP_WIDTH ?? historicalWidth));
  if (chosen.includes('pair'))
    for (const [w, h] of sizesFor(1366)) {
      await run('local AI pairing', w, h, lab.origin + '/trust-lab', pairing);
      await run('delayed fixture AI', w, h, lab.origin + '/trust-lab', lateAI);
    }
  if (chosen.includes('isolation'))
    for (const [w, h] of sizesFor(1440)) {
      await run('operation isolation', w, h, lab.origin + '/trust-lab', isolation, true);
    }
  if (chosen.includes('idle'))
    for (const [w, h] of sizesFor(1366)) {
      await run('idle download cue', w, h, lab.origin + '/download-lab?product=vlc', idle);
    }
} finally {
  lab.server.close();
}
await writeFile(
  join(out, 'run-' + chosen.join('-') + '-' + (process.env.SAFESTEP_WIDTH ?? 'both') + '.json'),
  JSON.stringify(
    { role: 'builder', sha256, bundle, at: new Date().toISOString(), results },
    null,
    2,
  ) + '\n',
);
if (!results.length || results.some((r) => r.status !== 'pass')) process.exitCode = 1;
await writeProgress('completed');
