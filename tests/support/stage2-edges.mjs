import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeSession } from './native-stage2.mjs';
import { view } from './chrome-cases.mjs';
import { startFixture } from '../fixtures/serve.mjs';
const url = 'https://en.wikipedia.org/wiki/Phishing',
  toggle = '#vector-page-tools-dropdown-label',
  check = '#vector-page-tools-dropdown-checkbox',
  cite = '#t-cite a';
const fixture = await readFile(new URL('../fixtures/guidance.html', import.meta.url), 'utf8');
const prepare = async (page) => {
  await page.setRequestInterception(true);
  page.on('request', (q) => {
    if (q.isNavigationRequest() && new URL(q.url()).origin === 'https://en.wikipedia.org') {
      const path = new URL(q.url()).pathname;
      const wrongArticle =
        '<main><h1 id="firstHeading">Cite This Page</h1><h2>Citation styles for "Other"</h2><h3 id="APA_style">APA style</h3></main>';
      void q.respond({
        status: 200,
        contentType: 'text/html; charset=UTF-8',
        headers: { 'Cache-Control': 'no-store' },
        body:
          path === '/wiki/Phishing'
            ? fixture
            : path === '/w/index.php'
              ? wrongArticle
              : '<title>Unrelated harmless fixture</title><h1>Unrelated harmless fixture</h1>',
      });
    } else void q.abort();
  });
};
const command = async (panel, c) => {
  const { v, windowId } = await view(panel);
  return panel.evaluate((r) => chrome.runtime.sendMessage(r), {
    v: 2,
    channel: 'panel',
    requestId: crypto.randomUUID(),
    tabId: v.tabId,
    windowId,
    epoch: v.epoch,
    documentId: v.snapshot?.context.documentId ?? null,
    revision: v.snapshot?.context.revision ?? null,
    command: c,
  });
};
async function keyboardButton(panel, name) {
  const b = await panel.waitForSelector('::-p-aria(' + name + '[role="button"])');
  await b.focus();
  assert(await b.evaluate((e) => e === document.activeElement));
  await panel.keyboard.press('Enter');
}
async function start(panel, goal = 'Find an APA citation') {
  await panel.$eval('#goal', (e) => e.select());
  await panel.keyboard.type(goal);
  await panel.keyboard.press('Enter');
}
const workerHandle = async (s) =>
  (
    await s.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(s.id))
  ).worker();
