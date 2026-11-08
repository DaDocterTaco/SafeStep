import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { merchantDataset, merchantProvider, merchantRecordUrl } from '@safestep/contracts';
import { view } from './chrome-cases.mjs';

// Reserved example.org hostname, HTML supplied by the harness before any network visit.
export const fixtureOrigin = 'https://protection-lab.example.org';
export async function interceptFixture(page, origin = fixtureOrigin, loopback = null) {
  await page.setRequestInterception(true);
  page.on('request', (q) => {
    const url = new URL(q.url());
    if (loopback && url.origin === loopback) { void q.continue(); return; }
    if (url.origin !== origin) {
      void q.abort();
      return;
    }
    void q.respond({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Labelled SafeStep protection fixture</title><main>' +
        (origin === fixtureOrigin ? '' : '<h1>Synthetic merchant fixture</h1><p>The test supplies this page and example complaint rows. All merchant incidents shown here are fictional.</p>') +
        '<h1>Reading guide</h1><a href="/reading-room">Reading room</a><aside data-ad-region="advertisement">Practice advertisement</aside></main><script>window.practiceClicks=0;document.querySelector("a").addEventListener("click",()=>window.practiceClicks++);</script>',
    });
  });
}
export async function installTransport(worker) {
  const today = Date.now(),
    date = (n) => new Date(today - n * 86400000).toISOString().slice(0, 10);
  const reports = {
    domain: new URL(fixtureOrigin).hostname,
    status: 'reports',
    severity: 'caution',
    provider: merchantProvider,
    checkedAt: new Date(today).toISOString(),
    expiresAt: new Date(today + 300000).toISOString(),
    summary: 'Two synthetic complaints about service.',
    limitations: ['Labelled test transport, no actual businesses or customer statements.'],
    source: merchantDataset,
    businessId: '123',
    windowStart: date(365),
    rowsInspected: 2,
    distinctComplaints: 2,
    records: ['1', '2'].map((id, i) => ({
      id,
      date: date(i + 1),
      practices: ['Failure To Deliver/Perform'],
      caseStatus: 'Open',
      url: merchantRecordUrl('123', id),
    })),
  };
  await worker.evaluate((reports) => {
    const actual = globalThis.fetch;
    globalThis.protectionTest = {
      mode: 'hold',
      held: false,
      stepHeld: false,
      stepReturned: false,
      domains: [],
      approved: [],
      releaseMerchant: null,
      releaseStep: null,
    };
    globalThis.fetch = async (...args) => {
      const test = globalThis.protectionTest,
        u = new URL(String(args[0])),
        data = JSON.parse(String(args[1]?.body ?? '{}'));
      if (u.origin !== 'http://127.0.0.1:4317') return actual(...args);
      if (u.pathname === '/v1/explain/connect')
        return Response.json(
          {
            provider: 'Gemini',
            model: null,
            credentialPresent: false,
            state: 'not_configured',
            connected: test.mode !== 'expired',
          },
          { status: test.mode === 'expired' ? 403 : 200 },
        );
      if (u.pathname === '/v1/merchant/check') {
        test.domains.push(Object.keys(data).sort().join(',') + '=' + data.domain);
        let mode = test.mode;
        if (test.precedence?.[mode]) {
          const response = test.precedence[mode];
          (test.precedenceReads ??= []).push({mode, domain: data.domain, distinct: response.distinctComplaints});
          return response.domain === data.domain ? Response.json(response) : new Response(null, { status: 400 });
        }
        if (mode === 'hold') {
          test.held = true;
          await new Promise((ok) => (test.releaseMerchant = ok));
          mode = 'reports';
        }
        if (mode === 'expired' || mode === 'offline' || mode === 'quota')
          return Response.json(
            {},
            { status: mode === 'expired' ? 403 : mode === 'offline' ? 503 : 429 },
          );
        if (mode === 'limited')
          return Response.json({
            ...reports,
            status: 'limited',
            severity: 'information',
            summary: '<img src=x onerror=alert(1)> One old synthetic allegation.',
            rowsInspected: 1,
            distinctComplaints: 1,
            records: [reports.records[0]],
          });
        if (mode === 'no_match')
          return Response.json({
            ...reports,
            status: 'no_match',
            severity: 'information',
            summary: 'No exact synthetic subject matches.',
            businessId: null,
            rowsInspected: 0,
            distinctComplaints: 0,
            records: [],
          });
        return Response.json(reports);
      }
      if (u.pathname.startsWith('/v1/assist/')) {
        const text = 'Reading room',
          i = data.goal.indexOf(text);
        let explanation;
        if (data.kind === 'intent')
          explanation = {
            action: 'find_document',
            subjects: [{ start: i, end: i + text.length, text }],
            constraints: [],
            excluded: [],
            question: '',
            choices: [],
          };
        else {
          const target = data.snapshot.controls.find((x) => x.name === text || x.label === text);
          if (!target) throw Error('Expected the observed Reading room control.');
          explanation = {
            kind: 'next_candidate',
            ref: target.ref,
            action: target.action,
            citations: [target.ref],
          };
          test.approved.push(target.action);
          test.stepHeld = true;
          await new Promise((ok) => (test.releaseStep = ok));
          test.stepReturned = true;
        }
        return Response.json({
          operationId: data.operationId,
          bindingToken: data.bindingToken,
          status: 'available',
          explanation,
          elapsedMs: 1,
          tokens: null,
        });
      }
      return actual(...args);
    };
  }, reports);
}
export const pair = (worker, letter) =>
  worker.evaluate(
    async (letter) =>
      chrome.storage.session.set({ 'local-ai-session': 'ss3_' + letter.repeat(43) }),
    letter,
  );
