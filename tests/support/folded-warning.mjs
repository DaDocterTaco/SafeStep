import assert from 'node:assert/strict';
import { join } from 'node:path';
import { button, until } from './design-cues.mjs';

// Read the real closed extension shadow root without changing its contents. Use
// physical hit coordinates for the warning action, never injected click events.
async function edge(s) {
  const tree = (await s.tabSession.send('DOM.getDocument', { depth: -1, pierce: true })).root;
  const nodes = [tree];
  let host;
  while (nodes.length) {
    const n = nodes.pop();
    if (n.attributes?.includes('data-safestep-protection')) {
      host = n;
      break;
    }
    nodes.push(...(n.children ?? []), ...(n.shadowRoots ?? []));
  }
  const root = host?.shadowRoots?.[0];
  if (!root) return null;
  const { object } = await s.tabSession.send('DOM.resolveNode', {
    backendNodeId: root.backendNodeId,
  });
  try {
    const data = await s.tabSession.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function(){
        const box=this.querySelector('section'),btn=this.querySelector('[data-warning-action="fold"]'),r=btn.getBoundingClientRect();
        return {mode:this.host.dataset.warningMode,panel:this.host.dataset.panelPresent,text:box.innerText,
          links:[...box.querySelectorAll('a[href]')].filter(e=>e.checkVisibility()).map(e=>({label:e.innerText,url:e.href})),
          fold:{x:r.left+r.width/2,y:r.top+r.height/2}};
      }`,
    });
    return data.result.value;
  } finally {
    await s.tabSession.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
function positive(snapshot, mode) {
  assert.equal(snapshot.mode, mode);
  assert.match(snapshot.text, /possible unwanted software for this exact page/i);
  assert(
    snapshot.links.some(
      (a) =>
        a.label === 'Advisory provided by Google' &&
        a.url === 'https://docs.cloud.google.com/web-risk/docs/advisory',
    ),
  );
  assert(
    snapshot.links.some(
      (a) =>
        a.label === 'Learn about unwanted software' &&
        a.url === 'https://www.google.com/about/unwanted-software-policy.html',
    ),
  );
  assert(
    !snapshot.links.some(
      (a) => a.label === 'Learn about phishing' || a.label === 'Learn about malware',
    ),
  );
}
export async function verifyFoldedPositive(s, row, output) {
  const expanded = await until(async () => {
    const e = await edge(s);
    return e?.mode === 'expanded' && e;
  }, 'expanded attributed page warning');
  positive(expanded, 'expanded');
  await s.page.mouse.click(expanded.fold.x, expanded.fold.y);
  const folded = await until(async () => {
    const e = await edge(s);
    return e?.mode === 'compact' && e;
  }, 'trusted page-only warning tuck');
  positive(folded, 'compact');
  await s.activate(s.page);
  const target = await s.browser.waitForTarget((t) => t.url().endsWith(s.id + '/sidepanel.html'));
  const panel = await target.asPage();
  const snapshot = () =>
    panel.$eval('[aria-label="Current website warning"]', (box) => ({
      mode: box.dataset.warningMode,
      text: box.innerText,
      links: [...box.querySelectorAll('a[href]')]
        .filter((e) => e.checkVisibility())
        .map((e) => ({ label: e.innerText, url: e.href })),
    }));
  const native = await until(async () => {
    const p = await snapshot();
    return p.mode === 'expanded' && p;
  }, 'expanded native warning');
  positive(native, 'expanded');
  const counterpart = await until(async () => {
    const p = await edge(s);
    return p?.panel === 'true' && p.mode === 'compact' && p;
  }, 'page counterpart with the bound panel visible');
  positive(counterpart, 'compact');
  await button(panel, 'Tuck warning').click();
  const nativeFold = await until(async () => {
    const p = await snapshot();
    return p.mode === 'compact' && p;
  }, 'folded native warning');
  positive(nativeFold, 'compact');
  positive(await edge(s), 'compact');
  const screen = row.width + '-folded-positive-warning.png';
  await panel.screenshot({ path: join(output, screen) });
  row.screens.push(screen);
  row.foldedAdvisory = {
    qualified: 'possible unwanted software',
    scope: 'exact public page',
    expandedPage: true,
    foldedPage: true,
    expandedNative: true,
    compactCounterpart: true,
    foldedNative: true,
    links: nativeFold.links.map((x) => x.label),
  };
  await panel.evaluate(async () =>
    chrome.sidePanel.close({ windowId: (await chrome.windows.getCurrent()).id }),
  );
  await until(
    async () =>
      !(await s.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
        t.url.endsWith(s.id + '/sidepanel.html'),
      ),
    'closed folded panel before next automatic arrival',
  );
}