export async function edgeCases(h) {
  const { bundle, button, waitUI, until, ring, capture, safeDiagnostic } = h,
    records = [];
  async function run(name, width, height, fn, options = {}) {
    const r = { kind: 'labelled fixture', name, width, height, checks: [] };
    let s;
    try {
      s = await nativeSession(
        bundle,
        width,
        height,
        options.start ?? url,
        options.start
          ? { attachWorker: options.attachWorker }
          : { prepare, attachWorker: options.attachWorker },
      );
      r.chrome = await s.browser.version();
      r.dimensions = s.dimensions;
      await fn(s, r);
      r.status = 'pass';
      console.log('PASS fixture', name, width, r.checks);
    } catch (e) {
      r.status = 'fail';
      r.error = e.message.split('\n')[0];
      r.diagnostic = s ? await safeDiagnostic(s) : {};
      console.log('FAIL fixture', name, width, r.error, r.diagnostic, r.checks);
    } finally {
      if (s) await s.browser.close();
    }
    return r;
  }
  async function idle(s, r) {
    const { page, panel } = s;
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await keyboardButton(panel, 'Choose a supported task');
    await keyboardButton(panel, 'Wikipedia · APA citation');
    await waitUI(panel, '[data-testid=instruction]', 'Open Tools');
    let el = await page.$(toggle);
    assert(await ring(el));
    await capture(s, 'fixture-' + r.width + '-before-idle');
    const now = Date.now();
    await delay(96500);
    r.idleMs = Date.now() - now;
    const workers = (
      await s.root.send('Target.getTargets', { filter: [{ type: 'service_worker' }] })
    ).targetInfos;
    assert(
      !workers.some((t) => t.url.startsWith('chrome-extension://' + s.id + '/')),
      'worker should be asleep',
    );
    r.workerAsleep = true;
    assert(await ring(el));
    await waitUI(panel, '[data-testid=task-state]', 'Showing highlight');
    assert.equal(await page.evaluate(() => window.activations), 0);
    await capture(s, 'fixture-' + r.width + '-idle');
    r.checks.push('G11 unchanged outline and panel agree beyond 95s; no click and worker asleep');
    const recovered = await view(panel);
    assert.equal(recovered.v.task.state, 'paused');
    assert.equal(recovered.v.task.guide.step, 1);
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await waitUI(panel, '[data-testid=task-state]', 'Paused');
    await keyboardButton(panel, 'Resume');
    await waitUI(panel, '[data-testid=instruction]', 'Open Tools');
    assert(await ring(el));
    r.checks.push('G08 cold worker reinspected and required explicit keyboard Resume; no replay');
    await page.evaluate(() => {
      document.querySelector('#p-tb').style.marginTop = '160vh';
    });
    await waitUI(panel, '.location', 'below');
    assert.equal(await page.evaluate(() => scrollY), 0);
    await keyboardButton(panel, 'Show me');
    await until(
      async () => (await page.evaluate(() => scrollY > 0)) && (await ring(el)),
      'off-screen target revealed',
    );
    await until(
      async () => (await view(panel)).v.snapshot?.guide?.placement === 'visible',
      'visible placement',
    );
    assert.equal(await page.evaluate(() => window.activations), 0);
    await capture(s, 'fixture-' + r.width + '-revealed');
    r.checks.push(
      'G12 reduced-motion Show me scrolled, revalidated and outlined without activation',
    );
    const port = (await s.root.send('Browser.getWindowBounds', { windowId: s.windowId })).bounds;
    await s.root.send('Browser.setWindowBounds', {
      windowId: s.windowId,
      bounds: { width: port.width - 70, height: port.height - 30 },
    });
    await delay(170);
    assert(await ring(el));
    await s.root.send('Browser.setWindowBounds', {
      windowId: s.windowId,
      bounds: { width: port.width, height: port.height },
    });
    const prior = s.panel;
    await prior
      .evaluate(async () => {
        const t = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        await chrome.sidePanel.close({ windowId: t.windowId });
      })
      .catch(() => {});
    await until(
      async () =>
        !(await s.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some(
          (t) => t.url === 'chrome-extension://' + s.id + '/sidepanel.html',
        ),
      'native panel closed',
    );
    await s.activate(page);
    s.panel = await (
      await s.browser.waitForTarget(
        (t) => t.url() === 'chrome-extension://' + s.id + '/sidepanel.html',
        { timeout: 6000 },
      )
    ).asPage();
    await waitUI(s.panel, '[data-testid=instruction]', 'Open Tools');
    assert(await ring(el));
    r.checks.push(
      'G06 scroll, resize, close and reopen native panel; single aligned click-through cue',
    );
    await keyboardButton(s.panel, 'Pause');
    await waitUI(s.panel, '[data-testid=task-state]', 'Paused');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await keyboardButton(s.panel, 'Resume');
    await waitUI(s.panel, '[data-testid=instruction]', 'Open Tools');
    await keyboardButton(s.panel, 'Cancel task');
    await waitUI(s.panel, '[data-testid=task-state]', 'Cancelled');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await keyboardButton(s.panel, 'Restart task');
    await waitUI(s.panel, '[data-testid=instruction]', 'Open Tools');
    const state = await view(s.panel);
    assert(!JSON.stringify(state).includes('PRIVATE_FIELD_MARKER'));
    assert.equal(await page.evaluate(() => window.activations), 0);
    r.checks.push(
      'R02 keyboard picker, Show me, pause/resume, cancel and restart; G09 checkbox value excluded',
    );
  }
  async function variants(s, r) {
    const { page, panel } = s;
    await start(panel, 'change my bank password');
    await waitUI(panel, 'section[aria-label="Guided task"]', 'isn’t supported');
    assert.equal((await view(panel)).v.task, null);
    await start(panel, 'help me');
    await waitUI(panel, 'section[aria-label="Guided task"]', 'Which task');
    await keyboardButton(panel, 'VideoLAN · VLC for Windows');
    await waitUI(panel, '[data-testid=recovery]', 'supported only');
    r.checks.push('G03/G04 ambiguous and unsupported goal; wrong-site task stopped without cue');
    for (const [workflow, aliases] of [
      [
        'wikipedia_cite_apa',
        ['How do I cite this page?', 'Find an APA citation', 'Show the article citation'],
      ],
      [
        'videolan_windows_page',
        [
          'Where is the Windows download page?',
          'Find VLC for Windows',
          'Show the official Windows VLC page',
        ],
      ],
    ]) {
      for (const alias of aliases) {
        const old = (await view(panel)).v.task?.id;
        await start(panel, alias);
        await until(async () => {
          const t = (await view(panel)).v.task;
          return t?.id !== old && t?.guide?.workflow === workflow && t.state !== 'inspecting';
        }, 'native alias: ' + alias);
      }
    }
    r.checks.push('G03 all six aliases resolved to the correct workflow in the native panel');
    await page.click(toggle);
    await start(panel);
    await waitUI(panel, '[data-testid=instruction]', 'Choose Cite this page');
    assert.equal((await view(panel)).v.snapshot.guide.step, 2);
    await page.evaluate(() =>
      document
        .querySelector('#t-cite a')
        .addEventListener('click', (e) => e.preventDefault(), { once: true }),
    );
    await page.click(cite);
    await delay(180);
    assert.equal((await view(panel)).v.task.guide.step, 2);
    r.checks.push('G05 already-open menu and ineffective click did not advance');
    await page.evaluate(() => {
      const a = document.querySelector('#t-cite a');
      a.after(a.cloneNode(true));
    });
    await waitUI(panel, '[data-testid=recovery]', 'More than one');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await page.evaluate(() => document.querySelector('#t-cite a').remove());
    await button(panel, 'Resume').click();
    await waitUI(panel, '[data-testid=instruction]', 'Choose Cite');
    await page.evaluate(() => (document.querySelector('#t-cite a').hidden = true));
    await waitUI(panel, '[data-testid=recovery]', 'can’t find');
    await page.evaluate(() => (document.querySelector('#t-cite a').hidden = false));
    await button(panel, 'Resume').click();
    await waitUI(panel, '[data-testid=instruction]', 'Choose Cite');
    const v0 = (await view(panel)).v;
    const stale = {
      v: 2,
      channel: 'panel',
      requestId: crypto.randomUUID(),
      tabId: v0.tabId,
      windowId: (await view(panel)).windowId,
      epoch: v0.epoch,
      documentId: v0.snapshot.context.documentId,
      revision: v0.snapshot.context.revision,
      command: { kind: 'reveal', ref: v0.snapshot.guide.ref },
    };
    await page.evaluate(
      () =>
        (document.querySelector('#t-cite a').href =
          'https://en.wikipedia.org.harmless.test/w/index.php?title=Special:CiteThisPage&page=Phishing'),
    );
    await waitUI(panel, '[data-testid=recovery]', 'expected destination');
    const changed = (await view(panel)).v;
    assert.equal(changed.snapshot.guide.link.host, 'en.wikipedia.org.harmless.test');
    assert.equal(changed.snapshot.guide.ref, null);
    assert(!changed.snapshot.guide.link.allowed);
    assert.equal(await page.$('[data-safestep-outline]'), null);
    const staleReply = await panel.evaluate((req) => chrome.runtime.sendMessage(req), stale);
    assert(!staleReply.ok);
    r.checks.push(
      'U09 replaced href invalidated evidence, paused, showed unexpected host; stale reveal rejected',
    );
    await capture(s, 'fixture-mismatch');
    await page.evaluate(
      () =>
        (document.querySelector('#t-cite a').href =
          '/w/index.php?title=Special:CiteThisPage&page=Phishing'),
    );
    await button(panel, 'Resume').click();
    await waitUI(panel, '[data-testid=instruction]', 'Choose Cite');
    await page.reload({ waitUntil: 'load' });
    await until(async () => {
      const v = (await view(panel)).v;
      return (
        v.task?.state === 'paused' &&
        v.snapshot?.context.documentId !== v0.snapshot.context.documentId
      );
    }, 'refresh pause');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await button(panel, 'Resume').click();
    await waitUI(panel, '[data-testid=instruction]', 'Open Tools');
    await page.goto('https://en.wikipedia.org/wiki/Unrelated', { waitUntil: 'load' });
    await waitUI(panel, '[data-testid=task-state]', 'Paused');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await button(panel, 'Resume').click();
    await waitUI(panel, '[data-testid=recovery]', 'supported only');
    r.checks.push(
      'G05/G08 hidden, duplicate, refresh, unsupported navigation; no stale outline or automatic continuation',
    );
    await page.goto(url, { waitUntil: 'load' });
    await button(panel, 'Restart task').click();
    await waitUI(panel, '[data-testid=instruction]', 'Open Tools');
    await page.evaluate(() => {
      document.querySelector('#p-tb').style.marginTop = '170vh';
    });
    await waitUI(panel, '.location', 'below');
    const old = (await view(panel)).v;
    const priorRef = old.snapshot.guide.ref;
    await page.evaluate(() => document.querySelector('#vector-page-tools-dropdown-label').remove());
    await waitUI(panel, '[data-testid=recovery]', 'can’t find');
    assert(!(await command(panel, { kind: 'reveal', ref: priorRef })).ok);
    assert.equal(await page.evaluate(() => window.activations), 0);
    r.checks.push('G12 removal before Show me rejected; no activation or replacement guess');
    await page.goto(
      'https://en.wikipedia.org/w/index.php?title=Special:CiteThisPage&page=Phishing&token=PRIVATE_QUERY_MARKER#APA_style',
      { waitUntil: 'load' },
    );
    await until(async()=>{const v=(await view(panel)).v;return v.task?.state==='paused'&&v.snapshot?.context.documentId&&v.snapshot.context.documentId!==old.snapshot.context.documentId},'new citation document inspected without replay');
    const beforeWrong=(await view(panel)).v;
    await start(panel);
    await until(async()=>{const v=(await view(panel)).v;return v.task?.id!==beforeWrong.task.id&&v.task?.state==='paused'&&v.snapshot?.context.documentId===beforeWrong.snapshot.context.documentId&&v.snapshot?.guide?.result==='missing'},'new task refused the wrong article');
    await waitUI(panel, '[data-testid=recovery]', 'can’t find');
    const wrong = (await view(panel)).v;
    assert.equal(wrong.task.state, 'paused');
    assert(!JSON.stringify(wrong).includes('PRIVATE_QUERY_MARKER'));
    r.checks.push(
      'G10 wrong article heading with plausible citation URL and APA section refused; arbitrary token excluded',
    );
  }
  async function late(s, r) {
    const { page, panel } = s;
    await start(panel);
    await waitUI(panel, '[data-testid=instruction]', 'Open Tools');
    const w = await workerHandle(s);
    async function hold() {
      await w.evaluate(() => {
        const orig = chrome.tabs.sendMessage.bind(chrome.tabs);
        chrome.tabs.sendMessage = async (...args) => {
          if (args[1]?.command?.kind === 'snapshot') {
            chrome.tabs.sendMessage = orig;
            const response = await orig(...args);
            await new Promise(
              (res) =>
                (globalThis.releaseGuide = () => {
                  delete globalThis.releaseGuide;
                  res();
                }),
            );
            return response;
          }
          return orig(...args);
        };
      });
      const pending = command(panel, { kind: 'guide', workflow: 'wikipedia_cite_apa' });
      await until(
        () => w.evaluate(() => typeof globalThis.releaseGuide === 'function'),
        'held guide snapshot',
      );
      return { pending };
    }
    let { pending } = await hold();
    assert((await command(panel, { kind: 'cancel' })).ok);
    await w.evaluate(() => globalThis.releaseGuide());
    assert(!(await pending).ok);
    assert.equal((await view(panel)).v.task.state, 'cancelled');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    ({ pending } = await hold());
    const b = await s.browser.newPage();
    await b.goto('about:blank');
    await b.bringToFront();
    await until(async () => (await view(panel)).v.task === null, 'isolated second tab');
    await w.evaluate(() => globalThis.releaseGuide());
    assert(!(await pending).ok);
    assert.equal((await view(panel)).v.snapshot, null);
    await page.bringToFront();
    await waitUI(panel, '[data-testid=task-state]', 'Paused');
    assert.equal(await page.$('[data-safestep-outline]'), null);
    await b.close();
    r.checks.push(
      'G07 real guide snapshot reply delayed through cancellation and active-tab switch; no cross-tab cue, replay or progress',
    );
  }
  async function addresses(s, r) {
    const { panel, page } = s;
    const seen = [];
    page.on('request', (q) => seen.push(new URL(q.url()).hostname));
    await panel.locator('summary::-p-text(Check page and link addresses)').click();
    await panel.select('details select', 'videolan_windows_page');
    await button(panel, 'Inspect addresses').click();
    await waitUI(panel, '[aria-label="Current page address"]', 'localhost');
    const v = (await view(panel)).v,
      by = Object.fromEntries(v.snapshot.controls.map((c) => [c.label, c]));
    assert(!JSON.stringify(v).includes('PRIVATE_FIXTURE_MARKER'));
    assert.equal(v.snapshot.address.host, 'localhost');
    const select = async (label, host) => {
      const c = by[label];
      assert(c, label);
      const list = await panel.$$('details select');
      await list[1].select(c.ref);
      await waitUI(panel, '[aria-label="Selected destination"]', host ?? 'Destination unknown');
      return c.address;
    };
    assert.equal(
      (await select('Relative Windows page', 'www.videolan.org')).relationship,
      'expected_host',
    );
    assert(
      (await select('Embedded brand', 'www.videolan.org.harmless.test')).flags.includes(
        'embedded_expected_domain',
      ),
    );
    assert((await select('Synthetic user-info', 'example.org')).flags.includes('user_info'));
    assert(
      (await select('One-letter typo', 'www.videolam.org')).flags.includes('similar_spelling'),
    );
    for (const l of ['Documented mirror host', 'Other sibling host']) {
      const a = await select(l, by[l].address.host);
      assert.equal(a.relationship, 'same_registered_domain_other_host');
      assert(!a.allowed);
    }
    assert.equal((await select('Private tenant', 'beta.github.io')).domain, 'beta.github.io');
    assert.equal((await select('Multi-label suffix', 'a.example.co.uk')).domain, 'example.co.uk');
    assert((await select('Trailing dot', 'www.videolan.org')).flags.includes('trailing_dot'));
    assert(
      (await select('International name', 'xn--bcher-kva.de')).flags.includes('international'),
    );
    for (const l of ['IPv4 address', 'IPv6 address'])
      assert((await select(l, by[l].address.host)).flags.includes('ip_address'));
    for (const l of ['Local host', 'Unknown suffix'])
      assert.equal((await select(l, by[l].address.host)).domain, null);
    assert.equal((await select('Invalid address')).relationship, 'invalid_or_unsupported_address');
    for (const l of ['Script-only control', 'Blob destination', 'Data destination'])
      assert.equal((await select(l)).relationship, 'uninspectable_destination');
    const label = Object.values(by).find((c) => c.address.flags.includes('label_mismatch'));
    assert(label);
    await select(label.label, 'example.org');
    assert.deepEqual((await select('External reference', 'example.org')).flags, []);
    await select('Unknown redirect outcome', 'www.videolan.org');
    assert(!seen.some((h) => h !== 'localhost' && h !== '127.0.0.1'));
    assert(!JSON.stringify(await view(panel)).includes('PRIVATE_FIXTURE_MARKER'));
    r.checkedLinks = v.snapshot.controls.length;
    r.checks.push(
      'U02–U08 actual panel selection, parsed local link metadata, private data excluded, zero destination fetches',
    );
    await panel.locator('summary::-p-text(Product features)').click();
    const rows = await panel.$$eval('ol li', (els) => els.map((e) => e.textContent));
    assert.equal(rows.length, 9);
    assert.equal(rows.filter((r) => r.includes('Available in Stage 2')).length, 2);
    r.checks.push('R02 all nine registry entries, only two marked available');
  }
  const selection = process.env.SAFESTEP_EDGE ?? 'all';
  if (selection === 'all' || selection === 'idle') {
    records.push(
      ...(await Promise.all(
        [
          [1440, 900],
          [1366, 768],
        ].map(([w, h]) => run('guide idle and layout', w, h, idle)),
      )),
    );
  }
  if (selection === 'all' || selection === 'variants')
    records.push(await run('guide variations', 1440, 900, variants));
  if (selection === 'all' || selection === 'late')
    records.push(await run('late replies', 1366, 768, late, { attachWorker: true }));
  if (selection === 'all' || selection === 'address') {
    const server = await startFixture(0);
    try {
      records.push(
        await run('address inspection', 1366, 768, addresses, {
          start: server.origin + '/addresses',
        }),
      );
    } finally {
      server.server.close();
    }
  }
  return records;
}
