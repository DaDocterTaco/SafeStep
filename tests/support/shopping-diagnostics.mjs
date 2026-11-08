// Optional diagnostic only. Read engine guard decisions from the frozen worker
// at the two comparison exceptions; the conditional logpoints never pause or
// replace its API calls. Record public source status, not request bodies/headers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function observeShoppingGuards(s, bundle, row) {
  row.diagnosticMethod =
    'Worker conditional logpoints on actual stale-guard throws plus read-only source HTTP status; diagnostic run distinct from ordinary Chrome journeys.';
  row.initialPageReady = await s.page.evaluate(() => document.readyState);
  await s.page.waitForFunction(
    () => document.readyState === 'complete' && !!document.body?.innerText.trim(),
    { timeout: 20000 },
  );
  const source = await readFile(join(bundle, 'background.js'), 'utf8');
  const worker = await s.browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + s.id + '/'),
  );
  const cdp = await worker.createCDPSession();
  const page = await s.page.createCDPSession();
  const events = (row.guardDiagnostics = []),
    requests = (row.publicSourceNetwork = []);
  for (const session of [cdp, page]) {
    const tracked = new Map();
    session.on('Network.requestWillBeSent', (e) => {
      const url = new URL(e.request.url);
      if (
        (url.hostname === 'api.resell.store' && url.pathname.startsWith('/v1/')) ||
        (url.hostname === 'addons.mozilla.org' && url.pathname.startsWith('/api/'))
      ) {
        const row = {
          at: new Date().toISOString(),
          source: url.origin,
          path: url.pathname,
          status: 'pending',
        };
        tracked.set(e.requestId, row);
        requests.push(row);
      }
    });
    session.on('Network.responseReceived', (e) => {
      const r = tracked.get(e.requestId);
      if (r) r.status = e.response.status;
    });
    session.on('Network.loadingFailed', (e) => {
      const r = tracked.get(e.requestId);
      if (r) r.status = e.errorText?.slice(0, 80) ?? 'transport_error';
    });
    await session.send('Network.enable');
  }
  cdp.on('Runtime.consoleAPICalled', (e) => {
    if (e.args[0]?.value === 'SAFE_STEP_GUARD_QA' && typeof e.args[1]?.value === 'string') {
      try {
        events.push(JSON.parse(e.args[1].value));
      } catch {}
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Debugger.enable');
  async function guardLog(offset, expression) {
    const lines = source.slice(0, offset).split('\n');
    const point = await cdp.send('Debugger.setBreakpointByUrl', {
      url: worker.url(),
      lineNumber: lines.length - 1,
      columnNumber: lines.at(-1).length,
      condition: `(console.info('SAFE_STEP_GUARD_QA',JSON.stringify(${expression})),false)`,
    });
    assert(point.locations.length, 'No actual guard breakpoint in the loaded release');
  }
  const start = source.indexOf('async valid('),
    end = source.indexOf('}source(', start);
  assert(
    start >= 0 && end > start,
    'Inspect the named release before setting diagnostic logpoints',
  );
  const code = source.slice(start, end),
    params = /async valid\((\w+),(\w+),(\w+)\)\{let (\w+)=await chrome\.tabs\.get/.exec(code);
  assert(params, 'Comparison guard symbols unavailable');
  const [, svar, owner, version, tab] = params;
  const checks = [...code.matchAll(/throw new \w+\(`stale_document`\)/g)];
  assert.equal(checks.length, 2);
  for (const [n, hit] of checks.entries()) {
    const expression = `({time:Date.now(),guard:${n === 0 ? '"tab/window/url"' : '"document/variant/owner"'},active:${tab}.active,sameWindow:${tab}.windowId===${owner}.window,sameURL:${tab}.url===${owner}.canonical,own:this.owners.get(${svar}.cp.tabId)===${owner},version:${svar}.comparison?.version===${version},epoch:${svar}.cp.epoch===${owner}.epoch,task:(${svar}.cp.task?.id??null)===${owner}.task})`;
    await guardLog(start + hit.index, expression);
  }
  const chatStart = source.indexOf('async currentPage('),
    chatEnd = source.indexOf('}finish(', chatStart);
  assert(chatStart >= 0 && chatEnd > chatStart, 'Current-page guard missing');
  const chat = source.slice(chatStart, chatEnd),
    cs = /async currentPage\((\w+),(\w+)\)/.exec(chat),
    tb = /let (\w+)=await chrome\.tabs\.get/.exec(chat),
    bound = /\.turn\.documentId!==(\w+)\|\|\w+\.turn\.scope!==(\w+)/.exec(chat);
  assert(cs && tb && bound, 'Current-page guard shape differs');
  const [, state, op] = cs,
    ct = tb[1];
  const chatChecks = [...chat.matchAll(/throw new \w+\(`stale_document`\)/g)];
  assert.equal(chatChecks.length, 3);
  for (const [n, hit] of chatChecks.entries()) {
    const values = `time:Date.now(),guard:'chat ${n}',owner:this.owns(${state},${op}),epoch:${state}.cp.epoch===${op}.turn.epoch`;
    const tabFacts =
      n > 0
        ? `,active:${ct}.active,window:${ct}.windowId===${op}.tab.windowId,origin:new URL(${ct}.url).origin===${op}.turn.origin`
        : '';
    const docFacts =
      n === 2
        ? `,priorDoc:${op}.turn.documentId!==null,document:${op}.turn.documentId===${bound[1]},scope:${op}.turn.scope===${bound[2]}`
        : '';
    await guardLog(chatStart + hit.index, `({${values}${tabFacts}${docFacts}})`);
  }
  await s.panel.evaluate(async () => {
    const w = await chrome.windows.getCurrent();
    globalThis.__safeStepTestLifecycle ??= [];
    let prior;
    setInterval(async () => {
      const current = await chrome.windows.get(w.id).catch(() => null);
      if (current?.focused === prior) return;
      prior = current?.focused;
      globalThis.__safeStepTestLifecycle?.push({
        at: new Date().toISOString(),
        kind: 'focus sample',
        focused: prior,
      });
    }, 125);
  });
  return async () => {
    await cdp.detach().catch(() => {});
    await page.detach().catch(() => {});
  };
}
