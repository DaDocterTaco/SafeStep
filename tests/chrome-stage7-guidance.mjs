// Builder-run journeys on the installed extension. In automatic mode only the panel is operated.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
const out = resolve('.test-artifacts/stage7-guidance', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const selected = (
  process.env.SAFESTEP_S7_GUIDANCE ?? 'wiki-guide,wiki-auto,wiki-transfer,generic'
).split(',');
const trial = process.env.SAFESTEP_S7_TRIAL ?? '';
assert(!trial || /^[a-zA-Z0-9-]+$/.test(trial));
const widths = process.env.SAFESTEP_WIDTH ? [Number(process.env.SAFESTEP_WIDTH)] : [1440, 1366];
const filename = join(
  out,
  ['run', selected.join('-'), widths.length === 2 ? 'both' : widths[0], trial]
    .filter(Boolean)
    .join('-') + '.json',
);
const health = async () =>
  await (
    await fetch('http://127.0.0.1:4317/v1/assist/health', { signal: AbortSignal.timeout(3000) })
  ).json();
const server = createServer((req, res) => {
  const leaf = new URL(req.url, 'http://localhost').pathname;
  if (!['/public-guide-lab/', '/public-guide-lab/reading-room'].includes(leaf)) {
    res.writeHead(404).end();
    return;
  }
  const item = leaf.endsWith('reading-room');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    '<!doctype html><title>SafeStep labelled public guidance fixture</title><main><h1>' +
      (item ? 'Reading room' : 'Library') +
      '</h1><a href="/public-guide-lab/reading-room">Reading room</a><p>The library provides a publicly named reading room.</p><form data-private><input value="PRIVATE_STAGE7_GOAL"><button type="submit">Save</button></form></main>',
  );
});
server.listen(0, 'localhost');
await once(server, 'listening');
const fixture = `http://localhost:${server.address().port}/public-guide-lab/`;
const btn = (p, name) => p.locator(`::-p-aria(${name}[role="button"])`).setTimeout(9000);
const task = async (p) => (await view(p)).v.task;
const results = [];
const save = async () =>
  writeFile(
    filename,
    JSON.stringify(
      { role: 'builder', at: new Date().toISOString(), sha256, bundle, results },
      null,
      2,
    ) + '\n',
  );

