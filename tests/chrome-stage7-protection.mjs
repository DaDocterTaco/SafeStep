import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { amazonPractice } from './support/stage7-amazon-fixture.mjs';
import { runPrecedence, simulatedAmazon } from './support/stage7-protection-precedence.mjs';
import {
  fixtureOrigin,
  interceptFixture,
  protectionFixture,
} from './support/stage7-protection-fixture.mjs';

const runFile = promisify(execFile),
  bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3'),
  { sha256 } = await fingerprint(bundle);
const dir = resolve('.test-artifacts/stage7-protection', sha256.slice(0, 12));
await mkdir(dir, { recursive: true });
const results = [],
  sizes = process.env.SAFESTEP_WIDTH ? [Number(process.env.SAFESTEP_WIDTH)] : [1440, 1366];
const names = (
  process.env.SAFESTEP_S7_PROTECT_CASES ??
  'arrival,amazon,lifecycle,warningRace,sourceEdges,amazonFixture,precedence'
).split(',');
const practice = names.some((name) => name === 'amazonFixture' || name === 'precedence') ? await startFixture(0) : null;
const trial = process.env.SAFESTEP_S7_TRIAL ?? '';
assert(/^[a-zA-Z0-9-]{0,50}$/.test(trial));
const wait = async (fn, why, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(100);
  }
  throw Error('Timed out: ' + why);
};
const button = (p, label) => p.locator('::-p-aria(' + label + '[role="button"])');
async function area(p, label) {
  await p.locator('::-p-aria(' + label + '[role="tab"])').click();
}
async function permission(s, choice) {
  await button(s.panel, 'Apply protection settings').click();
  await runFile(
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
async function close(s) {
  await s.panel
    .evaluate(async () => {
      const t = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      await chrome.sidePanel.close({ windowId: t.windowId });
    })
    .catch(() => {});
  await wait(
    async () =>
      !(await s.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
        t.url.endsWith(s.id + '/sidepanel.html'),
      ),
    'native panel closed',
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
}
async function record(s, r, label) {
  const f = r.name + '-' + r.width + '-' + label + (trial ? '-' + trial : '') + '.png';
  await s.page.screenshot({ path: join(dir, f) });
  r.screens.push(f);
}
async function clickWarning(s, label) {
  const client = await s.page.createCDPSession();
  try {
    await client.send('Accessibility.enable');
    const node = await wait(
      async () => {
        const { nodes } = await client.send('Accessibility.getFullAXTree');
        const root = nodes.find(
          (n) => n.role?.value === 'complementary' && n.name?.value === 'SafeStep warning',
        );
        if (!root) return null;
        const byId = new Map(nodes.map((n) => [n.nodeId, n])),
          pending = [root],
          found = [];
        while (pending.length) {
          const n = pending.pop();
          if (
            (n.role?.value === 'button' || n.role?.value?.startsWith('DisclosureTriangle')) &&
            n.name?.value === label &&
            n.backendDOMNodeId
          )
            found.push(n);
          for (const child of n.childIds ?? []) {
            const item = byId.get(child);
            if (item) pending.push(item);
          }
        }
        return found.length === 1 ? found[0] : null;
      },
      'painted SafeStep warning ' + label,
      5000,
    );
    await s.page.bringToFront();
    await client.send('DOM.focus', { backendNodeId: node.backendDOMNodeId });
    await s.page.keyboard.press('Enter');
  } finally {
    await client.detach();
  }
}
async function run(name, width) {
  const r = {
    name,
    width,
    status: 'fail',
    checks: [],
    caseChecks: [],
    screens: [],
    requests: [],
    observations: [],
  };
  let s, observer;
  const synthetic = ['sourceEdges', 'warningRace', 'precedence'].includes(name);
  const publicURL =
    name === 'amazonFixture'
      ? practice.origin + '/shopping-lab/amazon-us'
      : name === 'precedence'
        ? simulatedAmazon + '/setup'
      : synthetic
        ? fixtureOrigin + '/setup'
        : name === 'amazon'
          ? 'https://www.amazon.com/'
          : name === 'arrival'
            ? 'https://www.wayfair.com/terms'
            : 'https://example.org/';
  try {
    const setup = new URL(name === 'arrival' ? 'https://example.org/' : publicURL);
    if (name !== 'amazonFixture') setup.searchParams.set('safestep_setup', 'private');
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, setup.href, {
      attachWorker: true,
      ...(synthetic ? { prepare: name === 'precedence'
        ? (page) => interceptFixture(page, simulatedAmazon, practice.origin)
        : interceptFixture } : {}),
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const loaded = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (x) => x.id === s.id,
    );
    assert(loaded.enabled && resolve(loaded.path) === bundle);
    r.loaded = { id: s.id, path: loaded.path };
    const target = await s.browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes(s.id),
    );
    const worker = await target.worker();
    observer=worker;
    await worker.evaluate(()=>{
      const trace=[];globalThis.qaProtectionMessages=trace;
      chrome.storage.onChanged.addListener((changes,area)=>{
        if(area!=='session')return;
        for(const [key,val] of Object.entries(changes)){
          if(!key.startsWith('auto-check:'))continue;
          const v=val.newValue;
          trace.push({event:'receipt',key,doc:v?.doc,status:v?.status,revision:v?.revision,dismissed:v?.dismissed});
        }
      });
      chrome.runtime.onMessage.addListener((msg,sender)=>{
        if(msg?.channel==='protection-page')trace.push({event:'page',op:msg.op,revision:msg.revision,doc:sender.documentId,frame:sender.frameId,tab:sender.tab?.id});
      });
    });
    if (name === 'amazonFixture') {
      r.method =
        'Strictly synthetic loopback marketplace. No Amazon network requests or live seller verification.';
      await amazonPractice({ s, r, wait, button, area, record });
      r.status = 'pass';
      return;
    }
    await worker.client.send('Network.enable');
    worker.client.on('Network.requestWillBeSent', (e) => {
      const u = new URL(e.request.url);
      if (u.pathname === '/v1/merchant/check')
        r.requests.push({
          domain: JSON.parse(e.request.postData ?? '{}'),
          method: e.request.method,
          service: u.origin,
        });
    });
    if (synthetic) {
      r.method = 'Labelled HTML + controlled provider transport in the installed Chrome extension';
      if (name === 'precedence') {
        r.method = 'Synthetic known-marketplace URL, controlled complaint rows normalized by the real MerchantService, and the separately invoked labelled local homepage-threat fixture. No Amazon requests or live threat provider.';
        await runPrecedence({ s, r, worker, area, button, wait, permission, record, lab: practice.origin });
        r.status = 'pass';
        return;
      }
      await protectionFixture({
        s,
        r,
        name,
        worker,
        area,
        button,
        wait,
        permission,
        record,
        clickWarning,
      });
      r.status = 'pass';
      return;
    }
    r.method =
      name === 'amazon'
        ? 'Actual Amazon US page and local identity'
        : 'Actual public regulator service and public website';
    await area(s.panel, 'Settings');
    if (name === 'arrival' || name === 'lifecycle') {
      const token = (await readFile('apps/api/.env.safestep-session', 'utf8')).trim();
      await s.panel.locator('summary::-p-text(Connect local AI)').click();
      await s.panel.type('input[type=password]', token);
      await button(s.panel, 'Connect').click();
      await s.panel.waitForFunction(() => /Connected(?:\.| to )/.test(document.body.innerText));
    }
    const sel = await s.panel.waitForSelector('[aria-label="Auto protection settings"] select');
    assert.equal(await sel.evaluate((e) => e.value), 'off');
    const optIn = name === 'arrival' ? 'all' : 'selected';
    await sel.select(optIn);
    if (name !== 'amazon')
      await s.panel.locator('::-p-aria(Look up outside merchant reports[role="checkbox"])').click();
    await permission(s, 'Allow');
    await wait(async () => {
      const v = (await view(s.panel)).v;
      return v.prefs.protection?.scope === optIn && v.protection?.status === 'private';
    }, 'private setup excluded');
    assert.equal(r.requests.length, 0);
    if (name === 'lifecycle') {
      await sel.select('all');
      await permission(s, 'Deny');
      assert.equal((await view(s.panel)).v.prefs.protection.scope, 'selected');
      r.checks.push(
        'Selected-site mode remained after Chrome denied the optional blanket host grant.',
      );
    }
    await close(s);
    await s.page.goto(publicURL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const tabId = await worker.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
    );
    const receipt = () =>
      worker.evaluate(
        async (id) => (await chrome.storage.session.get('auto-check:' + id))['auto-check:' + id],
        tabId,
      );
    const c = await wait(
      async () => {
        const a = await receipt();
        return a && a.status !== 'checking' && a.status !== 'private' && a;
      },
      'arrival check completed with panel closed',
      45000,
    );
    assert.equal(c.origin, new URL(s.page.url()).origin);
    r.observations.push(c);
    assert(
      !(await s.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
        t.url.endsWith(s.id + '/sidepanel.html'),
      ),
    );
    const badge = await worker.evaluate(
      async (id) => chrome.action.getBadgeText({ tabId: id }),
      tabId,
    );
    r.badge = badge;
    if (name === 'amazon') {
      assert.equal(c.identity, 'amazon_us');
      assert.equal(c.caution, false);
      assert.equal(c.status, 'local');
      assert.equal(await s.page.$('[data-safestep-protection]'), null);
      await reopen(s);
      await area(s.panel, 'Shopping');
      await s.panel.waitForSelector('[aria-label="Amazon US seller"]');
      assert(
        (await s.panel.$eval('[aria-label="Amazon US seller"]', (e) => e.innerText)).includes(
          'Exact seller feedback is unavailable',
        ),
      );
      r.checks.push(
        'Actual Amazon HTTPS address was quietly recognized on arrival; seller availability remained a distinct unsupported source.',
      );
      r.caseChecks.push('S7-X18');
    } else if (name === 'arrival') {
      assert.equal(c.status, 'reports', c.outside);
      assert(c.caution && c.sources.length > 1);
      assert.equal(badge, '!');
      assert(
        r.requests.length === 1 &&
          Object.keys(r.requests[0].domain).join(',') === 'domain' &&
          r.requests[0].domain.domain === c.host,
      );
      await s.page.waitForSelector('[data-safestep-protection]');
      await record(s, r, 'warning-closed-panel');
      const client = await s.page.createCDPSession();
      await client.send('Accessibility.enable');
      const ax = await client.send('Accessibility.getFullAXTree');
      const dismissalName=ax.nodes.some(n=>n.name?.value==='Dismiss warning')?'Dismiss warning':'Dismiss';
      const detailLabel=ax.nodes.some(n=>n.name?.value==='Details')?'Details':'View reasons';
      for (const text of [detailLabel, dismissalName, 'Leave page'])
        assert(
          ax.nodes.some(
            (n) =>
              (n.role?.value === 'button' || n.role?.value==='link' || n.role?.value?.startsWith('DisclosureTriangle')) &&
              n.name?.value === text,
          ),
          'page warning button ' + text,
        );
      await clickWarning(s, detailLabel);
      const rendered = await client.send('Accessibility.getFullAXTree');
      r.warningControls = rendered.nodes
        .filter((n) =>
          [detailLabel, 'SafeStep warning', dismissalName, 'Leave page'].includes(n.name?.value),
        )
        .map((n) => ({
          role: n.role?.value,
          name: n.name?.value,
          expanded: n.properties?.find((p) => p.name === 'expanded')?.value?.value,
        }));
      await record(s, r, 'warning-reasons-rendered');
      await wait(
        async () => {
          const tree = await client.send('Accessibility.getFullAXTree');
          return tree.nodes.some(
            (n) => n.role?.value === 'link' && /^Complaint /.test(n.name?.value ?? ''),
          );
        },
        'regulator complaint sources exposed in the actual page warning',
        6000,
      );
      await record(s, r, 'warning-sources');
      const checked = await receipt();
      r.observations.push(checked);
      assert.equal(checked.doc, c.doc);
      assert.equal(checked.host, new URL(s.page.url()).hostname);
      assert.equal(checked.status, 'reports');
      assert(
        !(await s.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
          t.url.endsWith(s.id + '/sidepanel.html'),
        ),
      );
      await clickWarning(s, dismissalName);
      await s.page.waitForSelector('[data-safestep-protection]', { hidden: true, timeout: 6500 });
      const dismissed = await wait(async () => {
        const v = await receipt();
        return v?.doc === checked.doc && v.dismissed && v;
      }, 'live local dismissal recorded');
      r.observations.push(dismissed);
      r.checks.push(
        'With no side-panel context, a new granted top document sent only its hostname to the paired service. Two or more exact-business regulator records produced a warning. The real View reasons button exposed attributed complaint links on that document.',
      );
      r.caseChecks.push('S7-X11', 'S7-X13');
    } else {
      assert(r.requests.some((req) => req.domain.domain === c.host));
      assert.equal(c.status, 'no_match', c.outside);
      assert.equal(c.caution, false);
      assert(c.sources.some((x) => x.url.startsWith('https://data.wa.gov/')));
      await s.page.evaluate(() => history.pushState({}, '', '/account/?token=PRIVATE_TEST_ONLY'));
      const priv = await wait(async () => {
        const a = await receipt();
        return a?.status === 'private' && a;
      }, 'private SPA route');
      assert.equal(priv.doc, c.doc);
      assert.equal(r.requests.length, 1);
      await reopen(s);
      const revoked = await s.panel.evaluate(
        async (origin) => chrome.permissions.remove({ origins: [origin + '/*'] }),
        new URL(s.page.url()).origin,
      );
      assert(revoked);
      await wait(
        async () => !(await view(s.panel)).v.protection,
        'revocation clears automatic status',
      );
      assert(
        r.requests.every(
          (v) => Object.keys(v.domain).join(',') === 'domain' && v.domain.domain === 'example.org',
        ),
      );
      r.checks.push(
        'SPA change to a tokenized account route fenced the old same-document evidence; Chrome revocation cleared coverage without another outside query.',
      );
    }
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message).slice(0, 380);
    if(observer)r.receiptTrace=await observer.evaluate(()=>globalThis.qaProtectionMessages?.slice(-35)).catch(()=>null);
    if (s) {
      const u = new URL(s.page.url());
      r.finalPage = { origin: u.origin, path: u.pathname.slice(0, 100) };
      const v = await view(s.panel).catch(() => null);
      if (v)
        r.lastPanel = {
          host: v.v.origin,
          access: v.v.access,
          setting: v.v.prefs.protection?.scope,
          protection: v.v.protection?.status,
          task: v.v.task?.state,
          taskMessage: v.v.task?.adaptive?.status,
        };
    }
    if (/net::ERR_|Navigation timeout/.test(r.error) && !r.loaded) r.status = 'blocked';
  } finally {
    if (s) await s.browser.close();
    results.push(r);
    console.log(r.status, name, width, r.error ?? '');
    await writeFile(
      join(
        dir,
        ['run', names.join('-'), process.env.SAFESTEP_WIDTH ?? 'both', trial]
          .filter(Boolean)
          .join('-') + '.json',
      ),
      JSON.stringify(
        { role: 'builder', bundle, sha256, at: new Date().toISOString(), results },
        null,
        2,
      ),
    );
  }
}
for (const w of sizes) for (const name of names) await run(name, w);
practice?.server.close();
if (results.some((x) => x.status !== 'pass')) process.exitCode = 1;
