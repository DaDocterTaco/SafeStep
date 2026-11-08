import assert from 'node:assert/strict';
import {openArea,openAdvanced} from './stage7-panel.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);
const button = (p, label) => p.locator('::-p-aria(' + label + '[role="button"])').setTimeout(8000);
const until = async (fn, name) => {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(65);
  }
  throw Error('Timed out: ' + name);
};
async function permission(s, choice) {
  await button(s.panel, 'Enable on this site').click();
  await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('tests/support/permission.ps1'),
      '-BrowserProcessId',
      String(s.browser.process().pid),
      '-Choice',
      choice,
    ],
    { windowsHide: true, timeout: 15000 },
  );
}
export function stage6Edges({
  prepare,
  configure,
  click,
  state,
  current,
  options,
  scenario,
  snapshot,
  view,
  base,
  field,
  type,
}) {
  return {
    async reviewBudget(s, r) {
      await scenario(s, 'exact');
      const first = await prepare(s);
      assert(first.baseline.productEvidence?.sample > 0);
      await configure(s.panel, {});
      const initial = await options(s.panel);
      let currentResult = initial;
      for (let n = 0; n < 3; n++) {
        const prior = currentResult;
        const priorReads=s.sourceReadCount();
        await openArea(s.panel,'Safety checks');await openArea(s.panel,'Shopping');
        assert.equal(s.sourceReadCount(),priorReads);
        await s.panel.waitForFunction(
          (v, message) => {
            const status = document.querySelector('[data-testid="comparison-status"]');
            return status?.dataset.revision === String(v) && status.innerText.includes(message);
          },
          { timeout: 8000 },
          prior.version,
          prior.message,
        );
        await click(s.panel, 'Refresh evidence', true);
        currentResult = await state(
          s.panel,
          (c) =>
            c.version > prior.version &&
            ['ready', 'needs_checking', 'partial', 'only_baseline', 'no_matches'].includes(
              c.status,
            ),
          'explicit re-read ' + n,
        );
      }
      assert.equal(currentResult.baseline.catalog, first.baseline.catalog);
      assert.equal(currentResult.baseline.productEvidence, null);
      assert(
        currentResult.candidates
          .filter((c) => c.offer.catalog === first.baseline.catalog)
          .every((c) => !c.offer.productEvidence),
      );
      const ledger = await s.panel.evaluate(() => chrome.storage.session.get('shop-set-budget'));
      const groups = Object.values(ledger['shop-set-budget'] ?? {});
      assert(groups.some((slots) => slots.length === 3));
      assert(groups.every((slots) => slots.length <= 3));
      await snapshot(s, r, currentResult);
      r.checks.push(
        'Actual repeated comparison enrichment reached the shared three-capture subject limit. Later explicit refreshes kept the catalog identity and current offers, without returning a fourth feedback set.',
      );
      if(await s.panel.$('[role=tablist]'))r.caseChecks={'S7-I07':[r.checks.at(-1)+' Switching areas neither initiated a read nor restored the subject budget.']};
    },
    async window(s, r) {
      await scenario(s, 'delayed');
      await prepare(s);
      await configure(s.panel, {});
      await click(s.panel, 'Find options');
      const old = await state(s.panel, (c) => c.status === 'searching', 'pending window task');
      const other = await s.panel.evaluate(async () => {
        const w = await chrome.windows.create({
          url: 'about:blank',
          focused: true,
          width: 640,
          height: 480,
        });
        return w.id;
      });
      try {
        await delay(2000);
      } finally {
        await s.panel.evaluate((id) => chrome.windows.remove(id), other);
      }
      await s.page.bringToFront();
      const retired = await state(
        s.panel,
        (c) => ['stale', 'paused', 'cancelled'].includes(c.status),
        'window retirement',
      );
      assert(retired.version > old.version);
      assert(!retired.candidates.some((c) => c.recommended));
      r.checks.push(
        'A different focused Chrome window during delayed discovery retired the original version; late evidence did not restore its recommendation.',
      );
    },
    async pendingRecovery(s, r) {
      await scenario(s, 'delayed');
      await prepare(s);
      await configure(s.panel, {});
      await click(s.panel, 'Find options');
      const searching = await state(
        s.panel,
        (c) => c.status === 'searching',
        'pending recovery task',
      );
      const w = await (
        await s.browser.waitForTarget(
          (t) => t.type() === 'service_worker' && t.url().includes(s.id),
        )
      ).worker();
      await w.close();
      const restored = await state(
        s.panel,
        (c) => ['paused', 'stale'].includes(c.status),
        'recovered paused',
      );
      assert.equal(restored.id, searching.id);
      const reads = s.sourceReadCount();
      await delay(2100);
      assert.equal(s.sourceReadCount(), reads);
      assert.equal((await current(s.panel)).candidates.length, 0);
      assert(s.page.url().endsWith('/original'));
      r.checks.push(
        'Terminated the extension worker with a search in flight. The resumed checkpoint was paused with no replayed fetch, offer activation, or old candidates.',
      );
    },
    async permissions(s, r) {
      await openArea(s.panel,'Settings');
      await s.panel.locator('summary::-p-text(Access & preferences)').click();
      await permission(s, 'Deny');
      assert.equal((await view(s.panel)).v.prefs.sites.length, 0);
      await permission(s, 'Allow');
      await until(async () => (await view(s.panel)).v.access === 'site', 'host allowed');
      await scenario(s, 'delayed');
      await prepare(s);
      await configure(s.panel, {});
      await click(s.panel, 'Find options');
      await state(s.panel, (c) => c.status === 'searching', 'search started');
      const removed = await s.panel.evaluate(
        (url) =>
          chrome.permissions.remove({
            origins: [new URL(url).protocol + '//' + new URL(url).hostname + '/*'],
          }),
        s.page.url(),
      );
      assert(removed);
      await until(async () => (await view(s.panel)).v.access === 'permission_revoked', 'revoked');
      await delay(1750);
      assert(!(await current(s.panel)));
      const total = r.requests.length;
      await delay(300);
      assert.equal(r.requests.length, total);
      await s.activate(s.page);
      await until(async () => (await view(s.panel)).v.access === 'temporary', 'new toolbar grant');
      await scenario(s, 'exact');
      const renewed = await prepare(s);
      assert.equal(renewed.baseline.id, 'original');
      r.checks.push(
        'Native site grant denied, then granted. Removing it in Chrome during comparison retired the session and late results; explicit toolbar access prepared a fresh baseline.',
      );
    },
    async edits(s, r) {
      await scenario(s, 'delayed');
      await prepare(s);
      await configure(s.panel, {});
      await click(s.panel, 'Find options');
      const p = await state(s.panel, (c) => c.status === 'searching', 'pending');
      await click(s.panel, 'Edit requirements');
      await state(
        s.panel,
        (c) => c.version > p.version && c.status === 'idle',
        'edit fenced discovery',
      );
      await configure(s.panel, {
        mode: 'similar_products',
        query: 'different public terms',
        differences: ['model'],
        budget: { amount: '5.00', currency: 'USD', basis: 'item' },
      });
      await click(s.panel, 'Find options');
      const changed = await state(
        s.panel,
        (c) => c.status === 'searching' && c.settings.query === 'different public terms',
        'changed query',
      );
      assert.equal(changed.settings.budget.basis, 'item');
      await s.page.evaluate(() => {
        const tag = document.createElement('span');
        tag.setAttribute('data-comparison-variant', 'new-case');
        document.querySelector('main').append(tag);
      });
      const stale = await state(
        s.panel,
        (c) => c.version > changed.version && c.status === 'stale',
        'variant changed',
      );
      await delay(1750);
      assert.equal((await current(s.panel)).version, stale.version);
      assert(!(await current(s.panel)).candidates.some((c) => c.recommended || c.savings));
      await s.page.goto(new URL('alternative', base).href);
      await until(async () => {
        const c = await current(s.panel);
        return !c || ['stale', 'paused'].includes(c.status);
      }, 'new document fenced');
      const original = await current(s.panel);
      if (original?.baseline) assert.equal(original.baseline.id, 'original');
      r.checks.push(
        'Edit aborted a pending search; changed mode/budget were retained. A changed variant and a new document invalidated the original operation without attaching an old result to the new item.',
      );
    },
    async expiry(s, r) {
      await scenario(s, 'exact');
      await prepare(s);
      await configure(s.panel, {});
      const before = await options(s.panel);
      assert(before.candidates.some((c) => c.savings));
      const w = await (
        await s.browser.waitForTarget(
          (t) => t.type() === 'service_worker' && t.url().includes(s.id),
        )
      ).worker();
      const count = r.requests.filter((x) => x.fromExtension).length;
      try {
        await w.evaluate(() => {
          globalThis.stage6Clock = Date.now;
          Date.now = () => globalThis.stage6Clock() + 301000;
        });
        const expired = await state(s.panel, (c) => c.status === 'stale', '5-minute expiry');
        assert(expired.candidates.every((c) => !c.savings && !c.subtotal && !c.recommended));
        assert.equal(r.requests.filter((x) => x.fromExtension).length, count);
      } finally {
        await w.evaluate(() => {
          if (globalThis.stage6Clock) {
            Date.now = globalThis.stage6Clock;
            delete globalThis.stage6Clock;
          }
        });
      }
      await click(s.panel, 'Refresh evidence');
      const fresh = await state(
        s.panel,
        (c) => c.status === 'ready' && c.candidates.some((x) => x.savings),
        'explicit refresh',
      );
      assert(Date.parse(fresh.at) > Date.parse(before.at));
      await snapshot(s, r, fresh);
      r.checks.push(
        'Advanced only the isolated worker clock by 301 seconds. Current savings and badges were removed without a source request. Explicit Refresh re-read the source and produced a later timestamp.',
      );
    },
    async cleanup(s, r) {
      await scenario(s, 'exact');
      await openAdvanced(s.panel);
      await button(s.panel, 'Inspect page').click();
      await button(s.panel, 'Highlight Inspect practice alternate offer').click();
      const guided = await until(async () => {
        const v = (await view(s.panel)).v;
        return v.cue?.ref && v.snapshot && v;
      }, 'page guidance bound to the alternate-offer control');
      assert(await s.page.$('[data-safestep-outline]'));
      await prepare(s);
      await configure(s.panel, {});
      const before = await options(s.panel);
      const original = before.baseline;
      const visible = () =>
        s.page.$eval(
          '[data-shopping-evidence]',
          (e) => e.checkVisibility() && e.innerText.includes('Practice listing'),
        );
      assert(await visible());
      assert.equal((await view(s.panel)).v.cue?.ref, guided.cue.ref);
      await openArea(s.panel,'Guide');
      await button(s.panel, 'Preview cleanup').click();
      await until(
        async () => (await view(s.panel)).v.cleanup?.items.some((x) => !x.hidden),
        'recognized ad',
      );
      await button(s.panel, 'Apply cleanup').click();
      await until(async () => (await view(s.panel)).v.cleanup?.hidden >= 1, 'ad hidden');
      assert(await visible());
      const cleaned = (await view(s.panel)).v;
      assert.equal(cleaned.task?.state, 'paused');
      assert(
        !cleaned.cue && cleaned.snapshot?.context.revision !== guided.snapshot.context.revision,
      );
      assert.equal(await s.page.$('[data-safestep-outline]'), null);
      let c = await current(s.panel);
      assert.equal(c.baseline.id, original.id);
      assert.deepEqual(c.baseline.cost, original.cost);
      assert.deepEqual(c.baseline.sellerEvidence, original.sellerEvidence);
      await button(s.panel, 'Restore cleanup').click();
      await until(async () => (await view(s.panel)).v.cleanup?.hidden === 0, 'ad restored');
      assert(await visible());
      c = await current(s.panel);
      assert.equal(c.baseline.id, original.id);
      r.checks.push(
        'The manual guide outlined the alternate-offer link while comparison results were present. Cleanup retired its old reference and outline, hid and restored the neighboring ad, and preserved the visible listing, original price and seller evidence.',
      );
    },
    async boundaries(s, r) {
      await scenario(s, 'exact');
      await prepare(s);
      await configure(s.panel, {
        mode: 'compare_selected',
        query: '',
        goal: 'Compare selected offers',
      });
      await options(s.panel);
      await type(s.panel, 'Supported offer URL', base + 'better');
      await click(s.panel, 'Add offer');
      const c = await state(
        s.panel,
        (x) => x.candidates.some((y) => y.offer.id === 'better'),
        'checked canonical selected offer',
      );
      await type(s.panel, 'Supported offer URL', base + 'better');
      await click(s.panel, 'Add offer');
      await delay(350);
      assert.equal(
        (await current(s.panel)).candidates.filter((x) => x.offer.id === 'better').length,
        1,
      );
      const before = r.requests.filter((x) => x.fromExtension).length;
      for (const url of [
        'https://other.test/checkout',
        'https://nibdrawer.resell.store/checkout',
        base + 'better?token=PRIVATE_TEST',
      ]) {
        await type(s.panel, 'Supported offer URL', url);
        await click(s.panel, 'Add offer');
        await delay(80);
      }
      assert.equal(r.requests.filter((x) => x.fromExtension).length, before);
      await s.page.evaluate(() => {
        const region = document.createElement('aside');
        region.innerHTML =
          '<form><input value="PRIVATE_COMPARE_TEST"><input aria-label="Buyer" value="QA comparison buyer"><textarea aria-label="Private draft review">QA raw review sentinel</textarea><button>Buy now</button><button>Install</button></form><a href="/checkout">Checkout</a>';
        document.body.append(region);
        document.addEventListener(
          'click',
          (e) => {
            if (e.composedPath().includes(region)) {
              e.preventDefault();
              region.dataset.activated = 'yes';
            }
          },
          true,
        );
      });
      const requestCount = r.requests.filter((req) => req.fromExtension).length;
      const priorRefresh = await current(s.panel);
      await click(s.panel, 'Refresh evidence');
      const refreshed = await state(
        s.panel,
        (x) =>
          x.version > priorRefresh.version &&
          Date.parse(x.baseline.captured) > Date.parse(priorRefresh.baseline.captured) &&
          x.candidates.some((y) => y.offer.id === 'better') &&
          !['searching', 'checking_candidates', 'comparing'].includes(x.status),
        'fresh capture with private form present',
      );
      assert(Date.parse(refreshed.baseline.captured) > Date.parse(c.baseline.captured));
      assert(r.requests.filter((req) => req.fromExtension).length > requestCount);
      assert.equal(r.privateOutbound, 0);
      await openArea(s.panel,'Guide');
      await s.panel.focus('#goal');
      await s.panel.$eval('#goal', (e) => e.select());
      await s.panel.keyboard.type('Buy this product');
      await s.panel.keyboard.press('Enter');
      await until(async () => {
        const t = (await view(s.panel)).v.task;
        return t?.adaptive && t.state === 'paused';
      }, 'manual handoff on shopping route');
      assert.equal(
        await s.page.$eval('aside:last-child', (e) => e.dataset.activated ?? null),
        null,
      );
      assert.equal(await s.page.url(), c.baseline.url);
      const stored = await s.panel.evaluate(() => chrome.storage.session.get(null));
      assert(
        !/PRIVATE_COMPARE_TEST|PRIVATE_TEST|Fixture service sample|Practice buyer|QA comparison buyer|QA raw review sentinel/.test(
          JSON.stringify(stored),
        ),
      );
      r.checks.push(
        'Duplicate add kept one offer. Foreign, transactional and tokenized inputs caused no additional source fetch. Allowed fresh reads with decoy buyer/private form and review text present sent no decoy marker, and session storage held none. The purchase goal paused without activating install or purchase.',
      );
    },
  };
}
