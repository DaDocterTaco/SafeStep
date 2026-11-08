import { startFixture } from '../fixtures/serve.mjs';
import { pathToFileURL } from 'node:url';
const { run, click, until, waitText, sleep, assert, goal, readFile, suite } = await import(
  pathToFileURL(process.env.SAFESTEP_REPAIR_SESSION).href
);
const fixture = await startFixture(0);
const settings = await readFile('tests/fixtures/assist-lab.html', 'utf8'),
  cleanup = await readFile('tests/fixtures/cleanup-lab.html', 'utf8');
const adaptive = '[data-testid=assist-state]',
  clean = 'section[aria-label="Page cleanup"] > p[role=status]';
const opts = (pathname, body) => ({
  fixture: true,
  intercept: async (q, u) => {
    if (!q.isNavigationRequest() || u.origin !== fixture.origin || u.pathname !== pathname)
      return false;
    await q.respond({ status: 200, contentType: 'text/html; charset=utf-8', body });
    return true;
  },
});
async function rehearse(s) {
  await s.page.bringToFront();
  await s.panel.evaluate(async () => {
    const w = await chrome.windows.getCurrent();
    if (!w.focused) await chrome.windows.update(w.id, { focused: true });
  });
  await goal(s.panel, 'Find my username settings');
  await waitText(s.panel, adaptive, 'awaiting confirmation');
  await click(s.panel, 'Guide me');
}
async function heading(mode) {
  const pathname = '/settings-lab/username';
  const finish =
    mode === 'uncover'
      ? '<div id="opaque" style="position:fixed;inset:0;background:white;z-index:5000"><button id="uncover" onclick="this.parentElement.remove()">Uncover username heading</button></div>'
      : '<script>document.querySelector("main h1").textContent="Wrong practice subject";</script>';
  return run(
    'nearby-' + mode,
    fixture.origin + pathname,
    async (s, r) => {
      await rehearse(s);
      await sleep(450);
      const first = await s.panel.$eval(adaptive, (e) => e.innerText);
      assert(!first.includes('completed'));
      r.observations.push({ initial: first });
      if (mode === 'uncover') {
        await s.page.click('#uncover');
        await rehearse(s);
        await waitText(s.panel, adaptive, 'completed');
        const visible = await s.page.$eval('main h2', (e) => {
          const b = e.getBoundingClientRect();
          return e.contains(document.elementFromPoint(b.left + 15, b.top + b.height / 2));
        });
        assert(visible);
        r.observations.push({
          uncoveredVisible: visible,
          state: await s.panel.$eval(adaptive, (e) => e.innerText),
        });
      }
    },
    opts(pathname, settings + finish),
  );
}
async function lifecycle(mode) {
  const pathname = '/cleanup-lab';
  const html =
    cleanup.replace(
      '<header>',
      '<fieldset><legend>Builder synthetic fixture controls</legend><button id="site">Change the fixture</button></fieldset><header>',
    ) +
    '<script>site.onclick=()=>{const e=document.querySelector("#practice-backdrop");window.qaOldBackdrop=e;' +
    (mode === 'detach'
      ? 'e.remove();'
      : 'const n=e.cloneNode(false);n.removeAttribute("data-safestep-clean");n.dataset.siteRevision="replacement";e.replaceWith(n);') +
    '};</script>';
  return run(
    'nearby-' + mode,
    fixture.origin + pathname,
    async (s, r) => {
      await click(s.panel, 'Preview cleanup');
      await s.panel.waitForSelector(clean);
      await click(s.panel, 'Apply cleanup');
      await waitText(s.panel, clean, '2 hidden');
      await s.page.click('#site');
      await sleep(1150);
      const fact = await s.page.evaluate(() => ({
        popup: getComputedStyle(document.querySelector('#practice-offer')).display,
        backdrop: document.querySelector('#practice-backdrop')
          ? getComputedStyle(document.querySelector('#practice-backdrop')).display
          : null,
        lock: document.body.hasAttribute('data-safestep-clean-lock'),
        oldTagged: window.qaOldBackdrop.hasAttribute('data-safestep-clean'),
        oldConnected: window.qaOldBackdrop.isConnected,
        centerHit: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id,
      }));
      const status = await s.panel.$eval(clean, (e) => e.innerText);
      assert.equal(fact.oldConnected, false);
      assert.equal(fact.oldTagged, false);
      if (fact.popup === 'none') {
        assert(
          mode === 'replace' &&
            fact.backdrop === 'none' &&
            fact.lock &&
            status.includes('2 hidden'),
        );
      } else {
        assert(!fact.lock && status.includes('1 hidden'));
      }
      await click(s.panel, 'Restore cleanup');
      await waitText(s.panel, clean, '0 hidden');
      assert.equal(
        await s.page.$$eval('[data-safestep-clean],[data-safestep-clean-lock]', (xs) => xs.length),
        0,
      );
      const left = await s.page.$eval('body', (e) => ({
        backdrop: e.querySelector('#practice-backdrop')?.dataset.siteRevision ?? null,
        overflow: getComputedStyle(e).overflow,
      }));
      assert.equal(left.overflow, 'hidden');
      assert.equal(left.backdrop, mode === 'replace' ? 'replacement' : null);
      r.observations.push({ mode, status, fact, afterRestore: left });
    },
    opts(pathname, html),
  );
}
async function protectedControls() {
  const pathname = '/cleanup-lab',
    regions =
      '<div role="region" aria-label="Cookie consent choices"><aside aria-label="Sponsored"><button id="choice">Manage options</button></aside></div>' +
      '<div role="navigation" aria-label="Primary navigation"><aside aria-label="Sponsored"><button id="menu">Show menu</button></aside></div>' +
      '<div contenteditable="true" aria-label="Draft editor"><aside aria-label="Sponsored" id="draft">Editable text</aside></div>' +
      '<button id="grow">Insert protected navigation action</button>';
  const html =
    cleanup.replace('<header>', regions + '<header>') +
    '<script>window.hits=[];document.addEventListener("click",e=>{if(e.target.id)window.hits.push(e.target.id)});grow.onclick=()=>{const a=document.createElement("aside");a.setAttribute("aria-label","Sponsored");a.innerHTML=\'<button id="moremenu">New menu action</button>\';menu.parentElement.parentElement.append(a);};</script>';
  return run(
    'nearby-protected-interaction',
    fixture.origin + pathname,
    async (s, r) => {
      const { page, panel } = s;
      await click(panel, 'Preview cleanup');
      await panel.waitForSelector(clean);
      await click(panel, 'Apply cleanup');
      await waitText(panel, clean, '2 hidden');
      await page.click('#grow');
      await sleep(900);
      for (const id of ['choice', 'menu', 'draft', 'moremenu'])
        assert(
          await page.$eval('#' + id, (e) => {
            const b = e.getBoundingClientRect();
            return (
              b.height > 0 &&
              e.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))
            );
          }),
          id + ' reachable by pointer',
        );
      for (const id of ['choice', 'menu', 'moremenu']) {
        await page.click('#' + id);
        await page.keyboard.press('Enter');
      }
      const hits = await page.evaluate(() => window.hits);
      for (const id of ['choice', 'menu', 'moremenu'])
        assert(hits.filter((x) => x === id).length >= 2);
      await click(panel, 'Restore cleanup');
      await waitText(panel, clean, '0 hidden');
      r.observations.push({ receivedPointerAndKeyboard: hits });
    },
    opts(pathname, html),
  );
}
try {
  if (['uncover', 'wrong-subject'].includes(suite)) await heading(suite);
  else if (['detach', 'replace'].includes(suite)) await lifecycle(suite);
  else if (suite === 'protected-interaction') await protectedControls();
  else throw Error('Unknown nearby case');
} finally {
  fixture.server.close();
}
