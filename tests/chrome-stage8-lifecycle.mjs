// Native builder checks, entirely local. The public-domain routes are labelled synthetic pages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
assert.match(JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')).version, /^0\.8\./);
const trial = process.env.SAFESTEP_S8_TRIAL ?? 'builder';
assert.match(trial, /^[a-z0-9-]{1,40}$/);
const folder = resolve('.test-artifacts/stage8', sha256.slice(0, 12), trial);
await mkdir(folder, { recursive: true });
const lab = await startFixture(0),
  results = [],
  started = new Date().toISOString(),
  exec = promisify(execFile);
const apiHost = '127.0.0.7',
  localRequests = [];
const service = createServer((req, res) => {
  localRequests.push({ method: req.method, path: new URL(req.url, 'http://localhost').pathname });
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end('{"status":"unavailable"}');
});
service.listen(4317, apiHost);
await once(service, 'listening');
const fixtureHosts = [
  'granted-lifecycle.example.org',
  'other-lifecycle.example.org',
  'amazon.com.merchant-lifecycle.example.org',
  'developer.mozilla.org',
  'en.wikipedia.org',
];
const html = await readFile(new URL('./fixtures/cleanup-lab.html', import.meta.url), 'utf8');
const wiki = await readFile(new URL('./fixtures/guidance.html', import.meta.url), 'utf8');
const fixtureBase = 'https://' + fixtureHosts[0],
  otherBase = 'https://' + fixtureHosts[1],
  warningHost = fixtureHosts[2];
const mdn =
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array';
const mdnGoals = [
  'Find the Array.map examples on MDN and skip the citation section.',
  'Help me find the HTML cite element on MDN.',
  'Find the Array.map examples on MDN and skip the footnotes.',
];
const names = ['permissions', 'controls', 'warning', 'recovery', 'ss7'];
const selected = (process.env.SAFESTEP_S8_LIFECYCLE ?? names.join(',')).split(',');
assert(selected.length && selected.every((n) => names.includes(n)));
const widths = process.env.SAFESTEP_WIDTH ? [Number(process.env.SAFESTEP_WIDTH)] : [1440, 1366];
assert(widths.every((w) => w === 1440 || w === 1366));
const starts = {
  permissions: fixtureBase + '/public',
  controls: lab.origin + '/settings-lab',
  warning: 'https://' + warningHost + '/cleanup-lab',
  recovery: lab.origin + '/cleanup-lab',
  ss7: mdn,
};
const out = join(
  folder,
  'lifecycle-' + selected.join('-') + '-' + (process.env.SAFESTEP_WIDTH ?? 'both') + '.json',
);
const button = (p, n) => p.locator('::-p-aria(' + n + '[role="button"])').setTimeout(8000);
const v = async (s) => (await view(s.panel)).v;
const active = async (s) => {
  const x = await v(s);
  return x.chat?.turns.find((t) => t.id === x.chat.activeTurnId);
};
function record(r, ids, detail) {
  for (const id of ids.split(' ')) (r.caseChecks[id] ??= []).push(detail);
}
async function until(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const answer = await fn();
    if (answer) return answer;
    await sleep(100);
  }
  throw Error('Timed out: ' + label);
}
async function shot(s, r, label, page = false) {
  const file =
    'lifecycle-' + r.name + '-' + r.width + '-' + label + (page ? '-page' : '-panel') + '.png';
  await (page ? s.page : s.panel).screenshot({ path: join(folder, file) });
  r.screens.push(file);
}
async function submit(p, text) {
  await p.focus('#chat-composer');
  await p.keyboard.down('Control');
  await p.keyboard.press('a');
  await p.keyboard.up('Control');
  await p.keyboard.type(text);
  await p.keyboard.press('Enter');
}
async function feature(s, id) {
  async function find() {
    const items = await s.panel.$$('[data-feature="' + id + '"]');
    for (const item of items) if (await item.evaluate((e) => e.checkVisibility())) return item;
    return null;
  }
  let el = await find();
  if (!el) {
    await button(s.panel, 'Help').click();
    el = await until(find, 'Help feature ' + id);
  }
  await el.click();
}
async function newChat(s) {
  await button(s.panel, 'Settings').click();
  const summary = await s.panel.$('summary::-p-text(Reading and conversation)');
  if (!(await summary.evaluate((e) => e.parentElement.open))) await summary.click();
  await button(s.panel, 'New chat').click();
  await until(async () => ((await v(s)).chat?.turns.length ?? 0) === 0, 'cleared conversation');
}
async function permission(s, choice) {
  await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('tests/support/permission.ps1'),
      '-BrowserProcessId',
      String(s.browser.process().pid),
      '-Choice',
      choice,
    ],
    { windowsHide: true, timeout: 15000 },
  );
}
async function closePanel(s) {
  await s.panel
    .evaluate(async () =>
      chrome.sidePanel.close({ windowId: (await chrome.windows.getCurrent()).id }),
    )
    .catch(() => {});
  await until(
    () =>
      !s.browser
        .targets()
        .some((t) => t.url() === 'chrome-extension://' + s.id + '/sidepanel.html'),
    'closed panel',
  );
}
async function reopen(s) {
  await s.page.bringToFront();
  await s.activate(s.page);
  s.panel = await (
    await s.browser.waitForTarget(
      (t) => t.url() === 'chrome-extension://' + s.id + '/sidepanel.html',
    )
  ).asPage();
  await s.panel.waitForSelector('#chat-composer', { visible: true });
}
async function pageSetup(page, r) {
  await page.setRequestInterception(true);
  page.on('request', (q) => {
    const u = new URL(q.url());
    if (
      r.holdNav &&
      u.origin === lab.origin &&
      u.pathname === '/settings-lab/account' &&
      q.isNavigationRequest()
    ) {
      r.automaticRequests++;
      r.held = q;
      return;
    }
    if (
      u.origin === lab.origin ||
      u.protocol === 'chrome:' ||
      u.protocol === 'chrome-extension:' ||
      u.protocol === 'data:'
    ) {
      void q.continue().catch(() => {});
      return;
    }
    if (
      fixtureHosts.includes(u.hostname) &&
      q.isNavigationRequest() &&
      q.frame() === page.mainFrame()
    ) {
      const body =
        u.hostname === 'en.wikipedia.org'
          ? wiki
          : u.hostname === 'developer.mozilla.org'
            ? '<!doctype html><title>Labelled MDN fixture</title><main><h1>Array</h1><p>Local reproduction of the MDN goal-routing surface.</p></main>'
            : html;
      void q.respond({ status: 200, contentType: 'text/html', body });
      return;
    }
    r.interceptedOther.push(u.origin);
    void q.abort().catch(() => {});
  });
}
async function permissions(s, r) {
  const p = s.panel;
  await button(p, 'Settings').click();
  const origin = await p.$eval('.site-access strong', (e) => e.textContent);
  assert.equal(origin, fixtureHosts[0]);
  await button(p, 'Enable on this site').click();
  await permission(s, 'Deny');
  await until(async () => (await v(s)).issue === 'permission_denied', 'denial recorded');
  const has = () =>
    p.evaluate(
      async (host) => chrome.permissions.contains({ origins: ['https://' + host + '/*'] }),
      fixtureHosts[0],
    );
  assert.equal(await has(), false);
  await shot(s, r, 'permission-denied');
  await button(p, 'Enable on this site').click();
  await permission(s, 'Allow');
  await until(async () => (await v(s)).access === 'site', 'granted origin');
  assert(await has());
  await button(p, 'Remove site access').click();
  await until(
    async () => !(await has()) && (await v(s)).issue === 'permission_revoked',
    'revoked persistent origin',
  );
  await button(p, 'Close Settings').click();
  await s.page.goto(otherBase + '/account/private', { waitUntil: 'domcontentloaded' });
  await until(
    async () => ['permission_required', 'permission_revoked'].includes((await v(s)).access),
    'cross-origin grant not inherited',
  );
  await submit(p, 'Check this website');
  await until(
    async () => (await active(s))?.state === 'awaiting_access',
    'chat requests explicit access',
  );
  assert(!(await v(s)).review);
  await s.activate(s.page);
  await until(async () => (await v(s)).access === 'temporary', 'second-site temporary invocation');
  await submit(p, 'Summarize the account details on this page.');
  await until(
    async () => (await active(s))?.state === 'unavailable',
    'private route withheld from AI',
  );
  await shot(s, r, 'private');
  await s.page.goto('chrome://version', { waitUntil: 'domcontentloaded' });
  await s.activate(s.page);
  await until(async () => (await v(s)).access === 'unsupported_page', 'restricted Chrome page');
  assert(!(await v(s)).snapshot);
  record(
    r,
    'S8-A05',
    'Actual named site permission declined, granted and revoked through the native Chrome prompt; cross-origin permission was not inherited, the private page was withheld from routing and chrome://version remained unavailable.',
  );
}
async function controls(s, r) {
  const p = s.panel;
  await submit(p, 'Find my username settings');
  await until(
    async () => (await v(s)).task?.state === 'awaiting_confirmation',
    'unapproved local task',
  );
  await button(p, 'Show me').click();
  await until(async () => (await v(s)).task?.state === 'showing_step', 'guide shows first cue');
  const one = (await v(s)).task.id;
  await button(p, 'Pause').click();
  await until(async () => (await v(s)).task?.state === 'paused', 'paused immediately');
  assert(!(await v(s)).task.adaptive.authorized);
  await button(p, 'Stop').click();
  await until(async () => (await v(s)).task?.state === 'cancelled', 'explicit stop');
  await submit(p, 'Find my username settings');
  await until(async () => {
    const t = (await v(s)).task;
    return t?.id !== one && t?.state === 'awaiting_confirmation';
  }, 'new task');
  await button(p, 'Take me there').click();
  assert(!(await v(s)).task.adaptive.authorized);
  r.holdNav = true;
  try {
    await button(p, 'Start automatic').click();
    await until(() => r.held, 'product-issued pending navigation');
    await button(p, 'Take over').click();
    await until(async () => {
      const task=(await v(s)).task;
      return task?.state==='paused' && task.mode==='guide' && !task.adaptive.authorized;
    }, 'takeover of pending automatic task');
    await button(p, 'Stop').click();
    await until(
      async () => (await v(s)).task?.state === 'cancelled',
      'stopped in-flight auto',
      6000,
    );
  } finally {
    r.holdNav = false;
    if (r.held) {
      await r.held.abort().catch(() => {});
      delete r.held;
    }
  }
  await sleep(400);
  assert.equal((await v(s)).task.state, 'cancelled');
  assert.equal(r.automaticRequests, 1);
  const old = (await v(s)).chat.id;
  const other = await s.browser.newPage();
  await pageSetup(other, r);
  await other.goto(otherBase + '/public');
  await other.bringToFront();
  await s.activate(other);
  await until(async () => !(await v(s)).chat?.turns.length, 'tab-local history');
  await submit(p, 'Check this address');
  const turn = await until(async () => {
    const a = await active(s);
    return a?.state === 'completed' && a;
  }, 'new tab local address');
  assert(turn.text.includes(fixtureHosts[1]));
  assert.notEqual((await v(s)).chat.id, old);
  await other.close();
  await s.page.bringToFront();
  await until(async () => (await v(s)).chat?.id === old, 'original tab isolated');
  await shot(s, r, 'tab-return');
  record(
    r,
    'S8-A03 S8-A04',
    'Pause, Take over and Stop worked locally. An approved automatic Username navigation made one product-issued page request, was stopped while the response was withheld and remained cancelled. A second tab acquired a distinct chat and did not alter the original.',
  );
}
async function warning(s, r) {
  await button(s.panel, 'Settings').click();
  const select = await s.panel.waitForSelector('[aria-label="Auto protection settings"] select');
  await select.select('selected');
  await button(s.panel, 'Apply protection settings').click();
  await permission(s, 'Allow');
  await until(
    async () => (await v(s)).prefs.protection?.scope === 'selected',
    'selected protection',
  );
  await button(s.panel, 'Close Settings').click();
  await s.page.goto('https://' + warningHost + '/next', { waitUntil: 'domcontentloaded' });
  const warning = await until(async () => {
    const p = (await v(s)).protection;
    return p?.caution && !p.dismissed && p;
  }, 'labelled impostor warning');
  assert.equal(warning.host, warningHost);
  await s.page.waitForSelector('[data-safestep-protection]');
  await submit(s.panel, 'Check this address');
  await until(async () => (await active(s))?.state === 'completed', 'completed local address');
  await feature(s, 'page_cleanup');
  await until(async () => (await v(s)).cleanup?.items?.length, 'cleanup preview');
  await button(s.panel, 'Apply cleanup').click();
  const clean = await until(async () => {
    const z = (await v(s)).cleanup;
    return z?.hidden > 0 && z;
  }, 'applied harmless promotions');
  // Read only the quota records, never the temporary pairing token or user content.
  const quotas = () =>
    s.panel.evaluate(async () =>
      chrome.storage.session.get(['shop-set-budget', 'auto-check-budget']),
    );
  const before = await quotas();
  await newChat(s);
  const after = await v(s);
  assert.equal(after.protection?.doc, warning.doc);
  assert.equal(after.protection?.revision, warning.revision);
  assert.equal(after.protection?.caution, true);
  assert.equal(after.protection.dismissed, false);
  assert.equal(after.cleanup?.binding.operationId, clean.binding.operationId);
  assert.equal(after.cleanup.hidden, clean.hidden);
  assert.deepEqual(await quotas(), before);
  assert(
    await s.panel.evaluate(() => {
      const log = document.querySelector('[role=log]');
      return [...document.querySelectorAll('[role=alert],aside,section')].some(
        (e) =>
          e.checkVisibility() &&
          !e.contains(log) &&
          !log.contains(e) &&
          /expected Amazon|does not match|actual host/i.test(e.innerText),
      );
    }),
  );
  await shot(s, r, 'preserved-warning');
  await button(s.panel, 'Restore page').click();
  await until(() => s.page.$eval('#ad', (e) => e.checkVisibility()), 'restored promotion');
  assert.equal((await v(s)).protection?.revision, warning.revision);
  record(
    r,
    'S8-S06 S8-U05',
    'Synthetic matched-identity warning stayed pinned outside the transcript after New chat. Chrome retained the original warning, cleanup binding, hidden count, and quota records. Restore revealed the original promotion while the warning persisted.',
  );
}
async function recovery(s, r) {
  const privateValue = await s.page.$eval('#private', (e) => e.value);
  assert.equal(privateValue, 'PRIVATE_CLEAN_FIELD');
  await submit(s.panel, 'Find an unrelated public topic');
  await until(async () => (await active(s))?.state === 'unavailable', 'keyless history entry');
  const id = (await v(s)).chat.id;
  await feature(s, 'page_cleanup');
  await until(async () => (await v(s)).cleanup?.items?.length, 'cleanup preview');
  await button(s.panel, 'Apply cleanup').click();
  await until(async () => (await v(s)).cleanup?.hidden > 0, 'applied cleanup');
  assert.equal(await s.page.$eval('#ad', (e) => e.checkVisibility()), false);
  await closePanel(s);
  // Poll the browser's target list without opening a debugger session on the worker.
  const idleStart = Date.now();
  await until(
    async () => {
      const { targetInfos } = await s.root.send('Target.getTargets', {
        filter: [{ type: 'service_worker' }],
      });
      return !targetInfos.some((t) => t.url.startsWith('chrome-extension://' + s.id + '/'));
    },
    'actual worker suspension',
    115000,
  );
  r.idleMs = Date.now() - idleStart;
  assert.equal(await s.page.$eval('#ad', (e) => e.checkVisibility()), false);
  await reopen(s);
  const recovered = await until(async () => {
    const x = await v(s);
    return (
      x.chat?.id === id &&
      x.chat.activeTurnId === null &&
      x.chat.turns.some((t) => t.role === 'assistant' && t.historical) &&
      !x.cleanup?.enabled &&
      x
    );
  }, 'woke without replay');
  assert(await s.page.$eval('#ad', (e) => e.checkVisibility()));
  assert(!recovered.task?.adaptive?.authorized);
  const stored = await s.panel.evaluate(async () => {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const raw = (await chrome.storage.session.get('task:' + tab.id))['task:' + tab.id];
    return { chat: raw.chat, cleanup: raw.cleanup ?? null };
  });
  assert.equal(stored.chat.id, id);
  assert.equal(stored.cleanup, null);
  assert(stored.chat.turns.length <= 50);
  assert(!JSON.stringify(stored).includes(privateValue));
  await feature(s, 'page_cleanup');
  await until(async () => (await v(s)).cleanup?.items?.length, 'fresh explicit preview');
  await button(s.panel, 'Apply cleanup').click();
  await until(async () => (await v(s)).cleanup?.hidden > 0, 'fresh applied cleanup');
  await button(s.panel, 'Restore page').click();
  await until(() => s.page.$eval('#ad', (e) => e.checkVisibility()), 'explicit Restore');
  await shot(s, r, 'restored');
  record(
    r,
    'S8-A03 S8-A04 S8-S05',
    'The native side panel closed with real cleanup active. Browser target inspection observed the extension worker absent; reopening preserved bounded chat history as historical and automatically restored owned changes without replay. A fresh Apply and explicit Restore worked after recovery.',
  );
}
async function ss7(s, r) {
  for (const text of mdnGoals) {
    await submit(s.panel, text);
    const turn = await until(async () => {
      const a = await active(s);
      return a?.original === text && a.state === 'unavailable' && a;
    }, 'preserved exact MDN input ' + text);
    assert(!turn.feature || turn.feature === 'visual_guidance');
    assert.equal(new URL(s.page.url()).pathname, new URL(mdn).pathname);
    const x = await v(s);
    assert.equal(x.task, null);
    assert.equal(await s.page.$('[data-safestep-outline]'), null);
    const content = await s.panel.$eval('[role=log]', (e) => e.innerText);
    assert(content.includes(text));
    assert(
      !/Wikipedia · APA citation|VideoLAN · VLC for Windows|Choose one of these two tasks/i.test(
        content,
      ),
    );
  }
  await submit(s.panel, 'Change my password.');
  await until(async () => {
    const a = await active(s);
    return (
      a?.state === 'unsupported' &&
      a.original === 'Change my password.' &&
      a.text.includes('You control changes')
    );
  }, 'manual password handoff');
  await submit(s.panel, 'My password: PRIVATE_STAGE8_SECRET');
  await until(async () => (await active(s))?.state === 'clarifying', 'sensitive input rejected');
  assert(!JSON.stringify((await v(s)).chat).includes('PRIVATE_STAGE8_SECRET'));
  await shot(s, r, 'mdn-offline');
  await s.page.goto('https://en.wikipedia.org/wiki/Phishing', { waitUntil: 'domcontentloaded' });
  await s.activate(s.page);
  await until(async () => (await v(s)).access === 'temporary', 'Wikipedia invocation');
  await feature(s, 'visual_guidance');
  await until(
    async () => (await active(s))?.choices?.includes('Find the APA citation'),
    'explicit local choices',
  );
  await button(s.panel, 'Find the APA citation').click();
  await until(async () => {
    const a = await active(s);
    return a?.feature === 'visual_guidance' && a?.original === 'Find the APA citation';
  }, 'local citation goal');
  await button(s.panel, 'Show me').click();
  await until(
    async () => (await v(s)).task?.guide?.workflow === 'wikipedia_cite_apa',
    'original wiki route',
  );
  await s.page.waitForSelector('[data-safestep-outline]', { timeout: 10000 });
  await shot(s, r, 'wiki-explicit');
  record(
    r,
    'SS7-01 S8-R01 S8-S04',
    'Both exact tester MDN citation goals, the footnotes control and password handoff stayed on the intended page or redacted private input; no unrelated site/task was substituted. The separate explicitly selected Wikipedia APA guide produced a real outline in the labelled Wikipedia fixture.',
  );
}
const operations = { permissions, controls, warning, recovery, ss7 };
function save() {
  return writeFile(
    out,
    JSON.stringify(
      {
        role: 'builder',
        stage: 8,
        bundle,
        sha256,
        started,
        provider: 'No live Gemini; isolated loopback service is a request counter only.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
}
try {
  for (const width of widths)
    for (const name of selected) {
      const r = {
        name,
        width,
        start: starts[name],
        status: 'fail',
        screens: [],
        caseChecks: {},
        interceptedOther: [],
        automaticRequests: 0,
      };
      const at = localRequests.length;
      let s, profile;
      try {
        if (name === 'recovery') profile = await mkdtemp(join(tmpdir(), 'safestep-s8-recovery-'));
        const options = {
          apiHost,
          prepare: (page) => pageSetup(page, r),
          ...(profile ? { userDataDir: profile } : {}),
        };
        s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, starts[name], options);
        r.dimensions = s.dimensions;
        r.chrome = await s.browser.version();
        const extension = (await s.root.send('Extensions.getExtensions')).extensions.find(
          (x) => x.id === s.id,
        );
        assert(extension?.enabled && resolve(extension.path) === bundle);
        r.loaded = { id: s.id, path: extension.path };
        assert.equal(
          await s.panel.evaluate(
            async () =>
              !!(await chrome.storage.session.get('local-ai-session'))['local-ai-session'],
          ),
          false,
        );
        await operations[name](s, r);
        if (profile) {
          // A clean browser exit drops session chat; reuse the exact disposable profile.
          await s.browser.close();
          s = null;
          const resumedOptions={...options,install:async(_browser,root,path)=>{
            const list=(await root.send('Extensions.getExtensions')).extensions;
            const installed=list.find(x=>x.enabled&&resolve(x.path)===bundle);
            r.restartLoad=installed?'existing enabled extension in same profile':'load identified unpacked extension in same profile';
            return installed??await root.send('Extensions.loadUnpacked',{path});
          }};
          s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, starts[name]+'#after-browser-restart', resumedOptions);
          const next = await v(s);
          assert(!next.chat?.turns.length);
          assert(!next.cleanup?.hidden);
          assert(!next.task?.adaptive?.authorized);
          record(
            r,
            'S8-S05 S8-A04',
            'Restarting actual Chrome with the same disposable profile yielded no previous session turns, page modifications, automatic authorization or navigation replay.',
          );
        }
        r.serviceRequests = localRequests.slice(at);
        assert.equal(r.serviceRequests.length, 0, 'no service or external model requests');
        assert(
          !r.interceptedOther.some((x) => x.includes('googleapis.com')),
          'no external model network',
        );
        r.status = 'pass';
      } catch (e) {
        r.error = String(e.message).slice(0, 400);
        if (s) {
          const x = await v(s).catch(() => null);
          r.diagnostic = {
            access: x?.access,
            task: x?.task?.state,
            turn: x?.chat?.turns.at(-1)?.state,
            warning: x?.protection?.identity,
            cleanup: x?.cleanup?.hidden,
          };
          await shot(s, r, 'failure').catch(() => {});
        }
      } finally {
        if (r.held) {
          await r.held.abort().catch(() => {});
          delete r.held;
        }
        if (s) await s.browser.close().catch(() => {});
        if (profile) {
          const actual = await realpath(profile),
            parent = await realpath(tmpdir());
          const child = relative(parent, actual);
          if (child === basename(actual) && /^safestep-s8-recovery-[A-Za-z0-9]+$/.test(child))
            await rm(actual, {
              recursive: true,
              force: true,
              maxRetries: 4,
              retryDelay: 150,
            }).catch(() => {});
        }
        results.push(r);
        await save();
        console.log(r.status, name, width, r.error ?? '');
      }
    }
} finally {
  service.closeAllConnections();
  service.close();
  lab.server.close();
}
if (results.some((r) => r.status !== 'pass')) process.exitCode = 1;
