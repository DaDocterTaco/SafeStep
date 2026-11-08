import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { openArea } from './support/stage7-panel.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3');
const { sha256 } = await fingerprint(bundle),
  out = resolve('.test-artifacts/repairs', sha256.slice(0, 12));
await mkdir(out, { recursive: true });
const wiki = 'https://en.wikipedia.org/wiki/Phishing',
  vlc = 'https://www.videolan.org/',
  citation = 'https://en.wikipedia.org/w/index.php?title=Special%3ACiteThisPage&page=Phishing';
const startPage = await readFile(new URL('./fixtures/guidance.html', import.meta.url), 'utf8');
const citePage =
  '<title>Labelled rapid citation fixture</title><main><h1 id="firstHeading">Cite This Page</h1><h2>Citation styles for "Phishing"</h2><a id="jump" href="#APA_style">APA</a><h3 id="MLA_style" tabindex="-1" style="margin-top:160vh">MLA style</h3><h3 id="APA_style" style="margin-top:100vh">APA style</h3><p style="height:120vh">Fixture citation</p></main>';
async function prepare(p) {
  await p.setRequestInterception(true);
  p.on('request', (q) => {
    if (q.isNavigationRequest() && new URL(q.url()).hostname === 'en.wikipedia.org')
      void q.respond({
        status: 200,
        contentType: 'text/html',
        headers: { 'Cache-Control': 'no-store' },
        body: new URL(q.url()).pathname === '/wiki/Phishing' ? startPage : citePage,
      });
    else void q.abort();
  });
}
const btn = (p, n) => p.locator('::-p-aria(' + n + '[role="button"])').setTimeout(6000);
async function ui(p, sel, match) {
  await p.waitForFunction(
    (s, m) => [...document.querySelectorAll(s)].some((el) =>
      el.getClientRects().length && el.innerText.includes(m)),
    { timeout: 7500 },
    sel,
    match,
  );
}
async function input(p, g) {
  await p.focus('#goal');
  await p.$eval('#goal', (e) => e.select());
  await p.keyboard.type(g);
  await p.keyboard.press('Enter');
}
async function key(p, name) {
  const el = await p.waitForSelector('::-p-aria(' + name + '[role="button"])');
  await el.focus();
  assert(await el.evaluate((button) => document.activeElement === button));
  await p.keyboard.press('Enter');
}
const trials = [];
async function run(id, width, height, start, fn, options = {}) {
  const rec = { id, width, height, checks: [], status: 'fail' };
  let s;
  try {
    s = await nativeSession(bundle, width, height, start, options);
    rec.dimensions = s.dimensions;
    rec.chrome = await s.browser.version();
    await openArea(s.panel, 'Guide');
    await fn(s, rec);
    rec.status = 'pass';
  } catch (e) {
    rec.error = e.message.split('\n')[0];
    if (s) {
      const v = (await view(s.panel).catch(() => ({ v: {} }))).v;
      rec.diagnostic = {
        state: v.task?.state,
        issue: v.issue,
        result: v.snapshot?.guide?.result,
        step: v.task?.guide?.step,
        fragment: new URL(s.page.url()).hash,
      };
    }
  } finally {
    if (s) await s.browser.close();
  }
  console.log(rec.status, id, width, rec.checks, rec.error ?? '');
  return rec;
}
async function goals({ panel, page }, r) {
  const video = new URL(page.url()).host === 'www.videolan.org';
  const negative = video
    ? [
        'Help me find the Firefox download for Windows.',
        'Find VLC for macOS',
        'Do not download VLC; find Firefox',
        'Install VLC for Windows',
      ]
    : ['Find the APA citation for the Moon landing article.', 'Find the MLA citation'];
  for (const g of negative) {
    await input(panel, g);
    if(video && await panel.$('[role=tablist]')){
      await panel.waitForFunction(()=>/different product|different.*package|Installation stays with you/.test(document.querySelector('[aria-label="Guided task"]')?.innerText??''));
    }else await ui(panel, 'section[aria-label="Guided task"]', 'Choose one of these two tasks');
    assert.equal(await panel.$eval('#goal', (e) => e.value), g);
    assert.equal((await view(panel)).v.task, null);
    assert.equal(await page.$('[data-safestep-outline]'), null);
    r.checks.push(g);
  }
  for (const g of video
    ? [
        'Where is the Windows download page?',
        'Find VLC for Windows',
        'Show the official Windows VLC page',
        'Help me find VLC for Windows.',
      ]
    : [
        'Find an APA citation',
        'How do I cite this page?',
        'Show the article citation',
        'Help me find the APA citation for this article.',
      ]) {
    await input(panel, g);
    await panel.waitForFunction(
      (goal) =>
        document.querySelector('#goal').value === goal &&
        document.querySelector('[data-testid=task-state]')?.textContent === 'Showing highlight',
      {},
      g,
    );
    for (let i = 0; i < 35 && (await view(panel)).v.task?.goal !== g; i++) await delay(60);
    const task = (await view(panel)).v.task;
    assert.equal(task.goal, g);
    assert.equal(task.guide.workflow, video ? 'videolan_windows_page' : 'wikipedia_cite_apa');
    r.checks.push('Preserved ' + g);
  }
}
async function sequence(s, r) {
  const { page, panel } = s;
  await key(panel, 'Choose a supported task');
  await key(panel, 'Wikipedia · APA citation');
  const focus = () =>
    panel.evaluate(() => ({
      name: document.activeElement.textContent,
      visible: document.activeElement.matches(':focus-visible'),
      outline: getComputedStyle(document.activeElement).outlineStyle,
    }));
  let f = await focus();
  assert.equal(f.name, 'Your guide');
  assert(f.visible && f.outline !== 'none');
  await ui(panel, '[data-testid=instruction]', 'Open Tools');
  await panel.keyboard.press('Tab');
  assert.equal((await focus()).name, 'Pause');
  await page.evaluate(() => (document.querySelector('#p-tb').style.marginTop = '170vh'));
  await ui(panel, '.location', 'below');
  await key(panel, 'Show me');
  f = await focus();
  assert.equal(f.name, 'Your guide');
  assert(f.visible);
  await panel.focus('#goal');
  await delay(150);
  assert(await panel.$eval('#goal', (e) => e === document.activeElement));
  r.checks.push(
    'Picker and reveal restored visible guide focus, Tab reached Pause, subsequent focus preserved',
  );
  await page.click('#vector-page-tools-dropdown-label');
  await ui(panel, '[data-testid=instruction]', 'Choose Cite');
  await page.evaluate(
    () => (document.querySelector('#t-cite a').href = 'https://unexpected.test/cite'),
  );
  await ui(panel, '[data-testid=recovery]', 'expected destination');
  r.checks.push('Prior altered destination produced warning');
  for (const mode of ['keyboard', 'pointer', 'paused', 'cancelled']) {
    await page.goto(citation + '#MLA_style', { waitUntil: 'load' });
    await delay(170);
    await input(panel, 'Find an APA citation');
    await ui(panel, '[data-testid=instruction]', 'Choose APA');
    if (mode === 'paused' || mode === 'cancelled') {
      await btn(panel, mode === 'paused' ? 'Pause' : 'Cancel task').click();
      await ui(panel, '[data-testid=task-state]', mode === 'paused' ? 'Paused' : 'Cancelled');
    }
    if (mode === 'pointer') await page.click('#jump');
    else {
      await page.focus('#MLA_style');
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      assert(await page.$eval('#jump', (e) => e === document.activeElement));
      await page.keyboard.press('Enter');
    }
    await page.waitForFunction(
      () =>
        location.hash === '#APA_style' &&
        document.querySelector('#APA_style').getBoundingClientRect().top < innerHeight,
    );
    const expected =
      mode === 'paused' ? 'Paused' : mode === 'cancelled' ? 'Cancelled' : 'Completed';
    await ui(panel, '[data-testid=task-state]', expected);
    await delay(180);
    assert.equal(await panel.$eval('[data-testid=task-state]', (e) => e.textContent), expected);
    r.checks.push(mode + ' APA jump: ' + expected);
  }
}
for (const [w, h] of [
  [1440, 900],
  [1366, 768],
]) {
  if(process.env.SAFESTEP_WIDTH && Number(process.env.SAFESTEP_WIDTH)!==w)continue;
  const requested=process.env.SAFESTEP_SS2_CASES?.split(',');
  for (const [name,start] of [['wiki',wiki],['vlc',vlc]])
    if(!requested||requested.includes(name))trials.push(await run('SS2-01 ' + new URL(start).hostname, w, h, start, goals));
  if(!requested||requested.includes('apa'))trials.push(await run('SS2-02/03', w, h, wiki, sequence, { prepare }));
}
const trial=process.env.SAFESTEP_REPAIR_TRIAL;
const suffix=trial||[process.env.SAFESTEP_SS2_CASES?.replaceAll(',','-'),process.env.SAFESTEP_WIDTH].filter(Boolean).join('-');
if(suffix&&!/^[a-z0-9-]{1,50}$/i.test(suffix))throw Error('Invalid repair trial label');
await writeFile(
  join(out, suffix?'results-'+suffix+'.json':'results.json'),
  JSON.stringify({ bundle, sha256, updated: new Date().toISOString(), trials }, null, 2) + '\n',
);
if (!trials.length || trials.some((t) => t.status !== 'pass')) process.exitCode = 1;
