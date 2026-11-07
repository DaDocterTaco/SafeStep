// Reproduce SS1-01 in real time without attaching a debugger to the extension worker.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { fingerprint } from '../scripts/stage1.mjs';
import { startFixture } from './fixtures/serve.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3');
const { sha256 } = await fingerprint(bundle);
const out = resolve('.test-artifacts/f03', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const fixture = await startFixture(0);
async function trial(width, height) {
  const browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_PATH ??
      (process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : '/usr/bin/google-chrome'),
    pipe: true,
    headless: false,
    enableExtensions: true,
    defaultViewport: null,
    targetFilter: (target) => target.type() !== 'service_worker',
    args: [
      '--enable-unsafe-extension-debugging',
      '--disable-background-networking',
      '--force-device-scale-factor=1',
      '--window-position=-1800,40',
    ],
  });
  try {
    const root = await browser.target().createCDPSession();
    const { id } = await root.send('Extensions.loadUnpacked', { path: bundle });
    const page = await browser.newPage();
    await page.goto(fixture.origin);
    await page.bringToFront();
    const measure = (p) => p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const { windowId } = await root.send('Browser.getWindowForTarget', {
      targetId: (await (await page.createCDPSession()).send('Target.getTargetInfo')).targetInfo
        .targetId,
    });
    for (let i = 0; i < 4; i++) {
      const size = await measure(page);
      if (size.width === width && size.height === height) break;
      const { bounds } = await root.send('Browser.getWindowBounds', { windowId });
      await root.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          width: bounds.width + width - size.width,
          height: bounds.height + height - size.height,
        },
      });
      await delay(120);
    }
    const closed = await measure(page);
    const tab = (
      await root.send('Target.getTargets', { filter: [{ type: 'tab' }] })
    ).targetInfos.find((t) => t.url === page.url());
    await root.send('Extensions.triggerAction', { id, targetId: tab.targetId });
    const panel = await (
      await browser.waitForTarget(
        (t) => t.url() === 'chrome-extension://' + id + '/sidepanel.html',
        { timeout: 9000 },
      )
    ).asPage();
    assert(
      (await panel.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })))
        .length,
    );
    const button = (name) =>
      panel.locator('::-p-aria(' + name + '[role="button"])').setTimeout(7000);
    const status = () => panel.$eval('[data-testid=task-state]', (el) => el.textContent);
    const state = async (desired) =>
      panel.waitForFunction(
        (s) => document.querySelector('[data-testid=task-state]')?.textContent === s,
        { timeout: 7000 },
        desired,
      );
    const geometry = () =>
      page.evaluate(() => {
        const ring = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
        const target = document.querySelector('#settings').getBoundingClientRect();
        return {
          aligned:
            !!ring &&
            Math.abs(ring.left + 3 - target.left) < 1 &&
            Math.abs(ring.top + 3 - target.top) < 1 &&
            Math.abs(ring.width - 6 - target.width) < 1,
          clicks: document.querySelector('#clicks').textContent,
        };
      });
    const selected = () => button('Highlight Practice settings').click();
    const snapshot = async () => ({ panel: await status(), ...(await geometry()) });
    const expected = {
      panel: 'Showing highlight',
      aligned: true,
      clicks: 'Practice button clicks: 0',
    };
    await button('Inspect page').click();
    await state('Ready to highlight');
    await selected();
    await state('Showing highlight');
    const baseline = await snapshot();
    assert.deepEqual(baseline, expected);
    const initialOutline = await page.$('[data-safestep-outline]');
    const start = Date.now();
    console.log(width + '×' + height + ': selection visible; beginning idle trial');
    // Real elapsed time. No panel messages, worker debugger, mock timers, or page changes.
    await delay(95000);
    const elapsedMs = Date.now() - start;
    const workerAsleep = !(
      await root.send('Target.getTargets', { filter: [{ type: 'service_worker' }] })
    ).targetInfos.some((t) => t.url.startsWith('chrome-extension://' + id + '/'));
    const idle = await snapshot();
    assert.deepEqual(idle, expected);
    await Promise.all([
      page.screenshot({ path: join(out, width + '-idle-page.png') }),
      panel.screenshot({ path: join(out, width + '-idle-panel.png') }),
    ]);
    assert(workerAsleep, 'This test must exercise a cold worker on the first re-selection.');
    await selected();
    // Wait for a *new* outline, not just the still-present baseline UI.
    await page.waitForFunction(
      (old) => !old.isConnected && !!document.querySelector('[data-safestep-outline]'),
      { timeout: 7000 },
      initialOutline,
    );
    await state('Showing highlight');
    const retry = await snapshot();
    assert.deepEqual(retry, expected);
    assert.equal(await panel.$('[role=alert]'), null);
    await button('Clear highlight').click();
    await state('Ready to highlight');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await selected();
    await state('Showing highlight');
    await button('Pause').click();
    await state('Paused');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await button('Resume').click();
    await state('Ready to highlight');
    await selected();
    await state('Showing highlight');
    await page.click('#remove');
    await state('Paused');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await button('Cancel task').click();
    await state('Cancelled');
    const result = {
      browser: await browser.version(),
      requested: { width, height },
      closed,
      page: await measure(page),
      panel: await measure(panel),
      zoom: await panel.evaluate(async () =>
        chrome.tabs.getZoom((await chrome.tabs.query({ active: true, currentWindow: true }))[0].id),
      ),
      elapsedMs,
      workerAsleep,
      baseline,
      idle,
      retry,
      explicitClear: true,
      pause: true,
      removedTarget: true,
      cancel: true,
    };
    console.log('PASS', JSON.stringify(result));
    return result;
  } finally {
    await browser.close();
  }
}
try {
  const trials = await Promise.allSettled([trial(1440, 900), trial(1366, 768)]);
  const errors = trials.filter((t) => t.status === 'rejected').map((t) => t.reason);
  if (errors.length) throw new AggregateError(errors, 'F03 regression failed');
  await writeFile(
    join(out, 'results.json'),
    JSON.stringify(
      {
        issue: 'SS1-01 / F03',
        bundle,
        sha256,
        verifiedAt: new Date().toISOString(),
        trials: trials.map((t) => t.value),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  fixture.server.close();
}
