import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const outline = '[data-safestep-outline]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, desc, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await sleep(50);
  }
  throw Error('Timed out: ' + desc);
}
export async function view(panel) {
  return panel.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.runtime.sendMessage({
      v: 2,
      channel: 'panel',
      requestId: crypto.randomUUID(),
      tabId: t.id,
      windowId: t.windowId,
      epoch: 0,
      documentId: null,
      revision: null,
      command: { kind: 'view' },
    });
    if (!r?.ok) throw Error('view: ' + r?.error);
    return { v: r.view, windowId: t.windowId };
  });
}
function request(current, command) {
  const v = current.v;
  return {
    v: 2,
    channel: 'panel',
    requestId: crypto.randomUUID(),
    windowId: current.windowId,
    tabId: v.tabId,
    epoch: v.epoch,
    documentId: v.snapshot?.context.documentId ?? null,
    revision: v.snapshot?.context.revision ?? null,
    command,
  };
}
function highlight(current, label) {
  const ctx = current.v.snapshot.context,
    c = current.v.snapshot.controls.find((c) => c.label === label);
  return request(current, {
    kind: 'highlight',
    step: {
      id: crypto.randomUUID(),
      kind: 'highlight',
      ref: c.ref,
      expectedOrigin: ctx.origin,
      requiredAccess: 'inspect',
      expectedOutcome: 'visible_outline',
      confirmation: 'user_request',
    },
  });
}
const transmit = (panel, r) => panel.evaluate((m) => chrome.runtime.sendMessage(m), r);
export async function runCases({
  browser,
  root,
  id,
  fixture,
  page,
  panel,
  button,
  waitText,
  tabTarget,
  passed,
  worker,
  log,
}) {
  const get = () => view(panel);
  const state = async (value) =>
    until(async () => {
      const cur = await get();
      return cur.v.task?.state === value ? cur : null;
    }, value);
  const send = async (command) => transmit(panel, request(await get(), command));
  const aligned = () =>
    page.waitForFunction(() => {
      const a = document.querySelector('#settings')?.getBoundingClientRect(),
        b = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
      return (
        a &&
        b &&
        Math.abs(a.left - 3 - b.left) < 1 &&
        Math.abs(a.top - 3 - b.top) < 1 &&
        Math.abs(a.width + 6 - b.width) < 1
      );
    });
  await button('Highlight Practice settings').click();
  await aligned();
  await page.evaluate(() => scrollTo(0, 130));
  await page.waitForFunction(() => scrollY > 0);
  await aligned();
  await page.setViewport({ width: 670, height: 460 });
  await aligned();
  assert.equal(await page.$eval('#clicks', (e) => e.textContent), 'Practice button clicks: 0');
  passed('outline follows scrolling and viewport resize; fixture recorded zero clicks');
  await page.click('#settings');
  assert.equal(await page.$eval('#clicks', (e) => e.textContent), 'Practice button clicks: 1');
  passed('a normal user click passes through the outline');
  let old = highlight(await get(), 'Practice settings');
  await button('Pause').click();
  await state('paused');
  assert.equal(await page.$(outline), null);
  assert(!(await transmit(panel, old)).ok);
  await button('Resume').click();
  let a = await state('awaiting_user');
  assert.notEqual(a.v.snapshot.context.revision, old.revision);
  passed('pause fenced old steps; resume inspected new references');
  old = highlight(a, 'Practice settings');
  await page.click('#remove');
  await waitText('This control is no longer available');
  assert(!(await transmit(panel, old)).ok);
  assert.equal(await page.$(outline), null);
  passed('removed target invalidates the snapshot and cannot be highlighted');
  await button('Inspect page').click();
  a = await state('awaiting_user');
  old = highlight(a, 'Lower practice control');
  await page.click('#route');
  await state('paused');
  assert(!(await transmit(panel, old)).ok);
  passed('same-document history change invalidated handles');
  await page.goto(fixture.origin + '/next');
  await waitText('Second desk');
  a = await state('paused');
  assert.notEqual(a.v.snapshot?.context.documentId, old.documentId);
  assert(!(await transmit(panel, old)).ok);
  await button('Resume').click();
  a = await state('awaiting_user');
  const firstTab = highlight(a, 'Second practice control');
  await button('Highlight Second practice control').click();
  await page.waitForSelector(outline);
  passed('new document was inspected while paused and rejected the prior document’s request');
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      if (args[1]?.command?.kind === 'snapshot') {
        chrome.tabs.sendMessage = original;
        const data = await original(...args);
        await new Promise((resolve) => (globalThis.releaseTabTest = resolve));
        return data;
      }
      return original(...args);
    };
  });
  const tabReply = send({ kind: 'inspect', goal: 'First tab only', mode: 'guide' });
  await until(
    () => worker.evaluate(() => typeof globalThis.releaseTabTest === 'function'),
    'held first-tab response',
  );
  const b = await browser.newPage();
  await b.goto(fixture.origin);
  await b.bringToFront();
  await waitText('Access needed');
  await worker.evaluate(() => globalThis.releaseTabTest());
  assert(!(await tabReply).ok);
  assert.equal((await get()).v.snapshot, null);
  const denied = await send({ kind: 'inspect', goal: 'Other tab', mode: 'guide' });
  assert.equal(denied.error, 'permission_required');
  assert(!(await transmit(panel, firstTab)).ok);
  assert.equal(await b.$(outline), null);
  await page.waitForFunction(() => !document.querySelector('[data-safestep-outline]'));
  await root.send('Extensions.triggerAction', { id, targetId: await tabTarget(b) });
  await waitText('Access for this visit');
  await button('Inspect page').click();
  const bt = await state('awaiting_user');
  assert.notEqual(bt.v.task.id, a.v.task.id);
  assert.notEqual(bt.v.tabId, a.v.tabId);
  passed(
    'second tab needed its own grant and task; delayed first-tab response and stale request had no effect',
  );
  // Hold a real bridge request in the test worker until cancellation has reached the page.
  // The production bundle has no test endpoints or delays.
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      if (args[1]?.command?.kind === 'highlight') {
        chrome.tabs.sendMessage = original;
        await new Promise((resolve) => (globalThis.releaseSafeStepTest = resolve));
      }
      return original(...args);
    };
  });
  const late = transmit(panel, highlight(bt, 'Practice settings'));
  await until(
    () => worker.evaluate(() => typeof globalThis.releaseSafeStepTest === 'function'),
    'in-flight highlight',
  );
  assert((await send({ kind: 'cancel' })).ok);
  await worker.evaluate(() => globalThis.releaseSafeStepTest());
  assert(!(await late).ok);
  assert.equal((await get()).v.task.state, 'cancelled');
  assert.equal(await b.$(outline), null);
  passed('highlight delayed until after cancellation was rejected by the real content script');
  await button('Inspect page').click();
  await state('awaiting_user');
  // Hold an actual snapshot reply after it has left the content script, then change documents.
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      if (args[1]?.command?.kind === 'snapshot') {
        chrome.tabs.sendMessage = original;
        const result = await original(...args);
        await new Promise((resolve) => (globalThis.releaseSnapshotTest = resolve));
        return result;
      }
      return original(...args);
    };
  });
  const delayed = send({ kind: 'inspect', goal: 'Inspect again', mode: 'guide' });
  await until(
    () => worker.evaluate(() => typeof globalThis.releaseSnapshotTest === 'function'),
    'in-flight snapshot reply',
  );
  await b.goto(fixture.origin + '/next');
  await worker.evaluate(() => globalThis.releaseSnapshotTest());
  assert(!(await delayed).ok);
  await waitText('Second desk');
  assert(!(await get()).v.snapshot?.title.startsWith('Practice'));
  passed('delayed snapshot response from the previous document could not replace the new one');
  await button('Resume').click();
  let cur = await state('awaiting_user');
  await button('Highlight Second practice control').click();
  await b.waitForSelector(outline);
  const before = await state('showing_step');
  await panel.locator('summary::-p-text(Access & preferences)').click();
  await panel.locator('input[type=checkbox]').click();
  await until(async () => (await get()).v.prefs.largeText, 'persist larger text');
  await log.detach();
  await worker.close();
  const recovered = await state('paused');
  assert.equal(recovered.v.task.id, before.v.task.id);
  assert.equal(recovered.v.task.goal, before.v.task.goal);
  assert(recovered.v.snapshot);
  assert.notEqual(recovered.v.snapshot.context.revision, before.v.snapshot.context.revision);
  assert(recovered.v.prefs.largeText);
  assert.equal(recovered.v.task.lastVerified, 'inspected');
  assert.equal(await b.$(outline), null);
  passed(
    'terminated worker recovered the task and preferences, re-inspected and left it paused without replay',
  );
  await panel.reload();
  await waitText('Paused');
  assert(await panel.evaluate(() => !!document.querySelector('.large')));
  await panel.locator('summary::-p-text(Access & preferences)').click();
  if (process.platform !== 'win32')
    throw Error('Native permission-dialog test currently requires Windows.');
  for (const choice of ['Deny', 'Allow']) {
    await button('Enable on this site').click();
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve('tests/support/permission.ps1'),
        '-BrowserProcessId',
        String(browser.process().pid),
        '-Choice',
        choice,
      ],
      { windowsHide: true, timeout: 13000 },
    );
    console.log(stdout.trim());
    if (choice === 'Deny') {
      await waitText('Site access was declined');
      assert.equal((await get()).v.prefs.sites.length, 0);
      passed('native optional permission denial left the site disabled');
    } else {
      await waitText('Enabled on this site');
      const regs = await panel.evaluate(() => chrome.scripting.getRegisteredContentScripts());
      assert.deepEqual(
        regs.map((r) => r.matches),
        [['http://localhost/*']],
      );
      passed('native optional site grant registered only the chosen host');
    }
  }
  const grantedTab = await browser.newPage();
  await grantedTab.goto(fixture.origin);
  await grantedTab.bringToFront();
  await waitText('Enabled on this site');
  await button('Inspect page').click();
  const future = await state('awaiting_user');
  assert.equal(future.v.snapshot.context.access, 'site');
  await button('Highlight Practice settings').click();
  await grantedTab.waitForSelector(outline);
  await panel.locator('summary::-p-text(Access & preferences)').click();
  await button('Restore page').click();
  await state('paused');
  assert.equal(await grantedTab.$(outline), null);
  await grantedTab.click('#many');
  await button('Inspect page').click();
  const bounded = await state('awaiting_user');
  assert.equal(bounded.v.snapshot.controls.length, 32);
  assert(bounded.v.snapshot.limited);
  passed('a fixture with over 40 public controls returned exactly 32 and a coverage limit');
  await grantedTab.close();
  await b.bringToFront();
  await waitText('Enabled on this site');
  passed(
    'a future tab used its persistent grant without a toolbar invocation; Restore page removed guidance',
  );
  await button('Resume').click();
  cur = await state('awaiting_user');
  const revocable = highlight(cur, 'Second practice control');
  await button('Highlight Second practice control').click();
  await b.waitForSelector(outline);
  // Remove via Chrome itself, independently of SafeStep’s remove button.
  assert(
    await panel.evaluate(() => chrome.permissions.remove({ origins: ['http://localhost/*'] })),
  );
  await waitText('Access removed');
  assert(!(await transmit(panel, revocable)).ok);
  assert.equal((await get()).v.prefs.sites.length, 0);
  assert.equal(await b.$(outline), null);
  assert.equal(
    (await panel.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length,
    0,
  );
  passed('external revocation cleared the outline, paused work and unregistered the script');
  await b.goto(fixture.origin.replace('localhost', '127.0.0.1') + '/next');
  await waitText('Access needed');
  assert(!(await send({ kind: 'inspect', goal: 'Cross origin', mode: 'guide' })).ok);
  assert.equal(await b.$(outline), null);
  passed('cross-origin navigation needs new authorization even on the API loopback host');
  await b.goto('chrome://version/');
  await root.send('Extensions.triggerAction', { id, targetId: await tabTarget(b) });
  await waitText('Unsupported page');
  passed('restricted Chrome page shows unsupported status without injection');
}