async function until(fn, name, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const x = await fn();
    if (x) return x;
    await delay(130);
  }
  throw Error('Timed out: ' + name);
}
async function pair(s) {
  await s.panel.click('#tab-settings');
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  const field = await s.panel.$('input[type=password]');
  assert(field);
  await field.type((await readFile('apps/api/.env.safestep-session', 'utf8')).trim());
  await btn(s.panel, 'Connect').click();
  await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'));
  await s.panel.click('#tab-guide');
}
async function cue(page) {
  const h = await page.evaluateHandle(() => {
    const r = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
    if (!r) return null;
    for (const node of document.querySelectorAll(
      '#p-search a,#p-search input[type=search],main a,main button,main summary,main h1,main h2,main h3',
    )) {
      const b = node.getBoundingClientRect();
      if (
        b.width > 0 &&
        Math.abs(b.left - r.left - 3) < 2 &&
        Math.abs(b.top - r.top - 3) < 2 &&
        Math.abs(b.width - r.width + 6) < 2
      )
        return node;
    }
    return null;
  });
  return h.asElement();
}
async function run(name, width) {
  const wiki = name.startsWith('wiki'),
    auto = name !== 'wiki-guide',
    start = wiki ? 'https://en.wikipedia.org/wiki/Main_Page' : fixture;
  const goal =
    name === 'wiki-transfer'
      ? 'Find information about the atmosphere of Mars.'
      : wiki
        ? "Find information about Earth's atmosphere."
        : 'Find the Reading room.';
  const expected =
    name === 'wiki-transfer' ? 'Atmosphere of Mars' : wiki ? 'Atmosphere of Earth' : 'Reading room';
  const r = {
    name,
    width,
    goal,
    start,
    status: 'fail',
    websiteActionsByHarness: [],
    states: [],
    checks: [],
    screens: [],
  };
  let s;
  try {
    const h = await health();
    assert(h.configured && h.model, 'Real Gemini is unavailable');
    r.model = h.model;
    // Respect the production provider's six calls/minute session limit, including other callers.
    const recent = h.recent.filter((x) => Date.now() - Date.parse(x.at) < 61000);
    if (recent.length > 2)
      await delay(Math.max(0, 61000 - (Date.now() - Date.parse(recent.at(-1).at))));
    const since = new Date().toISOString();
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, start);
    r.arrivals = [];
    s.page.on('framenavigated', (frame) => {
      if (frame === s.page.mainFrame()) {
        const u = new URL(frame.url());
        r.arrivals.push({
          host: u.hostname,
          path: u.pathname,
          queryFields: [...u.searchParams.keys()],
          fragmentPresent: !!u.hash,
        });
      }
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const loaded = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    );
    assert(loaded?.enabled && resolve(loaded.path) === bundle);
    r.loaded = { id: loaded.id, path: loaded.path };
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    let downloads = 0;
    s.root.on('Browser.downloadWillBegin', () => downloads++);
    await pair(s);
    await s.panel.type('#goal', goal);
    await btn(s.panel, 'Help me').click();
    const parsed = await until(async () => {
      const t = await task(s.panel);
      if (t?.state === 'paused') throw Error(t.adaptive.status);
      return t?.state === 'awaiting_confirmation' && t;
    }, 'genuine intent');
    assert.equal(parsed.goal, goal);
    assert(!parsed.adaptive.authorized);
    assert.equal(parsed.steps, 0);
    const screenshot = async (label) => {
      const file = [name, width, label, trial].filter(Boolean).join('-') + '.png';
      await s.panel.screenshot({ path: join(out, file) });
      r.screens.push(file);
    };
    await screenshot('intent');
    if (auto) {
      await btn(s.panel, 'Take me there').click();
      assert.equal(s.page.url(), start);
      assert(!(await task(s.panel)).adaptive.authorized);
      await btn(s.panel, 'Start automatic').click();
    } else await btn(s.panel, 'Show me').click();
    let previous = '',
      last = '';
    const done = await until(
      async () => {
        const t = await task(s.panel);
        if (!t) return null;
        const marker = t.state + '/' + t.adaptive.status;
        if (marker !== last) {
          last = marker;
          r.states.push({
            state: t.state,
            status: t.adaptive.status,
            journal: t.adaptive.journal,
            path: new URL(s.page.url()).pathname,
          });
        }
        if (t.state === 'completed') return t;
        if (['paused', 'cancelled', 'failed'].includes(t.state)) throw Error(t.adaptive.status);
        if (!auto && t.state === 'showing_step' && previous !== t.revision) {
          const el = await cue(s.page);
          if (!el) return null;
          previous = t.revision;
          const tag = await el.evaluate((e) => e.localName);
          if (tag === 'input') {
            await el.click();
            await el.type(parsed.adaptive.searchQuery);
            await s.page.keyboard.press('Enter');
            r.websiteActionsByHarness.push(
              'Entered the displayed approved public search query and pressed Enter',
            );
          } else if (/^h[1-4]$/.test(tag)) {
            const reveal = await s.panel.$('button[data-show-step]');
            if (reveal) await reveal.click();
            else await btn(s.panel, 'Show this target').click();
          } else {
            await el.click();
            r.websiteActionsByHarness.push('Clicked the currently outlined ' + tag);
          }
        }
        return null;
      },
      'verified destination',
      60000,
    );
    r.final = await s.page.evaluate(() => ({
      url: location.href,
      title: document.querySelector('h1')?.innerText,
      headingVisible: document.querySelector('h1')?.getBoundingClientRect().bottom > 0,
    }));
    assert.equal(r.final.title, expected);
    assert(r.final.headingVisible);
    assert.notEqual(r.final.url, start);
    assert(done.steps > 0);
    assert(!auto || r.websiteActionsByHarness.length === 0);
    assert.equal(downloads, 0);
    const final = await health();
    r.operations = final.recent.filter((x) => x.at >= since);
    assert(r.operations.some((x) => x.operation === 'intent' && x.status === 'available'));
    assert(r.operations.some((x) => x.operation === 'step' && x.status === 'available'));
    await screenshot('complete');
    r.status = 'pass';
    r.checks.push(
      'Genuine current intent and next-step operations. Exact public heading and canonical destination inspected. No file activation.',
    );
  } catch (e) {
    r.error = String(e.message).slice(0, 300);
    if (/unavailable|503|rate limit|AI request timed out|ECONNREFUSED|net::ERR_|expired/i.test(r.error))
      r.status = 'blocked';
    if (s) {
      r.last = (await task(s.panel).catch(() => null))?.adaptive?.status;
      const u = new URL(s.page.url());
      r.finalPath = u.pathname;
      r.queryFields = [...u.searchParams.keys()];
      r.fragmentPresent = !!u.hash;
      const file = [name, width, 'diagnostic', trial].filter(Boolean).join('-') + '.png';
      await s.panel.screenshot({ path: join(out, file) }).then(
        () => r.screens.push(file),
        () => {},
      );
    }
    r.health = (await health().catch(() => null))?.recent?.slice(-3);
  } finally {
    if (s) await s.browser.close();
    results.push(r);
    await save();
    console.log(r.status, name, width, r.error ?? '');
  }
}
try {
  for (const width of widths) for (const name of selected) await run(name, width);
} finally {
  server.close();
}
if (results.some((r) => r.status !== 'pass')) process.exitCode = 1;
