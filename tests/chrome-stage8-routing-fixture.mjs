// Installed UI verification using an injected, labelled loopback transport.
// No provider credentials or outbound model calls. All ordinary page clicks in
// this suite are on our local shopping fixture; no auto navigation is credited.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3');
const { sha256 } = await fingerprint(bundle);
assert.match(JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')).version, /^0\.8\./);
const trial = process.env.SAFESTEP_S8_TRIAL ?? 'builder';
assert.match(trial, /^[a-z0-9-]{1,40}$/);
const out = resolve('.test-artifacts/stage8', sha256.slice(0, 12), trial);
await mkdir(out, { recursive: true });
const fixture = await startFixture(0),
  start = fixture.origin + '/shopping-lab/listing';
const names = ['clarify', 'invalid', 'cancel', 'isolate', 'offline', 'goal-history'];
const selected = (process.env.SAFESTEP_S8_ROUTE_CASES ?? names.join(',')).split(',');
assert(selected.length && selected.every((n) => names.includes(n)));
const runAt = new Date().toISOString(),
  results = [];
const button = (p, name) => p.locator('::-p-aria(' + name + '[role="button"])').setTimeout(7000);
const state = async (s) => (await view(s.panel)).v;
const turn = async (s) => {
  const c = (await state(s)).chat;
  return c?.turns.find((t) => t.id === c.activeTurnId);
};
const record = (r, id, observation) => (r.caseChecks[id] ??= []).push(observation);
async function until(fn, why, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await wait(55);
  }
  throw Error('Timed out: ' + why);
}
async function submit(p, text) {
  await p.focus('#chat-composer');
  await p.keyboard.down('Control');
  await p.keyboard.press('a');
  await p.keyboard.up('Control');
  await p.keyboard.type(text);
  assert.equal(
    await p.$eval('#chat-composer', (e) => e.value),
    text,
    'request reached the visible composer before Enter',
  );
  await p.keyboard.press('Enter');
}
async function pair(s, token, r) {
  await button(s.panel, 'Settings').click();
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  await s.panel.type('input[type=password]', token);
  await button(s.panel, 'Connect').click();
  await until(
    () =>
      s.panel.evaluate(() =>
        document.body.innerText.includes('Connected to Gemini · gemini-fixture-only'),
      ),
    'paired to labelled local transport',
  );
  // Place a deliberate new focus in the same frame as the user closing Settings.
  // The product's queued focus-restoration must leave that newer target alone.
  await s.panel.$eval('[aria-label="Close Settings"]', (close) => {
    window.fixtureCloseFocus = new Promise((resolve) =>
      close.addEventListener(
        'click',
        () =>
          queueMicrotask(() => {
            const e = document.querySelector('#chat-composer');
            e.focus();
            const immediately = document.activeElement === e;
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                resolve({
                  immediately,
                  afterFrames: document.activeElement === e,
                  active:
                    document.activeElement?.id ||
                    document.activeElement?.textContent?.trim().slice(0, 50),
                });
              }),
            );
          }),
        { once: true },
      ),
    );
  });
  await button(s.panel, 'Close Settings').click();
  r.closeFocus = await s.panel.evaluate(() => window.fixtureCloseFocus);
  assert(
    r.closeFocus.immediately && r.closeFocus.afterFrames,
    'closing Settings must preserve newer composer focus',
  );
  assert.equal(
    await s.panel.$('::-p-aria(Close Settings[role="button"])'),
    null,
    'secondary surface closed',
  );
}
async function clear(s) {
  await button(s.panel, 'Settings').click();
  await s.panel.locator('summary::-p-text(Reading and conversation)').click();
  await button(s.panel, 'New chat').click();
  const close = await s.panel.$('::-p-aria(Close Settings[role="button"])');
  if (close) await close.click();
  await until(async () => !(await state(s)).chat?.turns.length, 'new conversation');
}
const localNavigationGoal = 'Find my username settings';
async function startLocalGuide(s) {
  await button(s.panel, 'Help').click();
  await button(s.panel, 'Guide me on this page').click();
  await button(s.panel, localNavigationGoal).click();
  await button(s.panel, 'Show me').click();
  return until(async () => {
    const v = await state(s);
    const entry = v.chat?.turns.find((t) => t.id === v.chat.activeTurnId);
    return v.task?.state === 'showing_step' && v.task.goal === localNavigationGoal &&
      entry?.taskId === v.task.id && entry.documentId &&
      { task: v.task.id, conversation: v.chat.id, document: entry.documentId };
  }, 'visible local guide bound to its task and document');
}
function decision(feature, slots) {
  return { kind: 'routed', feature, reason: 'Inspect the requested current subject.', slots };
}
async function run(name, width) {
  const r = {
    name: 'routing-fixture-' + name,
    width,
    status: 'fail',
    start,
    caseChecks: {},
    screens: [],
    guideClicks: [],
    fileAttempts: [],
    downloads: 0,
    source: 'labelled chat transport on a local shopping practice page',
    calls: [],
  };
  let s,
    api,
    release,
    aborted = false;
  const token = newPairToken();
  let behaviour = name;
  async function generate(input, signal) {
    // Deliberately do not save arbitrary user text or raw provider bodies.
    r.calls.push({
      turnId: input.turnId,
      operationId: input.operationId,
      contextKey: input.contextKey,
      subjects: input.subjects.map((w) => w.kind),
      text: input.text,
      historyCount: input.history.length,
    });
    assert(!JSON.stringify(input).includes('PRIVATE_SHOP_'));
    let reply;
    if (behaviour === 'goal-history') {
      (r.goalBoundaries ??= []).push({
        conversation: input.conversationId,
        site: input.site,
        subjectKinds: input.subjects.map((subject) => subject.kind),
        historyCount: input.history.length,
        previousGoalInSubjects: input.subjects.some((subject) => subject.label.includes(localNavigationGoal)),
        previousGoalInHistory: input.history.some((entry) => entry.text.includes(localNavigationGoal)),
      });
      reply = { kind: 'unsupported', reason: 'This labelled fixture only inspects request context.', suggestions: [] };
    } else if (behaviour === 'hold') {
      await new Promise((resolve) => {
        release = resolve;
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      reply = decision('product_assessment', {
        subjectRef: input.subjects.find((x) => x.kind === 'product')?.ref ?? null,
      });
    } else if (behaviour === 'invalid')
      reply = decision('product_assessment', { subjectRef: 's8' });
    else if (behaviour === 'clarify' && r.calls.length === 1)
      reply = {
        kind: 'clarify',
        question: 'Which evidence should I inspect?',
        choices: ['The product reviews', 'The seller service'],
      };
    else reply = decision('product_assessment', { subjectRef: null });
    return { text: JSON.stringify(reply), tokens: 12 };
  }
  const service = new GeminiService(
    { GEMINI_API_KEY: 'labelled-local-fixture', GEMINI_MODEL: 'gemini-fixture-only' },
    token,
    async () => {
      throw Error('Explanation not expected in routing fixture');
    },
    8000,
    undefined,
    undefined,
    undefined,
    generate,
  );
  const screenshot = async (label) => {
    const f = r.name + '-' + width + '-' + label + '.png';
    await s.panel.screenshot({ path: join(out, f) });
    r.screens.push(f);
  };
  try {
    api = makeApi(undefined, service);
    api.listen(4317, '127.0.0.8');
    await once(api, 'listening');
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, start, {
      apiHost: '127.0.0.8',
      prepare: async (p) => {
        await p.setRequestInterception(true);
        p.on('request', (q) => {
          const u = new URL(q.url());
          if (u.origin !== fixture.origin || /\.(?:exe|msi|zip|dmg)$/i.test(u.pathname)) {
            r.fileAttempts.push(u.hostname + u.pathname);
            void q.abort().catch(() => {});
          } else void q.continue().catch(() => {});
        });
      },
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const loaded = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    );
    assert(loaded?.enabled && resolve(loaded.path) === bundle);
    r.loaded = { id: loaded.id, path: loaded.path };
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    if (name !== 'offline') await pair(s, token, r);
    if (name === 'clarify') {
      const original = 'Assess this listing without substituting another edition.';
      await submit(s.panel, original);
      const question = await until(async () => {
        const t = await turn(s);
        return t?.state === 'clarifying' && t;
      }, 'one short clarification');
      assert.equal(question.original, original);
      assert.equal(question.choices.length, 2);
      await screenshot('clarify');
      await button(s.panel, 'The product reviews').click();
      const product = await until(async () => {
        const v = await state(s);
        return v.shopping?.product?.data && v;
      }, 'current product capture');
      const active = await turn(s);
      assert.equal(active.feature, 'product_assessment');
      assert.equal(active.state, 'completed');
      assert.equal(r.calls.length, 2);
      assert(r.calls[1].text.includes(original) && r.calls[1].text.includes('The product reviews'));
      assert(!product.shopping.seller?.data);
      assert.equal(active.operationId, product.shopping.product.data.binding.operationId);
      await screenshot('product');
      record(
        r,
        'S8-R02',
        'A clarification button retained the original excluded substitution and dispatched only the current product review, bound to its real content-read operation.',
      );
    } else if (name === 'invalid') {
      await submit(s.panel, 'Assess the published opinion on this listing.');
      await until(
        async () => ['unavailable', 'error'].includes((await turn(s))?.state),
        'unknown subject rejected',
      );
      assert.equal(r.calls.length, 1);
      assert(!(await state(s)).shopping?.product?.data);
      await submit(s.panel, 'sessionid=PRIVATE_TEST_VALUE');
      const msg = await until(async () => {
        const t = await turn(s);
        return t?.state === 'clarifying' && t;
      }, 'private request excluded');
      assert.equal(r.calls.length, 1);
      assert(!JSON.stringify((await state(s)).chat).includes('PRIVATE_TEST_VALUE'));
      await screenshot('invalid');
      record(
        r,
        'S8-R04',
        'The model response named a fabricated subject ref. No product read or action followed. Private input was rejected before a second routing call and redacted from history.',
      );
    } else if (name === 'cancel') {
      behaviour = 'hold';
      await submit(s.panel, 'Examine the product evidence on this page.');
      await until(() => release, 'pending labelled request');
      await button(s.panel, 'Stop').click();
      await until(
        async () => (await turn(s))?.state === 'paused',
        'direct Stop retired the request',
      );
      await until(() => aborted, 'actual in-flight connector aborted');
      release();
      assert(!(await state(s)).shopping?.product?.data);
      behaviour = 'product';
      await submit(s.panel, 'Inspect the catalog feedback for this listing.');
      await until(async () => (await turn(s))?.state === 'completed', 'replacement completed');
      assert.equal(r.calls.length, 2);
      behaviour = 'hold';
      release = undefined;
      aborted = false;
      await submit(s.panel, 'Look into those product opinions again.');
      await until(() => release, 'third request pending');
      await clear(s);
      await until(() => aborted, 'new chat retired in-flight request');
      release();
      await wait(150);
      assert(!(await state(s)).chat?.turns.length);
      await screenshot('cleared');
      record(
        r,
        'S8-S02',
        'An explicit Stop retired the original route before a corrected request. The replacement used its own operation and conversation turn.',
      );
      record(
        r,
        'S8-S03',
        'Stop and New chat aborted pending protected requests, and late fixture responses could not add cards or replay actions.',
      );
    } else if (name === 'isolate') {
      await submit(s.panel, 'Check this product');
      await until(async () => (await state(s)).shopping?.product?.data, 'initial product');
      behaviour = 'hold';
      await submit(s.panel, 'Tell me about the reviews for that product.');
      await until(() => release, 'bound request pending');
      assert(r.calls.at(-1).subjects.includes('product'));
      await s.page.click('#variant');
      release();
      await until(async () => {
        const v = await state(s);
        return (
          !v.shopping?.product?.data &&
          v.chat?.turns.some((t) => t.state === 'stale' || t.historical)
        );
      }, 'edition change retired stale result');
      await wait(250);
      assert(!(await state(s)).shopping?.product?.data);
      const other = await s.browser.newPage();
      await other.goto(fixture.origin + '/settings-lab');
      await other.bringToFront();
      await s.activate(other);
      await until(async () => !(await state(s)).chat?.turns.length, 'separate tab chat');
      await screenshot('new-tab');
      await other.close();
      await s.page.bringToFront();
      record(
        r,
        'S8-A02',
        'A genuine edition switch during a held route retired the earlier catalog subject. A second tab had no previous turns and opening it did not replay the earlier read.',
      );
    } else if (name === 'goal-history') {
      await s.page.goto(fixture.origin + '/settings-lab');
      await s.activate(s.page);
      const firstGuide = await startLocalGuide(s);
      assert.equal(r.calls.length, 0, 'the prior guide used only the local Help controls');
      await clear(s);
      const afterClear = await state(s);
      const fresh = afterClear.chat.id;
      assert.notEqual(fresh, firstGuide.conversation);
      assert(!afterClear.task || afterClear.task.state === 'cancelled', 'New chat stopped its real navigation task');
      const request = 'Describe what I can inspect on this public page.';
      await submit(s.panel, request);
      await until(async () => (await turn(s))?.state === 'unsupported', 'fresh fixture route finished');
      assert.equal(r.calls.length, 1);
      assert.equal(r.calls[0].text, request);
      const clean = r.goalBoundaries[0];
      assert.equal(clean.conversation, fresh);
      assert.equal(clean.site.path, '/settings-lab');
      assert(!clean.subjectKinds.includes('goal') && !clean.previousGoalInSubjects, 'cleared task was excluded from subjects');
      assert(!clean.previousGoalInHistory && clean.historyCount === 0, 'New chat supplied no old history');
      await screenshot('after-new-chat');
      const secondGuide = await startLocalGuide(s);
      assert.notEqual(secondGuide.task, firstGuide.task);
      assert.equal(secondGuide.conversation, fresh);
      await s.page.goto(start);
      await s.activate(s.page);
      const nextRequest = 'Describe the available evidence for this listing.';
      await submit(s.panel, nextRequest);
      const next = await until(async () => {
        const t = await turn(s);
        return t?.state === 'unsupported' && t.original === nextRequest && t;
      }, 'new document fixture route finished');
      assert.equal(r.calls.length, 2);
      assert.equal(r.calls[1].text, nextRequest);
      assert(next.documentId && next.documentId !== secondGuide.document);
      const moved = r.goalBoundaries[1];
      assert.equal(moved.site.path, '/shopping-lab/listing');
      assert(!moved.subjectKinds.includes('goal') && !moved.previousGoalInSubjects, 'previous-document task was excluded from subjects');
      assert(!moved.previousGoalInHistory && moved.historyCount === 0, 'new document carried no previous-page turns');
      await screenshot('after-page-change');
      record(r, 'S8-A02', 'Actual Show me guide on the Username fixture was excluded from the next labelled route after moving the same tab to a new listing document. The route carried no goal subject or old-document history.');
      record(r, 'S8-S05', 'After the local guide started, New chat created a fresh conversation. The next protected fixture request had no goal subject or conversation history on the same page.');
    } else {
      await submit(s.panel, 'Describe the published feedback on this catalog item.');
      await until(async () => (await turn(s))?.state === 'unavailable', 'unpaired UI');
      assert.equal(r.calls.length, 0);
      await submit(s.panel, 'Check this product');
      await until(async () => (await state(s)).shopping?.product?.data, 'local shortcut works');
      assert.equal(r.calls.length, 0);
      await screenshot('local');
      record(
        r,
        'S8-S04',
        'Unpaired free text reported unavailable. The local product shortcut displayed real fixture evidence without a model request.',
      );
    }
    assert(!service.chatHealth().verified);
    assert.equal(r.fileAttempts.length, 0);
    assert.equal(r.downloads, 0);
    assert.equal(await s.page.$eval('#transactions', (e) => e.textContent), '0');
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message).slice(0, 360);
    if (s) {
      r.visible = await s.panel
        .evaluate(() => document.body.innerText.slice(0, 1800))
        .catch(() => null);
      await screenshot('failure').catch(() => {});
    }
  } finally {
    release?.();
    if (s) await s.browser.close();
    if (api) {
      api.closeAllConnections();
      await new Promise((ok) => api.close(ok));
    }
    results.push(r);
    await writeFile(
      join(
        out,
        'run-routing-fixture-' +
          selected.join('-') +
          '-' +
          (process.env.SAFESTEP_WIDTH ?? 'both') +
          '.json',
      ),
      JSON.stringify(
        {
          role: 'builder',
          sha256,
          bundle,
          runAt,
          provider: 'Labelled local routing transport; no live Gemini',
          results,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(r.status, r.name, r.width, r.error ?? '');
  }
}
try {
  for (const w of [1440, 1366])
    if (!process.env.SAFESTEP_WIDTH || Number(process.env.SAFESTEP_WIDTH) === w)
      for (const name of selected) await run(name, w);
} finally {
  fixture.server.close();
}
if (!results.length || results.some((r) => r.status !== 'pass')) process.exitCode = 1;