export const change = (worker, values) =>
  worker.evaluate((v) => Object.assign(globalThis.protectionTest, v), values);
const traces = (worker) =>
  worker.evaluate(() => {
    const x = globalThis.protectionTest;
    return {
      held: x.held,
      step: x.stepHeld,
      done: x.stepReturned,
      domains: x.domains,
      approved: x.approved,
    };
  });

export async function protectionFixture({
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
}) {
  await installTransport(worker);
  await pair(worker, 'q');
  await area(s.panel, 'Settings');
  await s.panel.select('[aria-label="Auto protection settings"] select', 'selected');
  await s.panel.locator('::-p-aria(Look up outside merchant reports[role="checkbox"])').click();
  await permission(s, 'Allow');
  await wait(
    async () => (await view(s.panel)).v.protection?.status === 'private',
    'private fixture setup',
  );
  if (name === 'sourceEdges') {
    await s.panel.select('[aria-label="Auto protection settings"] select', 'all');
    await permission(s, 'Deny');
    assert.equal((await view(s.panel)).v.prefs.protection.scope, 'selected');
  }
  await s.page.goto(fixtureOrigin + '/reading-guide', { waitUntil: 'domcontentloaded' });
  await wait(async () => (await traces(worker)).held, 'merchant transport pending');
  const current = async () => (await view(s.panel)).v;
  const noWarning = async () => assert.equal(await s.page.$('[data-safestep-protection]'), null);
  if (name === 'warningRace') {
    await area(s.panel, 'Guide');
    const goal = await s.panel.waitForSelector('#goal');
    await goal.type('Find Reading room');
    await goal.press('Enter');
    await wait(
      async () => (await current()).task?.state === 'awaiting_confirmation',
      'identified fixture intent',
    );
    await button(s.panel, 'Take me there').click();
    await button(s.panel, 'Start automatic').click();
    await wait(async () => {
      const v = await current();
      return v.task?.adaptive?.authorized && (await traces(worker)).step;
    }, 'automatic authorized and planning the actual page link');
    const before = await current();
    assert.equal(before.task.steps, 0);
    await noWarning();
    await worker.evaluate(() => globalThis.protectionTest.releaseMerchant());
    await wait(async () => {
      const v = await current();
      return (
        v.task?.state === 'paused' &&
        !v.task.adaptive.authorized &&
        v.protection?.status === 'reports'
      );
    }, 'actual warning paused authorized task');
    await s.page.waitForSelector('[data-safestep-protection]');
    await worker.evaluate(() => globalThis.protectionTest.releaseStep());
    await wait(async () => (await traces(worker)).done, 'late planner reply delivered');
    await delay(350);
    assert.equal(s.page.url(), fixtureOrigin + '/reading-guide');
    assert.equal(await s.page.evaluate(() => globalThis.practiceClicks), 0);
    const stopped = await current();
    assert.equal(stopped.task.steps, 0);
    assert.equal(stopped.task.state, 'paused');
    await button(s.panel, 'Preview cleanup').click();
    await wait(
      async () => (await current()).cleanup?.items.length,
      'cleanup recognized the practice advertisement',
    );
    await button(s.panel, 'Apply cleanup').click();
    await wait(async () => (await current()).cleanup?.hidden >= 1, 'advertisement hidden');
    assert(
      await s.page.$eval(
        '[data-safestep-protection]',
        (e) => e.checkVisibility() && e.getBoundingClientRect().height > 0,
      ),
    );
    assert.equal((await current()).protection.revision, stopped.protection.revision);
    await button(s.panel, 'Restore cleanup').click();
    await wait(async () => (await current()).cleanup?.hidden === 0, 'cleanup restored');
    await record(s, r, 'active-warning');
    r.observations.push({
      before: { state: before.task.state, authorized: before.task.adaptive.authorized },
      after: {
        state: stopped.task.state,
        authorized: stopped.task.adaptive.authorized,
        steps: stopped.task.steps,
      },
      provider: 'Labelled controlled transport',
      trace: await traces(worker),
    });
    r.checks.push(
      'The product authorized a read-only action and began its next plan. A document-bound caution paused the task. A delivered, valid late step caused zero clicks or steps. Cleanup removed the ad and restored it while leaving warning and evidence unchanged.',
    );
    r.caseChecks.push('S7-X25');
    return;
  }
  const original = (await current()).protection;
  await s.page.evaluate(() => history.pushState({}, '', '/account/?token=PRIVATE_TEST_ONLY'));
  await wait(
    async () => (await current()).protection?.status === 'private',
    'private SPA invalidation',
  );
  await worker.evaluate(() => globalThis.protectionTest.releaseMerchant());
  await delay(250);
  await noWarning();
  assert.equal((await current()).protection.doc, original.doc);
  await change(worker, { mode: 'no_match' });
  await s.page.reload({ waitUntil: 'domcontentloaded' });
  await wait(async () => {const p=(await current()).protection;return p?.status==='private'&&p.doc!==original.doc;}, 'new private document');
  await s.page.goto(fixtureOrigin + '/catalogue', { waitUntil: 'domcontentloaded' });
  await wait(
    async () => (await current()).protection?.status === 'no_match',
    'source returned no match',
  );
  await noWarning();
  await area(s.panel, 'Safety checks');
  async function recheck(mode, letter, status) {
    await change(worker, { mode });
    await pair(worker, letter);
    await wait(
      async () => (await current()).protection?.status === 'unavailable',
      'new pairing fenced last reply',
    );
    const before = (await current()).protection.revision;
    await button(s.panel, 'Recheck protection').click();
    const v = await wait(async () => {
      const x = (await current()).protection;
      return x?.revision !== before && x?.status === status && x;
    }, mode);
    r.observations.push({
      mode,
      status: v.status,
      outside: v.outside,
      caution: v.caution,
      domain: v.host,
    });
    return v;
  }
  const limited = await recheck('limited', 'b', 'limited');
  assert(!limited.caution && limited.outside.includes('<img'));
  assert.equal(await s.panel.$('[aria-label="Website protection"] img'), null);
  assert(!(await recheck('expired', 'c', 'unavailable')).caution);
  assert((await current()).protection.outside.includes('expired'));
  assert(!(await recheck('offline', 'd', 'unavailable')).caution);
  assert((await current()).protection.outside.includes('unavailable'));
  assert(!(await recheck('quota', 'e', 'quota')).caution);
  await change(worker, { mode: 'offline' });
  await pair(worker, 'y');
  await area(s.panel, 'Settings');
  await s.panel.select('[aria-label="Auto protection settings"] select', 'selected');
  const limit = await s.panel.waitForSelector(
    '[aria-label="Auto protection settings"] input[type=number]',
  );
  await limit.click({ clickCount: 3 });
  await limit.press('Backspace');
  await limit.type('1');
  const readsBefore = (await traces(worker)).domains.length;
  await button(s.panel, 'Apply protection settings').click();
  await wait(async () => {
    const v = await current();
    return (
      v.prefs.protection.budget === 1 &&
      v.protection?.status === 'unavailable' &&
      (await traces(worker)).domains.length === readsBefore + 1
    );
  }, 'configured one-read budget actually consumed');
  await area(s.panel, 'Safety checks');
  await button(s.panel, 'Recheck protection').click();
  await wait(
    async () => (await current()).protection?.status === 'quota',
    'local session budget exhausted',
  );
  assert.equal((await traces(worker)).domains.length, readsBefore + 1);
  const warning = await recheck('reports', 'f', 'reports');
  await s.page.waitForSelector('[data-safestep-protection]');
  await clickWarning(s,'Dismiss');
  await wait(async () => (await current()).protection.dismissed, 'dismissed');
  await noWarning();
  assert.equal((await current()).protection.revision, warning.revision);
  const other = await s.browser.newPage();
  await interceptFixture(other);
  await change(worker, { mode: 'hold', held: false });
  await pair(worker, 'g');
  await other.goto(fixtureOrigin + '/different-document', { waitUntil: 'domcontentloaded' });
  await wait(async () => (await traces(worker)).held, 'pending source on second tab');
  await other.close();
  await worker.evaluate(() => globalThis.protectionTest.releaseMerchant());
  await s.page.bringToFront();
  await wait(
    async () => (await current()).protection?.host === new URL(fixtureOrigin).hostname,
    'original tab restored',
  );
  await change(worker, { mode: 'hold', held: false });
  await pair(worker, 'h');
  await wait(async () => (await current()).protection?.status === 'unavailable', 'pair changed');
  await area(s.panel,'Safety checks');
  await button(s.panel, 'Recheck protection').click();
  await wait(async () => (await traces(worker)).held, 'new pending lookup');
  const events = await traces(worker);
  assert(events.domains.every((s) => s === 'domain=' + new URL(fixtureOrigin).hostname));
  r.observations.push({ trace: events });
  await worker.close();
  const recovered = await wait(async () => {
    const x = (await current()).protection;
    return x?.status === 'unavailable' && x;
  }, 'worker restored interrupted lookup');
  assert(/interrupted|expired/.test(recovered.outside));
  assert.equal(s.page.url(), fixtureOrigin + '/catalogue');
  assert.equal(await s.page.evaluate(() => globalThis.practiceClicks), 0);
  const revoked = await s.panel.evaluate(
    async (origin) => chrome.permissions.remove({ origins: [origin + '/*'] }),
    fixtureOrigin,
  );
  assert(revoked);
  await wait(async () => !(await current()).protection, 'revoked after restart');
  r.checks.push(
    'Declined wide access. Late source response after a tokenized SPA change did not attach. Unrelated, limited, expired pairing, 503 and 429 were distinct; provider text remained inert. Closed a second tab during a pending request. Dismissal hid the current warning. A worker restart recovered the pending check as unavailable without navigation. Removing the scope removed automatic coverage.',
  );
  r.caseChecks.push('S7-X10', 'S7-X15', 'S7-X16');
  r.sourceFixtureObservations = ['S7-X14', 'S7-X26'];
}
