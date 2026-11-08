import assert from 'node:assert/strict';

const scope = 'section[aria-label="Compare alternatives"]';
const ids = (comparison) => comparison.candidates.map((c) => c.offer.id);

export function stage6RepairExtras({
  prepare,
  configure,
  options,
  state,
  refresh,
  click,
  snapshot,
  type,
  field,
  base,
  scenario,
}) {
  async function rendered(panel, c) {
    await panel.waitForFunction(
      (version, message) => {
        const status = document.querySelector('[data-testid="comparison-status"]');
        return status?.dataset.revision === String(version) && status.innerText.includes(message);
      },
      { timeout: 8000 },
      c.version,
      c.message,
    );
  }
  async function remove(panel, c, id) {
    await rendered(panel, c);
    await panel
      .locator(scope + ' article[data-offer-id="' + id + '"] button::-p-text(Remove option)')
      .click();
    return state(panel, (x) => x.version > c.version && !ids(x).includes(id), 'removed ' + id);
  }
  async function sort(panel, c) {
    await rendered(panel, c);
    await (await field(panel, 'Add priority')).select('seller');
    return state(
      panel,
      (x) => x.version > c.version && x.settings.priorities.includes('seller'),
      'sorted current comparison',
    );
  }
  async function refreshCurrent(panel, c) {
    await rendered(panel, c);
    return refresh(panel, c);
  }
  async function add(panel, c, id) {
    await rendered(panel, c);
    await type(panel, 'Supported offer URL', base + id);
    await click(panel, 'Add offer');
    return state(
      panel,
      (x) =>
        x.version > c.version &&
        ids(x).includes(id) &&
        !['searching', 'checking_candidates'].includes(x.status),
      'explicit Add ' + id,
    );
  }
  return {
    async repairPartial(s, r) {
      await scenario(s, 'partial');
      await prepare(s);
      await configure(s.panel);
      let c = await options(s.panel);
      const warning = c.message;
      assert.equal(c.status, 'partial');
      const failedDetail = (status) =>
        r.requests.filter(
          (x) => x.fromExtension && x.path.endsWith('/offers/error') && x.http === status,
        ).length;
      assert.equal(failedDetail(404), 1);
      const reads = s.sourceReadCount();
      c = await sort(s.panel, c);
      assert.equal(c.status, 'partial');
      assert.equal(c.message, warning);
      c = await remove(s.panel, c, 'better');
      assert.equal(c.status, 'partial');
      assert.equal(c.message, warning);
      assert.deepEqual(ids(c), ['lower']);
      assert.equal(s.sourceReadCount(), reads);
      await snapshot(s, r, c);

      c = await refreshCurrent(s.panel, c);
      assert.equal(c.status, 'partial');
      assert.equal(failedDetail(404), 2);
      assert.deepEqual(ids(c), ['lower']);
      await scenario(s, 'partial-restored');
      c = await refreshCurrent(s.panel, c);
      assert.equal(c.status, 'ready');
      assert.equal(failedDetail(200), 1);
      assert(ids(c).includes('error') && !ids(c).includes('better'));
      await snapshot(s, r, c);
      r.checks.push(
        '404 detail and readable options remained Partial through sorting and removal with zero new reads. A failed retry stayed Partial; a later 200 for the same offer restored Ready.',
      );
    },
    async repairRemoved(s, r) {
      await scenario(s, 'exact');
      await prepare(s);
      await configure(s.panel);
      let c = await options(s.panel);
      assert.deepEqual([...ids(c)].sort(), ['better', 'lower']);
      const [first, last] = ids(c);
      c = await remove(s.panel, c, first);
      c = await refreshCurrent(s.panel, c);
      assert.deepEqual(ids(c), [last]);
      c = await sort(s.panel, c);
      assert.deepEqual(ids(c), [last]);
      await rendered(s.panel, c);
      await click(s.panel, 'Compare selected', true);
      const table = await s.panel.waitForSelector(scope + ' table');
      assert.equal(await table.$$eval('th[scope=col]', (els) => els.length), 3);
      c = await remove(s.panel, c, last);
      c = await refreshCurrent(s.panel, c);
      assert.deepEqual(ids(c), []);
      c = await add(s.panel, c, first);
      assert.deepEqual(ids(c), [first]);
      c = await refreshCurrent(s.panel, c);
      assert.deepEqual(ids(c), [first]);
      await snapshot(s, r, c);
      await click(s.panel, 'Close comparison');
      await prepare(s);
      await configure(s.panel);
      c = await options(s.panel);
      assert.deepEqual([...ids(c)].sort(), ['better', 'lower']);
      await snapshot(s, r, c);
      r.checks.push(
        'Removed leading and trailing offers stayed absent on refresh, sort and compare. Explicit Add restored just the requested offer. A deliberately new comparison rediscovered both.',
      );
    },
  };
}
