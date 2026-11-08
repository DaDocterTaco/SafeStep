import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, join } from 'node:path';
import { view } from '../tests/support/chrome-cases.mjs';

export async function until(fn, reason, limit = 16000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const result = await fn().catch(() => null);
    if (result) return result;
    await delay(90);
  }
  throw Error('Timed out: ' + reason);
}
const button = (p, name) => p.locator('::-p-aria(' + name + '[role="button"])').setTimeout(8000);
export async function checkAutomaticArrivals({
  browser,
  controls,
  arm,
  observations,
  record,
  out,
}) {
  let p = browser.panel;
  const initial = controls[0].url,
    second = controls[1].url;
  assert.equal(browser.page.url(), initial);
  assert.equal(observations.length, 0);
  await button(p, 'Settings').click();
  const settings = '[aria-label="Auto protection settings"]';
  await p.select(settings + ' select', 'selected');
  const box = p.locator(
    '::-p-aria(Allow automatic public URL checks with Google Web Risk[role="checkbox"])',
  );
  const text = await p.$eval(settings, (e) => e.innerText);
  assert(text.includes('flag safe pages by mistake'));
  arm(initial);
  await box.click();
  await button(p, 'Apply protection settings').click();
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('tests/support/permission.ps1'),
      '-BrowserProcessId',
      String(browser.browser.process().pid),
      '-Choice',
      'Allow',
    ],
    { windowsHide: true, timeout: 16000 },
  ).catch(() => {});
  const preferences = await until(async () => {
    const prefs = (await view(p)).v.prefs.protection;
    return (
      prefs?.scope === 'selected' &&
      prefs?.automaticUrlConsent === 2 &&
      prefs.sites.includes('https://www.iana.org') &&
      prefs
    );
  }, 'actual selected-site consent');
  const grant = await p.evaluate(() =>
    chrome.permissions.contains({ origins: ['https://www.iana.org/*'] }),
  );
  assert(grant);
  record.consent = {
    scope: preferences.scope,
    origin: 'https://www.iana.org',
    granted: true,
    automaticUrlConsent: 2,
  };
  await button(p, 'Close Settings').click();
  async function visibleReceipt(panel, url) {
    return until(async () => {
      const q = (await view(panel)).v.protection;
      const result = q?.threat;
      return result?.scope === 'page' && result?.purpose === 'arrival' && result.url === url
        ? { document: q.doc, routeToken: q.routeToken, revision: q.revision, receipt: result }
        : null;
    }, 'bound current page finding');
  }
  const first = await until(
    async () => observations.find((s) => s.url === initial),
    'first genuine arrival response',
  );
  record.arrivals = [
    {
      requested: initial,
      committed: browser.page.url(),
      panel: 'open',
      result: first,
      binding: await visibleReceipt(p, initial),
    },
  ];
  if (first.receipt.status === 'unavailable' || first.receipt.status === 'rate_limited')
    return false;
  await p.screenshot({ path: join(out, 'initial-panel.png') });
  await p
    .evaluate(async () =>
      chrome.sidePanel.close({ windowId: (await chrome.windows.getCurrent()).id }),
    )
    .catch(() => {});
  await until(
    async () =>
      !(await browser.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
        t.url.endsWith(browser.id + '/sidepanel.html'),
      ),
    'native panel closed',
  );
  arm(second);
  await browser.page.goto(second, { waitUntil: 'domcontentloaded', timeout: 18000 });
  const committed = browser.page.url();
  assert.equal(committed, second);
  const next = await until(
    async () => observations.find((s) => s.url === committed),
    'automatic check while panel closed',
  );
  assert(
    !(await browser.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
      t.url.endsWith(browser.id + '/sidepanel.html'),
    ),
  );
  const heading = await browser.page.$eval('h1', (e) => e.innerText);
  await browser.page.screenshot({ path: join(out, 'second-page-panel-closed.png') });
  await browser.page.bringToFront();
  await browser.activate(browser.page);
  p = await (
    await browser.browser.waitForTarget(
      (t) => t.url() === 'chrome-extension://' + browser.id + '/sidepanel.html',
      { timeout: 8500 },
    )
  ).asPage();
  browser.panel = p;
  await p.waitForSelector('#chat-composer');
  const binding = await visibleReceipt(p, committed);
  assert.notEqual(binding.document, record.arrivals[0].binding.document);
  record.arrivals.push({
    requested: second,
    committed,
    heading,
    panel: 'closed during source reply',
    result: next,
    binding,
  });
  await p.screenshot({ path: join(out, 'second-panel-reopened.png') });
  return next.receipt.status !== 'unavailable' && next.receipt.status !== 'rate_limited';
}
