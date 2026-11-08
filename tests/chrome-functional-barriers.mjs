// Installed Chrome with an intentionally delayed local provider and a harmless owned page.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';

const build = process.env.SAFESTEP_NAV_BUILD;
assert.match(build, /^stage-8-[0-9a-f]{12}$/);
const bundle = resolve('artifacts', build, 'chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
assert.equal(build, 'stage-8-' + sha256.slice(0, 12));
const out = resolve(
  'docs/evidence/functional-navigation/native',
  build,
  new Date().toISOString().replace(/[:.]/g, '-') + '-controlled',
);
await mkdir(out, { recursive: true });
const rows = [],
  time = () => new Date().toISOString(),
  button = (p, name) => p.locator('::-p-aria(' + name + '[role="button"])').setTimeout(5500);
const current = async (s) => (await view(s.panel)).v.task;
async function until(fn, why) {
  const end = Date.now() + 9500;
  while (Date.now() < end) {
    const x = await fn();
    if (x) return x;
    await sleep(55);
  }
  throw Error(why);
}
async function run(name, width) {
  const r = {
    name,
    width,
    source: 'Installed Chrome, deliberately delayed local fixture planner, no paid requests',
    checks: [],
    entered: 0,
    commits: 0,
    status: 'fail',
    started: time(),
  };
  const page = createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/public-guide-lab/reading-room') r.commits++;
    const target = '<a id=target href="/public-guide-lab/reading-room">Reading room</a>';
    const menu =
      '<details><summary>Reading menu</summary></details><script>document.querySelector("details").addEventListener("toggle",e=>{if(e.target.open)setTimeout(()=>e.target.insertAdjacentHTML("beforeend",' +
      JSON.stringify(target) +
      '),260)},{once:true});</script>';
    const destination = r.commits > 0;
    res
      .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(
        '<!doctype html><meta charset=utf-8><main><h1>' +
          (destination ? 'Reading room' : 'Library') +
          '</h1>' +
          (destination ? '' : name === 'delayed menu' ? menu : target) +
          '</main>',
      );
  });
  page.listen(0, 'localhost');
  await once(page, 'listening');
  const origin = 'http://localhost:' + page.address().port,
    start = origin + '/public-guide-lab/';
  let releaseStep, api, s;
  try {
    const token = newPairToken(),
      output = (x) => ({ text: JSON.stringify(x), tokens: 0 });
    const provider = async (i, signal) => {
      if (i.kind === 'intent') {
        const term = i.goal.includes('Reading room') ? 'Reading room' : 'Library',
          pos = i.goal.indexOf(term);
        return output({
          action: 'find_document',
          subjects: [{ text: term, start: pos, end: pos + term.length }],
          constraints: [],
          excluded: [],
          question: '',
          choices: [],
        });
      }
      r.entered++;
      const link =
        i.snapshot.controls.find((x) => x.label === 'Reading room') ??
        (name === 'delayed menu'
          ? i.snapshot.controls.find((x) => x.label === 'Reading menu' && !x.expanded)
          : undefined);
      if (r.entered === 1 && name !== 'delayed menu')
        await new Promise((ok) => {
          releaseStep = ok;
          signal.addEventListener(
            'abort',
            () => {
              r.transportAborted = true;
              ok();
            },
            { once: true },
          );
        });
      return output(
        link
          ? { kind: 'next_candidate', ref: link.ref, action: link.action, citations: [link.ref] }
          : { kind: 'cannot_continue', reason: 'missing_target' },
      );
    };
    const gemini = new GeminiService(
      { GEMINI_API_KEY: 'labelled-control-fixture', GEMINI_MODEL: 'gemini-fixture-only' },
      token,
      async () => output({}),
      12000,
      undefined,
      provider,
      undefined,
      async () =>
        output({
          kind: 'routed',
          feature: 'automatic_navigation',
          slots: { subjectRef: null },
          reason: 'Controlled pending navigation.',
        }),
    );
    api = makeApi(undefined, gemini);
    api.listen(4317, '127.0.0.8');
    await once(api, 'listening');
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, start, {
      apiHost: '127.0.0.8',
      attachWorker: true,
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    await button(s.panel, 'Settings').click();
    await s.panel.locator('summary::-p-text(Connect local AI)').click();
    await s.panel.type('input[type=password]', token);
    await button(s.panel, 'Connect').click();
    await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'));
    await button(s.panel, 'Close Settings').click();
    await s.panel.type('#chat-composer', 'Find Reading room.');
    await s.panel.keyboard.press('Enter');
    const task = await until(async () => {
      const x = await current(s);
      return x?.state === 'awaiting_confirmation' && x;
    }, 'bound request');
    await button(s.panel, 'Take me there').click();
    assert.equal(r.commits, 0);
    await button(s.panel, 'Start automatic').click();
    if (name === 'delayed menu') {
      const final = await until(async () => {
        const t = await current(s);
        if (t?.state === 'paused') throw Error(t.adaptive.status);
        return t?.state === 'completed' && t;
      }, 'automatic public menu target verified');
      assert.equal(r.commits, 1);
      assert.equal(new URL(s.page.url()).pathname, '/public-guide-lab/reading-room');
      assert.equal(await s.page.$eval('main h1', (e) => e.innerText), 'Reading room');
      r.final = final.adaptive.status;
      r.checks.push(
        'Product opened native disclosure and followed the delayed verified link, with zero driver website actions.',
      );
      r.status = 'pass';
      return;
    }
    await until(() => r.entered === 1, 'planner was actually pending');
    if (['Stop', 'Pause', 'Take over'].includes(name)) await button(s.panel, name).click();
    if (name === 'goal edit') {
      await button(s.panel, 'Edit request').click();
      await s.panel.focus('#chat-composer');
      await s.panel.keyboard.down('Control');
      await s.panel.keyboard.press('a');
      await s.panel.keyboard.up('Control');
      await s.panel.keyboard.type('Find Library.');
      await s.panel.keyboard.press('Enter');
      await until(async () => {
        const t = await current(s);
        return t && (t.id !== task.id || !t.adaptive.authorized);
      }, 'new subject retired authorization');
    }
    if (name === 'tab switch') {
      const other = await s.browser.newPage();
      await other.goto(origin + '/public-guide-lab/other');
      await other.bringToFront();
      await until(
        () =>
          s.panel.evaluate(
            (original) =>
              chrome.tabs
                .query({ active: true, currentWindow: true })
                .then(([t]) => t?.id !== undefined && t.id !== original),
            task.tabId,
          ),
        'second tab active',
      );
      await sleep(150);
      releaseStep();
      await other.close();
      await s.page.bringToFront();
    }
    if (name === 'restart') {
      const worker = await s.browser.waitForTarget(
        (t) =>
          t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + s.id + '/'),
      );
      await (await worker.worker()).close();
      await s.panel
        .evaluate(() => chrome.runtime.sendMessage({ v: 1, type: 'unsupported_probe' }))
        .catch(() => {});
    }
    if (name === 'target replaced' || name === 'repeated label') {
      await s.page.evaluate((what) => {
        const original = document.querySelector('#target');
        if (what === 'target replaced') original.remove();
        else original.after(original.cloneNode(true));
      }, name);
    }
    releaseStep();
    await sleep(350);
    const final = await until(async () => {
      const t = await current(s);
      return t && (!t.adaptive.authorized || t.id !== task.id) && t;
    }, 'late proposal lost authority');
    r.after = {
      state: final.state,
      mode: final.mode,
      status: final.adaptive.status,
      newTask: final.id !== task.id,
    };
    assert.equal(r.commits, 0);
    assert.equal(s.page.url(), start);
    assert.equal(await s.page.$('[data-safestep-outline]'), null);
    if (name === 'Stop') assert.equal(final.state, 'cancelled');
    if (name === 'Take over') assert.equal(final.mode, 'guide');
    const file = name.replaceAll(' ', '-') + '-' + width + '.png';
    await s.panel.screenshot({ path: join(out, file) });
    r.screen = file;
    r.checks.push('Pending proposal could not navigate or leave an active outline.');
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message)
      .replace(/ss3_[\w-]+/g, '[redacted]')
      .slice(0, 260);
    if (s) r.last = (await current(s).catch(() => null))?.adaptive?.status;
  } finally {
    releaseStep?.();
    if (s) await s.browser.close();
    if (api) {
      api.closeAllConnections();
      await new Promise((ok) => api.close(ok));
    }
    page.closeAllConnections();
    await new Promise((ok) => page.close(ok));
    r.ended = time();
    rows.push(r);
    await writeFile(
      join(out, 'results.json'),
      JSON.stringify({ role: 'builder', build, sha256, rows }, null, 2) + '\n',
    );
    console.info(name, width, r.status, r.error ?? '');
  }
}
const allowed = [
  'Pause',
  'Stop',
  'Take over',
  'goal edit',
  'tab switch',
  'restart',
  'target replaced',
  'repeated label',
  'delayed menu',
];
const names = process.argv[2]?.split(',') ?? allowed;
assert(names.every((x) => allowed.includes(x)));
for (const width of [1440, 1366]) for (const name of names) await run(name, width);
if (rows.some((r) => r.status !== 'pass')) process.exitCode = 1;
