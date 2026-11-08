import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { openArea, guidedMode } from './support/stage7-panel.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import { scenarios } from './support/stage5-controls.mjs';
import { providerOperation, sentProviderMenu, providerProposal, quotaDetails, providerBlockReason } from './support/stage5-provider-trace.mjs';
const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle),
  out = resolve('.test-artifacts/stage5', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const lab = await startFixture(0),
  base = lab.origin,
  runAt = new Date().toISOString(),
  results = [];
const groups = (
  process.env.SAFESTEP_S5_CASES ?? 'settings,cleanup,fixture,public,edges,controls'
).split(',');
const live = process.env.SAFESTEP_S5_LIVE === '1';
const trial = process.env.SAFESTEP_S5_TRIAL ?? '';
if (trial && !/^[a-z0-9-]{1,40}$/.test(trial)) throw Error('Invalid verification trial name.');
const trialSuffix = trial ? '-' + trial : '';
if (live && groups.some((g) => !['public', 'intent'].includes(g)))
  throw Error('Choose only public or intent for real-provider verification.');
let liveService,
  lastReal = 0;
let fallbackUnavailable = false;
const providerTasks = new WeakMap();
const modelLabel = /^gemini-[a-z0-9.-]{1,64}$/.test(process.env.GEMINI_MODEL ?? '') ? process.env.GEMINI_MODEL : 'unknown-model';
const pacificDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', dateStyle: 'short' }).format(new Date());
const quotaDirectory = join(out, 'provider-quota');
const dailyRecord = join(quotaDirectory, modelLabel + '-' + pacificDay.replaceAll('/', '-') + '.json');
let dailyExhausted = live && existsSync(dailyRecord);
if (live) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
    const operation = providerOperation.getStore();
    if (!operation || url.hostname !== 'generativelanguage.googleapis.com')
      return realFetch(...args);
    let menu = null;
    if (operation.kind === 'step') {
      const raw = args[1]?.body ?? (args[0] instanceof Request ? await args[0].clone().text() : '');
      menu = sentProviderMenu(raw);
    }
    const res = await realFetch(...args);
    const b = await res
      .clone()
      .json()
      .catch(() => ({}));
    operation.upstream = {
      http: res.status,
      finish: b.candidates?.[0]?.finishReason ?? null,
      code: /^[A-Z_]{1,64}$/.test(b.error?.status ?? '') ? b.error.status : null,
      ...(res.status === 429 ? { quota: quotaDetails(b.error) } : {}),
      diagnostic: res.ok || res.status === 429
        ? null
        : String(b.error?.message ?? '')
            .replaceAll(process.env.GEMINI_API_KEY ?? '[unused]', '[redacted]')
            .replace(/https?:\/\/[^\s]+|[A-Za-z0-9_=-]{30,}/g, '[redacted]')
            .slice(0, 260),
    };
    if (res.status === 429 && operation.upstream.quota?.violations.some((item) => item.window === 'day')) {
      dailyExhausted = true;
      await mkdir(quotaDirectory, { recursive: true });
      await writeFile(dailyRecord, JSON.stringify({
        at: new Date().toISOString(), model: modelLabel, http: 429, quota: operation.upstream.quota,
      }, null, 2) + '\n');
    }
    if (res.status === 503 && process.env.GEMINI_MODEL === 'gemini-3.5-flash-lite')
      fallbackUnavailable = true;
    if (operation.kind === 'step') {
      try {
        const parts = b.candidates[0].content.parts.filter((p) => !p.thought);
        const v = JSON.parse(parts.map((p) => p.text ?? '').join(''));
        operation.upstream.proposal = providerProposal(v, menu);
      } catch {}
    }
    return res;
  };
}
const btn = (p, name) => p.locator('::-p-aria(' + name + '[role="button"])').setTimeout(7500);
async function until(fn, what, ms = 14000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const x = await fn();
    if (x) return x;
    await sleep(55);
  }
  throw Error('Timed out: ' + what);
}
const task = async (p) => (await view(p)).v.task;
async function focusJourneyWindow(s) {
  await s.page.bringToFront();
  await s.panel.evaluate(async () => {
    const w = await chrome.windows.getCurrent();
    if (!w.focused) await chrome.windows.update(w.id, { focused: true });
  });
  await until(
    () => s.panel.evaluate(async () => (await chrome.windows.getCurrent()).focused),
    'active test window',
  );
}
async function goal(s, text) {
  await openArea(s.panel,'Guide');
  await focusJourneyWindow(s);
  const old = (await task(s.panel))?.id;
  await s.panel.$eval('#goal', (e) => e.select());
  await s.panel.keyboard.type(text);
  await s.panel.keyboard.press('Enter');
  return until(async () => {
    const t = await task(s.panel);
    return t?.adaptive && t.id !== old && t.state !== 'planning' && t;
  }, 'understood goal');
}
async function run(name, w, h, start, fn) {
  const r = { name, width: w, height: h, status: 'fail', checks: [], downloads: 0, attempts: 0 };
  let s;
  try {
    trace = [];
    if (live && (dailyExhausted || fallbackUnavailable)) {
      r.status = 'blocked';
      r.checks.push(dailyExhausted
        ? 'A Gemini daily quota violation was recorded. This case made no new provider request.'
        : 'Fallback returned upstream HTTP 503; no retry for this case.');
      if (dailyExhausted) r.quotaEvidence = dailyRecord;
      return;
    }
    behavior = 'normal';
    await freshService();
    const open = () =>
      nativeSession(bundle, w, h, start, {
        attachWorker: name.startsWith('controls-'),
        prepare: async (p) => {
          await p.setRequestInterception(true);
          p.on('request', (q) => {
            const u = new URL(q.url());
            if (
              q.isNavigationRequest() &&
              /\.(?:exe|msi|zip|pdf|whl)$|\/(?:checkout|payment|delete|logout)(?:\/|$)/.test(
                u.pathname,
              )
            ) {
              r.attempts++;
              void q.abort();
            } else void q.continue();
          });
        },
      });
    try {
      s = await open();
    } catch (e) {
      if (
        !start.startsWith('https://') ||
        !/net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_RESET)|Navigation timeout of 30000 ms exceeded/.test(
          e.message,
        )
      )
        throw e;
      r.initialPageFailure = e.message.slice(0, 200);
      await sleep(1600);
      s = await open();
    }
    if (start.startsWith('https://')) {
      await s.page
        .waitForFunction(() => document.readyState === 'complete', { timeout: 10000 })
        .catch(() => {});
      await sleep(450);
    }
    r.environment = s.dimensions;
    r.chrome = await s.browser.version();
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    await fn(s, r);
    assert.equal(r.downloads, 0);
    assert.equal(r.attempts, 0);
    r.status = 'pass';
  } catch (e) {
    r.error = e.message.slice(0, 280);
    if (s) {
      const t = await task(s.panel).catch(() => null);
      r.diagnostic = {
        state: t?.state,
        message: t?.adaptive?.status,
        path: new URL(s.page.url()).pathname,
        alert: await s.panel.$$eval('[role=alert]', (els) => els.map((e) => e.textContent)),
        journal: t?.adaptive?.journal?.state,
        trace: trace.slice(-3),
        publicMarkup: s.page.url().startsWith('https://developer.mozilla.org')
          ? await s.page.evaluate(() => ({
              title: document.title,
              roots: [...document.querySelectorAll('main,article,nav,aside')]
                .slice(0, 15)
                .map((e) => [e.tagName, e.id, e.className]),
              map: [...document.querySelectorAll('a[href*="Array/map"],a[href*="Array/filter"]')]
                .slice(0, 6)
                .map((a) => [
                  a.innerText.slice(0, 55),
                  a.closest('main,article,aside,nav')?.tagName,
                  a.closest('article')?.className,
                  a.checkVisibility(),
                ]),
            }))
          : null,
      };
      const last = trace.at(-1);
      if (live && !r.downloads && !r.attempts && t?.state === 'paused' &&
          last && providerTasks.get(last) === t.id) {
        const reason = providerBlockReason(last, t.adaptive?.status);
        if (reason) {
          r.status = 'blocked';
          r.checks.push(reason);
        }
      }
    }
  } finally {
    if (live) {
      r.realOperations = trace.slice();
      r.health = liveService?.assistHealth();
      if (trace.length) lastReal = Date.now();
    }
    if (s) await s.browser.close();
    results.push(r);
    console.log(r.status, name, w, r.error ?? '', JSON.stringify(r.diagnostic ?? {}));
  }
}
const rawIntent = (g) => {
  const neg = /\b(?:not|without)\s+(.+)$/i.exec(g),
    pos = (neg ? g.slice(0, neg.index) : g).trim().replace(/[, .]+$/, ''),
    ex = neg?.[1].replace(/[.!?]$/, '');
  const span = (t) => ({ text: t, start: g.indexOf(t), end: g.indexOf(t) + t.length });
  return {
    action: /change my name/i.test(g)
      ? 'clarify'
      : /purchase|download firefox/i.test(g)
        ? 'unsupported'
        : 'find_section',
    subjects: [span(pos)],
    constraints: [],
    excluded: ex ? [span(ex)] : [],
    question: /change my name/i.test(g)
      ? 'Which name do you want to find?'
      : /purchase|download firefox/i.test(g)
        ? 'This site does not support the requested action.'
        : '',
    choices: [],
  };
};
let behavior = 'normal',
  trace = [];
