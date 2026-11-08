// Core fixture verification with a labelled transport and an actual installed extension. No live AI credit.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import { fingerprint } from '../scripts/stage1.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle),
  out = resolve('.test-artifacts/stage7-guidance', sha256.slice(0, 12)),
  trial = process.env.SAFESTEP_S7_TRIAL ?? '';
assert(!trial || /^[a-z0-9-]+$/i.test(trial));
await mkdir(out, { recursive: true });
const web = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!/^\/public-guide-lab\/(dense|modes|boundaries|reading-room)$/.test(path)) {
    res.writeHead(404).end();
    return;
  }
  const cross =
    '<a href="https://external.invalid/go">External</a><a href="/public-guide-lab/reading-room" target="_blank">New tab</a><a href="/public-guide-lab/account">Account</a><button data-unknown>Run unknown</button>';
  const spacer = path.endsWith('/dense') ? '<span></span>'.repeat(1800) : '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    '<!doctype html><title>SafeStep public guidance practice</title><main><h1>' +
      (path.endsWith('reading-room') ? 'Reading room' : 'Library') +
      '</h1>' +
      cross +
      '<form data-private><input value="PRIVATE_STAGE7_FORM"><button>Save</button></form>' +
      spacer +
      '<a id="target" href="/public-guide-lab/reading-room">Reading room</a></main>',
  );
});
web.listen(0, 'localhost');
await once(web, 'listening');
const base = `http://localhost:${web.address().port}/public-guide-lab/`;
const buttons = (p, txt) => p.locator(`::-p-aria(${txt}[role="button"])`).setTimeout(7000);
const current = async (p) => (await view(p)).v.task;
async function until(fn, desc) {
  const end = Date.now() + 18000;
  while (Date.now() < end) {
    const z = await fn();
    if (z) return z;
    await delay(60);
  }
  throw Error('Timed out: ' + desc);
}
async function paired(s, token) {
  await s.panel.click('#tab-settings');
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  await s.panel.type('input[type=password]', token);
  await buttons(s.panel, 'Connect').click();
  await s.panel.waitForFunction(() => /Connected|Connection unavailable/.test(document.querySelector('input[type=password]')?.closest('details')?.querySelector('[role=status]')?.textContent ?? ''), {timeout:6500});
  const pairing=await s.panel.$eval('input[type=password]',e=>e.closest('details').querySelector('[role=status]').textContent);
  assert(pairing.includes('Connected to Gemini · gemini-fixture-only'),pairing);
  await s.panel.click('#tab-guide');
}

