// S7-C01. Run serially with the production API paired to this unpacked build.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  ExplainReply,
  ShopAIReply,
  explanationInput,
  shoppingInput,
  validatedExplanation,
  validatedShoppingExplanation,
  compareFacts,
} from '@safestep/contracts';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { openArea } from './support/stage7-panel.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';

const bundle = path.resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3');
const { sha256 } = await fingerprint(bundle);
const out = path.join('.test-artifacts', 'stage7-explanations', sha256.slice(0, 12));
await fs.mkdir(out, { recursive: true });
const token = (await fs.readFile('apps/api/.env.safestep-session', 'utf8')).trim();
const local = 'http://127.0.0.1:4317';
const health = async (route) =>
  await (await fetch(local + route, { signal: AbortSignal.timeout(3000) })).json();
const btn = (p, name) => p.locator('::-p-aria(' + name + '[role="button"])').setTimeout(8000);
const start = await health('/v1/explain/operations');
assert(start.configured && start.model, 'Start the configured production API before running C01.');
const lab = await startFixture(0);
const sites = {
  website: 'https://www.videolan.org/vlc/download-windows.html',
  download: 'https://www.7-zip.org/download.html',
  seller: 'https://foxedandfound.resell.store/mastering-art-french-cooking-1961',
  product: 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
  comparison: lab.origin + '/comparison-lab/original',
};
const cases = (process.env.SAFESTEP_C01_CASES ?? Object.keys(sites).join(',')).split(',');
assert(cases.length && cases.every((x) => Object.hasOwn(sites, x)));
const results = [],
  trial = process.env.SAFESTEP_S7_TRIAL ?? '';