function model(i) {
  assert(
    !/PRIVATE_ACCOUNT_LABEL|PRIVATE_DO_NOT_SHARE|PRIVATE_ACCOUNT_FIELD|SHOULD_NOT_LEAVE|PRIVATE_CLEAN_FIELD|ss3_|ignore all previous instructions|javascript:|https:\/\/untrusted\.test/i.test(
      JSON.stringify(i),
    ),
    'Only sanitized public inputs reach the mock',
  );
  trace.push({
    operation: i.kind,
    profile: i.profile,
    controls: i.snapshot?.controls.length,
    headings: i.snapshot?.headings.length,
    methodOptions: i.snapshot?.controls
      .filter((f) => f.path?.includes('/Array/map') || f.path?.includes('/Array/filter'))
      .map((f) => [f.label, f.path]),
    headingLabels: i.snapshot?.headings.map((h) => h.label),
  });
  if (i.kind === 'intent') return rawIntent(i.goal);
  const s = i.snapshot,
    positive = i.goal.split(/\b(?:not|without)\b/i)[0].toLowerCase(),
    refs = [...s.headings, ...s.controls];
  const desired = positive.includes('exception')
    ? 'Handling Exceptions'
    : positive.includes('virtual')
      ? 'Creating Virtual Environments'
      : 'Examples';
  const correctDoc =
    i.profile === 'mdn'
      ? s.path.includes('/' + (positive.includes('filter') ? 'filter' : 'map'))
      : i.profile === 'python'
        ? s.path.includes(positive.includes('exception') ? 'errors.html' : 'venv.html')
        : s.path.includes('/method');
  const unique = (f) => {
    const matches = refs.filter(f);
    return matches.find(
      (x) =>
        matches.filter((y) => x.label === y.label && x.action === y.action && x.path === y.path)
          .length === 1,
    );
  };
  let candidate = correctDoc
    ? unique((x) => x.role === 'heading' && x.label.toLowerCase().includes(desired.toLowerCase()))
    : undefined;
  if (!candidate && i.profile === 'mdn') {
    const part = positive.includes('filter') ? 'filter' : 'map';
    candidate = unique(
      (x) => x.role === 'link' && x.path?.split('#')[0].endsWith('/Array/' + part),
    );
  }
  if (!candidate && i.profile === 'python') {
    const chapter = positive.includes('exception') ? 'errors.html' : 'venv.html';
    candidate =
      unique(
        (x) =>
          x.role === 'link' &&
          x.path?.includes(chapter + '#' + desired.toLowerCase().replaceAll(' ', '-')),
      ) ??
      unique((x) => x.role === 'link' && x.path?.includes(chapter)) ??
      unique((x) => x.role === 'link' && x.path?.includes('/tutorial/index.html'));
  }
  if (!candidate && i.profile === 'practice')
    candidate = unique((x) => x.role === 'link' && x.label === 'Practice method');
  if (behavior === 'bad_ref')
    return {
      kind: 'next_candidate',
      ref: crypto.randomUUID(),
      action: 'activate_readonly_link',
      citations: [crypto.randomUUID()],
    };
  if (behavior === 'done') return { kind: 'completion_candidate', citations: [refs[0].ref] };
  if (!candidate)
    return {
      kind: 'need_more_controls',
      terms: [
        correctDoc
          ? desired
          : i.profile === 'practice'
            ? 'Practice method'
            : i.profile === 'mdn'
              ? positive.includes('filter')
                ? 'filter'
                : 'map'
              : s.path.includes('/tutorial/')
                ? positive.includes('exception')
                  ? 'Exceptions'
                  : 'Virtual Environments'
                : 'tutorial',
      ],
    };
  return {
    kind: 'next_candidate',
    ref: candidate.ref,
    action: candidate.action,
    citations: [candidate.ref],
  };
}
let api, token;
async function freshService() {
  if (live) {
    if (api) {
      const remaining = 61000 - (Date.now() - lastReal);
      if (remaining > 0) await sleep(remaining);
      return;
    }
    token = newPairToken();
    class ObservedService extends GeminiService {
      async assist(input, signal) {
        const operation = { kind: input.kind, upstream: null };
        const runTrace = trace;
        const at = new Date().toISOString(),
          r = await providerOperation.run(operation, () => super.assist(input, signal));
        const { upstream } = operation;
        const chosen =
          input.kind === 'step' && r.explanation?.kind === 'next_candidate'
            ? [...input.snapshot.controls, ...input.snapshot.headings].find(
                (f) => f.ref === r.explanation.ref,
              )
            : null;
        const observed = {
          at,
          operation: input.kind,
          profile: input.profile,
          page: input.snapshot?.path,
          controls: input.snapshot?.controls.length,
          ...(input.kind === 'step' && input.profile === 'python' ? {
            partial: input.snapshot.limited,
            exceptionControls: input.snapshot.controls
              .filter((control) => /exceptions?/i.test(control.label))
              .map(({ label, path }) => ({ label, path })),
          } : {}),
          elapsedMs: r.elapsedMs,
          upstream,
          tokens: r.tokens,
          status: r.status,
          reply: r.explanation?.kind ?? r.explanation?.action ?? null,
          ...(upstream?.proposal?.reason === 'missing_target' &&
          r.explanation?.kind === 'need_more_controls'
            ? { serviceRequestedLookupAfterModelMiss: r.explanation.terms }
            : {}),
          selected: chosen
            ? { label: chosen.label, action: chosen.action, path: chosen.path }
            : null,
        };
        providerTasks.set(observed, input.binding.taskId);
        runTrace.push(observed);
        return r;
      }
    }
    liveService = new ObservedService(process.env, token);
    if (!liveService.assistHealth().configured)
      throw Error('Server environment is not configured for a real run.');
    api = makeApi(undefined, liveService);
    api.listen(4317, '127.0.0.1');
    await once(api, 'listening');
    return;
  }
  if (api) {
    api.closeAllConnections();
    await new Promise((ok) => api.close(ok));
  }
  token = newPairToken();
  const service = new GeminiService(
    { GEMINI_API_KEY: 'test-only-fixture', GEMINI_MODEL: 'gemini-fixture-only' },
    token,
    async () => ({ text: '', tokens: null }),
    8000,
    undefined,
    async (i) => {
      if (behavior === 'delay') await sleep(850);
      return { text: JSON.stringify(model(i)), tokens: 12 };
    },
  );
  api = makeApi(undefined, service);
  const host=process.env.SAFESTEP_TEST_API_HOST??'127.0.0.1';
  assert(/^127\.0\.0\.[1-9]$/.test(host));
  api.listen(4317, host);
  await once(api, 'listening');
}
async function pair(s) {
  await openArea(s.panel,'Settings');
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  await s.panel.type('input[type=password]', token);
  await btn(s.panel, 'Connect').click();
  await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'));
  await openArea(s.panel,'Guide');
}
async function findTarget(page) {
  return page.evaluateHandle(() => {
    const border = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
    if (!border) return null;
    return (
      [
        ...document.querySelectorAll(
          'main a,main button,main h1,main h2,main h3,article a,nav a,.document a,.document h2',
        ),
      ].find((e) => {
        const b = e.getBoundingClientRect();
        return (
          b.width > 0 &&
          Math.abs(b.left - border.left - 3) < 2 &&
          Math.abs(b.top - border.top - 3) < 2 &&
          Math.abs(b.width - border.width + 6) < 2
        );
      }) ?? null
    );
  });
}
async function journey(s, r, text, auto, withModel = true) {
  behavior = 'normal';
  trace = [];
  if (withModel) await pair(s);
  const parsed = await goal(s, text);
  assert.equal(parsed.state, 'awaiting_confirmation');
  assert.equal(parsed.steps, 0);
  const targeted = live && process.env.SAFESTEP_S5_SITE ? '-targeted' : '';
  const screenshotBase =
    (live ? 'live-' : withModel ? 'mock-' : 'local-') + r.name + '-' + r.width + targeted + trialSuffix;
  r.screenshots = [screenshotBase + '-goal.png', screenshotBase + '-complete.png'];
  await s.panel.screenshot({ path: join(out, r.screenshots[0]) });
  const initial = s.page.url();
  await focusJourneyWindow(s);
  r.focusedBeforeMode = true;
  await guidedMode(s.panel,auto);
  let clicks = 0,
    previous = '';
  const end = Date.now() + 55000;
  while (Date.now() < end) {
    const t = await task(s.panel);
    if (t?.state === 'completed') {
      r.end = t.adaptive.status;
      r.finalPath = new URL(s.page.url()).pathname + new URL(s.page.url()).hash;
      r.steps = t.steps;
      break;
    }
    if (t?.state === 'paused' || t?.state === 'cancelled') throw Error(t.adaptive.status);
    if (!auto && t?.state === 'showing_step' && t.revision !== previous) {
      const h = await findTarget(s.page),
        el = h.asElement();
      if (!el) {
        await sleep(75);
        continue;
      }
      previous = t.revision;
      const tag = await el.evaluate((e) => e.tagName);
      if (/^H[1-4]$/.test(tag)) {
        const reveal = await s.panel.$('button[data-show-step]');
        if (reveal) await reveal.click();
        else await btn(s.panel, 'Show this target').click();
      }
      else {
        await el.click();
        clicks++;
      }
    }
    await sleep(80);
  }
  assert(r.end, 'journey did not complete');
  r.modelTrace = trace.slice();
  r.pageClicksByHarness = clicks;
  assert.notEqual(s.page.url(), initial);
  if (r.name.startsWith('mdn-')) assert.equal(new URL(s.page.url()).hash, '#examples');
  if (r.name.startsWith('python-'))
    assert.equal(
      new URL(s.page.url()).hash,
      r.name.includes('exceptions') ? '#handling-exceptions' : '#creating-virtual-environments',
    );
  if (auto) assert.equal(clicks, 0);
  await s.panel.screenshot({ path: join(out, r.screenshots[1]) });
  if (!withModel) {
    const counts = await s.page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('counts') ?? '{}'),
    );
    assert.equal(counts.save ?? 0, 0);
    assert.equal(counts['Account settings'], 1);
    assert.equal(counts.Username, 1);
    r.siteCounts = counts;
  }
  r.checks.push(
    auto
      ? 'Only Start automatic was pressed; no harness activation of a page step.'
      : 'User-style page clicks followed the extension’s cues.',
  );
  if (withModel)
    r.checks.push(
      live
        ? 'Production server and genuine Gemini selection; operational trace captured.'
        : 'Real installed extension with labelled mock model transport. No genuine Gemini generation.',
    );
}
async function clean(s, r) {
  const { page, panel } = s;
  await openArea(panel, 'Safety checks');
  await btn(panel, 'Check this website').click();
  await until(async () => (await view(panel)).v.review, 'initial observations');
  const before = (await view(panel)).v.review;
  assert(before.observations.some((o) => o.code === 'sponsored'));
  await openArea(panel, 'Guide');
  await btn(panel, 'Preview cleanup').click();
  const preview = await until(async () => (await view(panel)).v.cleanup, 'cleanup preview');
  assert(preview.items.length >= 2 && preview.uncertain);
  await btn(panel, 'Apply cleanup').click();
  await until(async () => (await view(panel)).v.cleanup?.hidden === 2, 'two regions hidden');
  const hidden = (id) => page.$eval('#' + id, (e) => getComputedStyle(e).display === 'none');
  assert(await hidden('ad'));
  assert(await hidden('practice-offer'));
  assert(await hidden('practice-backdrop'));
  assert.equal(await hidden('unknown'), false);
  assert.equal(await page.$eval('body', (e) => getComputedStyle(e).overflow), 'auto');
  await openArea(panel, 'Safety checks');
  await btn(panel, 'Check this website').click();
  await until(async () => (await view(panel)).v.review?.cleanup, 'prior risk linked');
  const after = (await view(panel)).v.review;
  assert(after.observations.some((o) => o.code === 'sponsored'));
  assert.equal(before.status, after.status);
  await page.$eval('#ad', (e) => (e.style.color = 'rgb(1, 2, 3)'));
  await page.$eval('#private', (e) => (e.value = 'PRIVATE_USER_EDIT'));
  await page.click('#more');
  await until(async () => (await view(panel)).v.cleanup.hidden === 3, 'dynamic region');
  await openArea(panel, 'Guide');
  await panel.locator('button::-p-text(Restore item)').click();
  await until(async () => (await view(panel)).v.cleanup.hidden === 2, 'one restored');
  await btn(panel, 'Restore cleanup').click();
  await until(async () => (await view(panel)).v.cleanup.hidden === 0, 'all restored');
  assert.equal(await hidden('practice-backdrop'), false);
  assert.equal(await page.$eval('#private', (e) => e.value), 'PRIVATE_USER_EDIT');
  assert.equal(await page.$eval('#ad', (e) => e.style.color), 'rgb(1, 2, 3)');
  r.checks.push(
    'Preview, apply, restore one/all, intact private field and site styles, ad and complete popup/backdrop pair, unknown and protected areas stayed visible; original trust observations retained.',
  );
}
async function edges(s, r) {
  const { panel, page } = s;
  const nokey = await goal(s, 'Find the Practice method Examples.');
  assert(nokey.adaptive.status.includes('not configured'));
  assert.equal(await page.$('[data-safestep-outline]'), null);
  const secret = await goal(s, 'Find my password: SHOULD_NOT_LEAVE');
  assert(!secret.goal.includes('SHOULD_NOT_LEAVE'));
  assert(secret.adaptive.status.includes('Restate'));
  await pair(s);
  const amb = await goal(s, 'Change my name');
  assert.equal(amb.adaptive.intent.action, 'clarify');
  await goal(s, 'Find the Practice method Examples.');
  behavior = 'bad_ref';
  await guidedMode(panel,false);
  await until(async () => (await task(panel)).state === 'paused', 'unknown ref rejected');
  assert.equal(await page.$('[data-safestep-outline]'), null);
  behavior = 'done';
  await btn(panel, 'Resume guide').click();
  await until(
    async () => (await task(panel)).adaptive.status.includes('not been verified'),
    'false done refused',
  );
  behavior = 'delay';
  await btn(panel, 'Resume guide').click();
  await sleep(70);
  await btn(panel, 'Stop navigation').click();
  await sleep(950);
  assert.equal((await task(panel)).state, 'cancelled');
  assert.equal(await page.$('[data-safestep-outline]'), null);
  behavior = 'normal';
  r.checks.push(
    'No-key and private goals stopped, ambiguity retained, unknown ref and false completion refused, Stop defeated a delayed planner. No page activation.',
  );
}
try {
  for (const [w, h] of [
    [1440, 900],
    [1366, 768],
  ]) {
    if (process.env.SAFESTEP_WIDTH && +process.env.SAFESTEP_WIDTH !== w) continue;
    if (live && groups.includes('intent'))
      await run(
        'live intent clarification and constraints',
        w,
        h,
        'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
        async (s, r) => {
          await pair(s);
          for (const [phrase, expected] of [
            ['Show me the Array.filter examples, not map.', 'supported'],
            ['Find examples for Array.filter without map.', 'supported'],
            ['Change my name', 'clarify'],
            ['Find the name property of a JavaScript function on MDN.', 'supported'],
            ['Find the Array.map examples on MDN.', 'supported'],
            ['Purchase Firefox for Windows', 'unsupported'],
          ]) {
            const t = await goal(s, phrase);
            assert.equal(t.goal, phrase);
            assert.equal(t.state, 'awaiting_confirmation', t.adaptive.status);
            if (expected === 'supported') {
              assert(['find_document', 'find_section'].includes(t.adaptive.intent.action));
              if (phrase.includes('filter'))
                assert(
                  t.adaptive.intent.excluded.some((x) => x.text.toLowerCase().includes('map')),
                );
            } else assert.equal(t.adaptive.intent.action, expected);
            r.checks.push({
              goal: phrase,
              action: t.adaptive.intent.action,
              subjects: t.adaptive.intent.subjects.map((x) => x.text),
              excluded: t.adaptive.intent.excluded.map((x) => x.text),
            });
          }
        },
      );
    if (groups.includes('settings'))
      for (const mode of [false, true])
        await run(
          'settings-' + (mode ? 'automatic' : 'guide'),
          w,
          h,
          base + '/settings-lab',
          (s, r) => journey(s, r, 'Find my username settings', mode, false),
        );
    if (groups.includes('cleanup')) await run('cleanup', w, h, base + '/cleanup-lab', clean);
    if (groups.includes('fixture'))
      for (const mode of [false, true])
        await run(
          'mock-practice-' + (mode ? 'automatic' : 'guide'),
          w,
          h,
          base + '/assist-lab/docs',
          (s, r) => journey(s, r, 'Find the Practice method Examples.', mode),
        );
    if (groups.includes('edges'))
      await run('AI boundaries', w, h, base + '/assist-lab/docs', edges);
    if (groups.includes('controls'))
      for (const [name, fn] of Object.entries(
        scenarios({
          btn,
          task,
          goal,
          pair,
          until,
          behavior: (b) => (behavior = b),
          trace: () => trace,
        }),
      )) {
        if (
          process.env.SAFESTEP_S5_CONTROL &&
          !process.env.SAFESTEP_S5_CONTROL.split(',').includes(name)
        )
          continue;
        await run(
          'controls-' + name,
          w,
          h,
          name === 'conflict'
            ? 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array'
            : base +
                (name === 'cleanupEdges'
                  ? '/cleanup-lab'
                  : ['changes', 'pendingCleanup', 'privacyBudget', 'hydration'].includes(name)
                    ? '/assist-lab/docs'
                    : '/settings-lab'),
          fn,
        );
      }
    if (groups.includes('public'))
      for (const [site, start, text, auto] of [
        [
          'mdn-map-guide',
          'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
          'Take me to the examples for JavaScript Array.map on MDN.',
          false,
        ],
        [
          'mdn-map-auto',
          'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
          'Take me to the examples for JavaScript Array.map on MDN.',
          true,
        ],
        [
          'python-venv-guide',
          'https://docs.python.org/3/',
          'Find the Python tutorial section about creating virtual environments.',
          false,
        ],
        [
          'python-venv-auto',
          'https://docs.python.org/3/',
          'Find the Python tutorial section about creating virtual environments.',
          true,
        ],
        [
          'mdn-filter-auto',
          'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
          'Show me the Array.filter examples, not map.',
          true,
        ],
        [
          'python-exceptions-guide',
          'https://docs.python.org/3/',
          'Show me the tutorial section for handling exceptions, not virtual environments.',
          false,
        ],
      ])
        if (!process.env.SAFESTEP_S5_SITE || process.env.SAFESTEP_S5_SITE.split(',').some(part=>site.includes(part)))
          await run(site, w, h, start, (s, r) => journey(s, r, text, auto));
  }
} finally {
  if (api) {
    api.closeAllConnections();
    await new Promise((ok) => api.close(ok));
  }
  lab.server.close();
}
await writeFile(
  join(
    out,
    (live ? 'live-' : 'run-') +
      groups.join('-') +
      '-' +
      (process.env.SAFESTEP_S5_SITE ?? process.env.SAFESTEP_S5_CONTROL ?? 'all') +
      '-' +
      (process.env.SAFESTEP_WIDTH ?? 'both') +
      trialSuffix +
      '.json',
  ),
  JSON.stringify(
    {
      role: 'builder',
      sha256,
      bundle,
      runAt,
      ...(trial ? { trial } : {}),
      provider: live
        ? 'Google Gemini / production SDK'
        : 'labelled test transport or local fixture',
      results,
    },
    null,
    2,
  ) + '\n',
);
if (results.some((r) => r.status !== 'pass') || !results.length) process.exitCode = 1;