const runs = [];
async function run(name, width) {
  const r = {
    name: 'policy-' + name,
    width,
    status: 'fail',
    checks: [],
    source: 'labelled transport and local practice page',
    snapshots: [],
    websiteActionsByHarness: 0,
  };
  let s, api, hold;
  const token = newPairToken();
  try {
    const gen = async (i, signal) => {
      assert(
        !/PRIVATE_STAGE7_FORM|external\.invalid|\/public-guide-lab\/account|Run unknown|New tab/.test(
          JSON.stringify(i),
        ),
        'Private or ineligible content reached planner',
      );
      let reply;
      if (i.kind === 'intent') {
        const positive = 'Reading room',
          a = i.goal.indexOf(positive),
          exc = 'archive',
          b = i.goal.indexOf(exc);
        reply = {
          action: 'find_document',
          subjects: [{ start: a, end: a + positive.length, text: positive }],
          constraints: [],
          excluded: b < 0 ? [] : [{ start: b, end: b + exc.length, text: exc }],
          question: '',
          choices: [],
        };
      } else {
        r.snapshots.push({
          limited: i.snapshot.limited,
          controls: i.snapshot.controls.map((c) => c.label),
          previous: i.previous,
        });
        const el = i.snapshot.controls.find((x) => x.label === 'Reading room');
        reply = el
          ? { kind: 'next_candidate', ref: el.ref, action: el.action, citations: [el.ref] }
          : { kind: 'need_more_controls', terms: ['Reading room'] };
        if (hold)
          await new Promise((ok) => {
            hold = ok;
            signal.addEventListener('abort', ok, { once: true });
          });
      }
      return { text: JSON.stringify(reply), tokens: 12 };
    };
    const service = new GeminiService(
      { GEMINI_API_KEY: 'labelled-fixture', GEMINI_MODEL: 'gemini-fixture-only' },
      token,
      async () => { throw Error('Unexpected explanation request in the guidance fixture'); },
      8000,
      undefined,
      gen,
    );
    assert.equal(service.health().state,'configured_unverified');
    assert.equal(service.assistHealth().configured,true);
    api = makeApi(undefined, service);
    api.listen(4317, '127.0.0.8');
    await once(api, 'listening');
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, base + name, {
      apiHost: '127.0.0.8',
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const loaded = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    );
    assert(loaded?.enabled && resolve(loaded.path) === bundle);
    r.loaded = { id: loaded.id, path: loaded.path };
    await paired(s, token);
    const goal = name === 'boundaries' ? 'Find Reading room, not archive.' : 'Find Reading room.';
    await s.panel.type('#goal', goal);
    await buttons(s.panel, 'Help me').click();
    let t = await until(async () => {
      const t = await current(s.panel);
      if (t?.state === 'paused') throw Error(t.adaptive.status);
      return t?.state === 'awaiting_confirmation' && t;
    }, 'intent');
    assert.equal(t.goal, goal);
    assert.equal(t.steps, 0);
    if (name === 'boundaries') {
      assert.equal(t.adaptive.intent.excluded[0].text, 'archive');
      await buttons(s.panel, 'Show me').click();
      await until(
        async () => (await current(s.panel))?.state === 'showing_step',
        'safe observed cue',
      );
      assert(r.snapshots.at(-1).controls.includes('Reading room'));
      await s.page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'password';
        input.value = 'PRIVATE_STAGE7_FORM';
        document.querySelector('main').append(input);
      });
      await until(async () => (await current(s.panel))?.state === 'paused', 'private form refused');
      assert(!(await s.page.$('[data-safestep-outline]')));
      assert.equal(new URL(s.page.url()).pathname, '/public-guide-lab/boundaries');
      r.checks.push(
        'Declared negation survived; cross-origin, new-tab, unknown handler and account links were absent from candidate facts. A private input appearing during guidance retired the outline before an action.',
      );
    } else if (name === 'dense') {
      await buttons(s.panel, 'Show me').click();
      await until(
        async () => (await current(s.panel))?.state === 'showing_step',
        'targeted lookup',
      );
      assert(r.snapshots[0].limited && !r.snapshots[0].controls.includes('Reading room'));
      assert(r.snapshots.at(-1).controls.includes('Reading room'));
      await s.page.evaluate(() => {
        const copy = document.querySelector('#target').cloneNode(true);
        copy.removeAttribute('id');
        document.querySelector('main').prepend(copy);
      });
      await until(async () => (await current(s.panel))?.state === 'paused', 'late duplicate');
      assert(!(await s.page.$('[data-safestep-outline]')));
      assert.equal(new URL(s.page.url()).pathname, '/public-guide-lab/dense');
      r.checks.push(
        'A 1,800-node prefix exhausted the initial scan; a model-requested bounded lookup located the live target. A late distant equivalent retired the selected control and prevented activation.',
      );
    } else {
      await buttons(s.panel, 'Show me').click();
      await until(async () => (await current(s.panel))?.state === 'showing_step', 'manual cue');
      await buttons(s.panel, 'Take me there').click();
      t = await current(s.panel);
      assert(!t.adaptive.authorized);
      assert.equal(s.page.url(), base + name);
      hold = true;
      await buttons(s.panel, 'Start automatic').click();
      await until(() => typeof hold === 'function', 'pending approved plan');
      await buttons(s.panel, 'Take over').click();
      await until(async () => (await current(s.panel))?.state === 'paused', 'explicit takeover');
      if (typeof hold === 'function') hold();
      hold = false;
      await s.panel.focus('#goal');
      await s.panel.keyboard.press('End');
      await s.panel.keyboard.type(' Updated');
      await until(
        async () => (await current(s.panel))?.adaptive?.status.includes('Goal edited'),
        'edit invalidation',
      );
      await buttons(s.panel, 'Stop navigation').click();
      await until(async () => (await current(s.panel))?.state === 'cancelled', 'stop');
      await delay(180);
      assert.equal(s.page.url(), base + name);
      assert(!(await s.page.$('[data-safestep-outline]')));
      r.checks.push(
        'Mode preview did not navigate. Explicit approval, takeover during a held step, goal edit and Stop retired authorization and prevented late activation.',
      );
    }
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message).slice(0, 240);
    if (s) r.last = (await current(s.panel).catch(() => null))?.adaptive?.status;
  } finally {
    if (typeof hold === 'function') hold();
    if (s) await s.browser.close();
    if (api) {
      api.closeAllConnections();
      await new Promise((ok) => api.close(ok));
    }
    runs.push(r);
    console.log(r.status, r.name, width, r.error ?? '');
    await writeFile(
      join(
        out,
        ['policy', process.env.SAFESTEP_WIDTH ?? 'both', trial].filter(Boolean).join('-') + '.json',
      ),
      JSON.stringify(
        { role: 'builder', at: new Date().toISOString(), sha256, bundle, results: runs },
        null,
        2,
      ) + '\n',
    );
  }
}
try {
  for (const width of process.env.SAFESTEP_WIDTH
    ? [Number(process.env.SAFESTEP_WIDTH)]
    : [1440, 1366])
    for (const name of ['dense', 'modes', 'boundaries']) await run(name, width);
} finally {
  web.close();
}
if (runs.some((x) => x.status !== 'pass')) process.exitCode = 1;