assert(!trial || /^[a-z0-9-]{1,45}$/.test(trial));
const file = path.join(
  out,
  ['c01', cases.join('-'), process.env.SAFESTEP_WIDTH ?? 'both', trial].filter(Boolean).join('-') +
    '.json',
);
async function until(fn, why, ms = 22000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  throw new Error('Timed out: ' + why);
}
async function connect(s) {
  await openArea(s.panel, 'Settings');
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  await s.panel.type('input[type=password]', token);
  await btn(s.panel, 'Connect').click();
  await s.panel.waitForFunction(() => document.body.innerText.includes('Connected to Gemini'), {
    timeout: 5500,
  });
}
async function current(s, k) {
  const v = (await view(s.panel)).v;
  return ['seller', 'product'].includes(k) ? v.shopping?.[k]?.data : v.review;
}
async function acquire(s, k) {
  const shop = ['seller', 'product'].includes(k);
  await openArea(s.panel, shop ? 'Shopping' : 'Safety checks');
  if (k === 'download') {
    await s.panel.locator('summary::-p-text(Download help)').click();
    const sel = await s.panel.$$(
      'section[aria-label="Website and download checks"] details select',
    );
    await sel[0].select('seven_zip_windows_x64_exe');
    await sel[1].select('x64');
  }
  await btn(
    s.panel,
    shop ? 'Check ' + k : k === 'website' ? 'Check this website' : 'Identify button',
  ).click();
  return until(async () => {
    const d = await current(s, k);
    return d && (shop ? d.kind : d.selection.kind) === k && d;
  }, k + ' capture');
}
let lastSent = 0;
async function spaceCalls() {
  const ms = lastSent + 10500 - Date.now();
  if (ms > 0) await wait(ms);
  lastSent = Date.now();
}
async function explanation(s, r, k) {
  const d = await acquire(s, k),
    shop = ['seller', 'product'].includes(k),
    input = shop ? shoppingInput(d) : explanationInput(d);
  if (shop)
    await s.panel
      .locator(
        'article[aria-label="' +
          (k === 'seller' ? 'Seller' : 'Product') +
          ' assessment"] summary::-p-text(Gemini explanation)',
      )
      .click();
  if (k === 'download')
    assert(d.selected, 'Actual 7-Zip package must have a verified selected control.');
  await spaceCalls();
  const url = local + (shop ? '/v1/shopping/explain' : '/v1/explain');
  const received = s.panel.waitForResponse(
    (x) => x.url() === url && x.request().method() === 'POST',
    { timeout: 14000 },
  );
  await btn(
    s.panel,
    shop
      ? 'Explain this summary with Gemini'
      : k === 'website'
        ? 'Explain this check'
        : 'Why this button?',
  ).click();
  const response = await received;
  const sent = JSON.parse(response.request().postData());
  assert.deepEqual(sent, input);
  const reply = (shop ? ShopAIReply : ExplainReply).parse(await response.json());
  r.http = response.status();
  r.operation = {
    kind: k,
    status: reply.status,
    tokens: reply.tokens,
    elapsedMs: reply.elapsedMs,
    operationId: input.operationId,
  };
  r.health = await health('/v1/explain/operations');
  assert.equal(response.status(), 200);
  assert.equal(reply.status, 'available');
  assert.equal(reply.operationId, input.operationId);
  assert.equal(reply.bindingToken, input.bindingToken);
  const valid = shop
    ? validatedShoppingExplanation(reply.explanation, input)
    : validatedExplanation(reply.explanation, input);
  assert(valid, 'Reply did not validate against its current source evidence.');
  assert.equal((await current(s, k)).binding.operationId, input.operationId);
  await s.panel.waitForFunction(
    (summary) => document.body.innerText.includes(summary),
    { timeout: 4000 },
    valid.summary,
  );
  assert(r.health.operations[k]?.verified);
  assert.equal(r.health.operations[k].status, 'available');
  r.evidence = {
    publicSite: new URL(s.page.url()).hostname,
    sourceFacts: input.evidence,
    validated: valid,
  };
}
async function compare(s, r) {
  await openArea(s.panel, 'Shopping');
  await btn(s.panel, 'Find alternatives').click();
  await s.panel.waitForSelector('form.comparison-form');
  const goal = await s.panel.$('::-p-aria(Comparison goal[role="textbox"])');
  await goal.type('Compare this practice pen across two shops');
  const query = await s.panel.$('::-p-aria(Public search terms[role="textbox"])');
  await query.click({ clickCount: 3 });
  await query.type('fountain pen');
  await btn(s.panel, 'Find options').click();
  const data = async () => (await view(s.panel)).v.comparison;
  const before = await until(async () => {
    const v = await data();
    return v?.status === 'ready' && v.candidates.length && v;
  }, 'current shortlist');
  const allowed = compareFacts(before);
  await spaceCalls();
  const time = new Date().toISOString();
  await btn(s.panel, 'Explain comparison with Gemini').click();
  const after = await until(async () => {
    const x = await data();
    return x?.ai && !x.ai.includes('Asking') && x;
  }, 'comparison explanation');
  r.health = await health('/v1/compare/health');
  r.operation = {
    kind: 'comparison',
    message: after.ai,
    status:
      r.health.recent.findLast((x) => x.operation === 'explain' && x.at >= time)?.status ??
      'unavailable',
  };
  assert(
    after.explanation.length && after.explanation.every((t) => allowed.some((f) => f.text === t)),
  );
  assert(r.health.explain && r.operation.status === 'available');
  assert.deepEqual(
    before.candidates.map((c) => c.savings),
    after.candidates.map((c) => c.savings),
  );
  await s.panel.waitForFunction(
    (n) => document.body.innerText.includes(n),
    { timeout: 4000 },
    after.explanation[0],
  );
  r.evidence = {
    source: 'labelled current local comparison',
    cited: after.explanation,
    allowed: allowed.map((f) => ({ id: f.id, candidate: f.candidate, text: f.text })),
  };
}
try {
  for (const width of [1440, 1366]) {
    if (process.env.SAFESTEP_WIDTH && Number(process.env.SAFESTEP_WIDTH) !== width) continue;
    for (const k of cases) {
      let s;
      const r = { kind: k, width, status: 'fail', at: new Date().toISOString() };
      try {
        s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, sites[k]);
        r.dimensions = s.dimensions;
        r.chrome = await s.browser.version();
        const ext = (await s.root.send('Extensions.getExtensions')).extensions.find(
          (x) => x.id === s.id,
        );
        assert(ext?.enabled && path.resolve(ext.path) === bundle);
        r.loaded = { id: ext.id, path: ext.path };
        await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
        let downloads = 0;
        s.root.on('Browser.downloadWillBegin', () => downloads++);
        await connect(s);
        if (k === 'comparison') await compare(s, r);
        else await explanation(s, r, k);
        assert.equal(downloads, 0);
        r.downloads = downloads;
        r.screenshot = [k, width, trial].filter(Boolean).join('-') + '.png';
        await s.panel.screenshot({ path: path.join(out, r.screenshot) });
        r.status = 'pass';
      } catch (e) {
        r.error = String(e.message ?? e)
          .replaceAll(token, '[redacted]')
          .slice(0, 320);
        if (['rate_limited','not_configured','timeout','unavailable'].includes(r.operation?.status)) {
          r.status = 'blocked';
          r.error = 'The paired service recorded ' + r.operation.status + ' for ' + k + '. ' + r.error;
        }
      } finally {
        if (s) await s.browser.close();
        results.push(r);
        await fs.writeFile(
          file,
          JSON.stringify(
            {
              role: 'builder',
              sha256,
              bundle,
              model: start.model,
              at: new Date().toISOString(),
              results,
            },
            null,
            2,
          ) + '\n',
        );
        console.log(r.status, k, width, r.error ?? '');
      }
    }
  }
} finally {
  lab.server.close();
}
if (!results.length || results.some((x) => x.status !== 'pass')) process.exitCode = 1;
