import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

export const measure = (p) => p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
export async function nativeSession(
  bundle,
  width,
  height,
  start,
  { prepare, attachWorker = false, apiHost = process.env.SAFESTEP_TEST_API_HOST, install, userDataDir, requireUsablePanel = false, headless = false } = {},
) {
  if (apiHost && !/^127\.0\.0\.[2-9]$/.test(apiHost)) throw Error('Test API must use isolated loopback.');
  const browser = await puppeteer.launch({
    ...(userDataDir ? {userDataDir} : {}),
    executablePath:
      process.env.CHROME_PATH ??
      (process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : '/usr/bin/google-chrome'),
    pipe: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(?:API_KEY|TOKEN|SECRET|COOKIE|PASSWORD)/i.test(k))),
    headless,
    enableExtensions: true,
    defaultViewport: null,
    targetFilter: (t) => attachWorker || t.type() !== 'service_worker',
    args: [
      '--enable-unsafe-extension-debugging',
      ...(apiHost ? ['--host-resolver-rules=MAP 127.0.0.1:4317 '+apiHost+':4317'] : []),
      '--disable-background-networking',
      '--force-device-scale-factor=1',
      ...(headless ? ['--screen-info={1920x1200}'] : []),
      install || requireUsablePanel ? '--window-position=30,40' : '--window-position=-1800,40',
    ],
  });
  try {
    const root = await browser.target().createCDPSession();
    const { id } = install
      ? await install(browser, root, resolve(bundle))
      : await root.send('Extensions.loadUnpacked', { path: resolve(bundle) });
    const page = await browser.newPage();
    if (prepare) await prepare(page);
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
    const tabSession = await page.createCDPSession();
    const { windowId } = await root.send('Browser.getWindowForTarget', {
      targetId: (await tabSession.send('Target.getTargetInfo')).targetInfo.targetId,
    });
    for (let i = 0; i < 6; i++) {
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
      await delay(150);
    }
    const closed = await measure(page);
    assert.deepEqual(closed, { width, height });
    const activate = async (p) => {
      const tabs = (await root.send('Target.getTargets', { filter: [{ type: 'tab' }] }))
        .targetInfos;
      const t = tabs.find((t) => t.url === p.url());
      assert(t, 'test tab target');
      await root.send('Extensions.triggerAction', { id, targetId: t.targetId });
    };
    await activate(page);
    const panel = await (
      await browser.waitForTarget(
        (t) => t.url() === 'chrome-extension://' + id + '/sidepanel.html',
        { timeout: 10000 },
      )
    ).asPage();
    await panel.waitForSelector('#goal, textarea[aria-label="What would you like help with?"], textarea#chat-composer');
    await page.waitForFunction((w) => innerWidth < w, { timeout: 3500 }, width).catch(() => {});
    if (requireUsablePanel) {
      await panel.waitForFunction((h,limit)=>Math.abs(innerHeight-h)<limit && innerWidth>=300,{timeout:6000},height,headless?64:24).catch(async e=>{
        throw Error(e.message+' (panel '+JSON.stringify(await measure(panel))+', tab '+JSON.stringify(await measure(page))+')');
      });
      await page.waitForFunction(({w,h})=>innerWidth<w-250 && Math.abs(innerHeight-h)<24,{timeout:6000},{w:width,h:height});
    }
    const contexts = await panel.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }),
    );
    assert(contexts.length);
    const zoom = await panel.evaluate(async () =>
      chrome.tabs.getZoom((await chrome.tabs.query({ active: true, currentWindow: true }))[0].id),
    );
    assert.equal(zoom, 1);
    const { bounds } = await root.send('Browser.getWindowBounds', { windowId });
    return {
      browser,
      root,
      page,
      panel,
      id,
      tabSession,
      windowId,
      activate,
      dimensions: {
        closed,
        page: await measure(page),
        panel: await measure(panel),
        window: { width: bounds.width, height: bounds.height },
        zoom,
        native: true,
      },
    };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
