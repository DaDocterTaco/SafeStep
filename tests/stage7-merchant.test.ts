import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MerchantReply, MerchantRequest } from '@safestep/contracts';
import { MerchantService } from '../apps/api/src/merchant';
import { makeApi } from '../apps/api/src/app';
import { GeminiService, newPairToken } from '../apps/api/src/gemini';

const now = Date.parse('2026-11-08T01:00:00Z');
const domain = 'wayfair.com',
  signal = () => new AbortController().signal;
const row = (
  complaintid: string,
  date: string,
  practicename = 'Non-Fulfillment',
  status = 'Open',
) => ({
  businessname: 'Wayfair.com',
  businessid: '262022',
  openeddate: date + 'T00:00:00.000',
  complaintid,
  practicename,
  status,
});
function fixture(rows: unknown[]) {
  return new MerchantService(
    async (raw, init) => {
      const u = new URL(String(raw));
      assert.equal(u.origin, 'https://data.wa.gov');
      assert.equal(u.pathname, '/resource/fvrz-yz45.json');
      assert.equal(u.searchParams.get('$limit'), '12');
      assert(u.searchParams.get('$where')?.includes("upper(businessname)='WAYFAIR.COM'"));
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.cache, 'no-store');
      return Response.json(rows);
    },
    () => now,
  );
}
test('Washington evidence groups a complaint once, preserves exact corporate scope and reports uncertain cases conservatively', async () => {
  const first = row('739292', '2026-10-14', 'Failure To Adjust/Refund', 'Closed'),
    second = row('738619', '2026-10-08');
  const checked = async (rows: unknown[]) =>
    MerchantReply.parse(await fixture(rows).check({ domain }, signal()));
  const good = await checked([
    first,
    { ...first, practicename: 'Failure To Deliver/Perform' },
    second,
  ]);
  assert.equal(good.status, 'reports');
  assert.equal(good.severity, 'caution');
  assert.equal(good.distinctComplaints, 2);
  assert.equal(good.records[0]?.practices.length, 2);
  assert.equal(good.records[0]?.caseStatus, 'Closed');
  assert.equal(good.businessId, '262022');
  assert(good.records.every((x) => new URL(x.url).origin === 'https://data.wa.gov'));
  for (const [rows, status] of [
    [[], 'no_match'],
    [[first, { ...first, practicename: 'Non-Fulfillment' }], 'limited'],
    [[first, { ...first, status: 'Open' }, second], 'limited'],
    [[first, { ...second, businessid: '9' }], 'limited'],
    [[first, { ...second, businessname: 'Similar Wayfair' }], 'unavailable'],
    [[row('11', '2026-02-01'), row('12', '2026-02-02')], 'limited'],
    [[first, { ...second, openeddate: '2026-11-22T00:00:00.000' }], 'unavailable'],
  ] as const) {
    const result = await checked([...rows]);
    assert.equal(result.status, status);
    assert.equal(result.severity, 'information');
  }
  const injected = structuredClone(good);
  injected.records[0]!.url = 'https://somewhere.test/checkout';
  assert(!MerchantReply.safeParse(injected).success);
  assert(
    !MerchantReply.safeParse({ ...good, expiresAt: new Date(now + 300001).toISOString() }).success,
  );
  const conflicting = await checked([first, second, row('999', '2026-10-02')]);
  conflicting.records[2]!.caseStatus = 'Conflicting';
  assert(!MerchantReply.safeParse(conflicting).success);
});
test('Merchant lookup respects public-domain privacy, caching, session budget, concurrent owners and cancellation', async () => {
  for (const value of [
    '127.0.0.1',
    'localhost',
    'home.local',
    'host.test',
    'wayfair.com/?token=secret',
    'private@wayfair.com',
    'wayfair.com:443',
  ])
    assert(!MerchantRequest.safeParse({ domain: value }).success);
  assert(!MerchantRequest.safeParse({ domain, goal: 'private' }).success);
  let fetches = 0,
    time = now;
  const limited = new MerchantService(
    async () => {
      fetches++;
      return Response.json([]);
    },
    () => time,
  );
  assert.equal(
    (await limited.check({ domain: 'private.wayfair.com' }, signal())).status,
    'limited',
  );
  assert.equal(fetches, 0);
  await limited.check({ domain }, signal());
  const alias = await limited.check({ domain: 'www.wayfair.com' }, signal());
  assert.equal(alias.domain, 'www.wayfair.com');
  assert.equal(fetches, 1);
  await limited.check({ domain: 'example.org' }, signal());
  assert.equal((await limited.check({ domain: 'example.net' }, signal())).status, 'rate_limited');
  for (let i = 0; i < 18; i++) {
    time += 61_000;
    await limited.check({ domain: 'sample' + i + '.com' }, signal());
  }
  time += 61_000;
  assert.equal((await limited.check({ domain }, signal())).status, 'rate_limited');
  assert.equal(fetches, 20);
  let release: ((value: Response) => void) | undefined;
  let attached: AbortSignal | null | undefined;
  const pending = new MerchantService(
    async (_raw, init) => {
      attached = init?.signal;
      return new Promise((ok) => {
        release = ok;
      });
    },
    () => now,
  );
  const one = new AbortController(),
    two = new AbortController();
  const a = pending.check({ domain }, one.signal),
    b = pending.check({ domain }, two.signal);
  assert.equal((await pending.check({ domain: 'example.org' }, signal())).status, 'rate_limited');
  one.abort();
  await assert.rejects(a);
  assert(!attached?.aborted);
  release!(Response.json([]));
  assert.equal((await b).status, 'no_match');
  assert.equal(
    (
      await new MerchantService(
        async () => Response.json({}, { status: 429 }),
        () => now,
      ).check({ domain }, signal())
    ).status,
    'rate_limited',
  );
});
test('Merchant HTTP operations require an active paired extension and strict body before any outside read', async (t) => {
  const token = newPairToken(),
    origin = 'chrome-extension://' + 'a'.repeat(32);
  const api = makeApi(undefined, new GeminiService({}, token), fixture([])).listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const host = api.address();
  assert(host && typeof host === 'object');
  const post = (p: string, data: unknown, o = origin) =>
    fetch('http://127.0.0.1:' + host.port + p, {
      method: 'POST',
      headers: { Origin: o, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  assert.equal((await post('/v1/merchant/check', { domain })).status, 403);
  assert.equal((await post('/v1/explain/connect', {})).status, 200);
  assert.equal(
    (await post('/v1/merchant/check', { domain }, 'https://untrusted.test')).status,
    403,
  );
  assert.equal((await post('/v1/merchant/check', { domain, cookie: 'private' })).status, 400);
  const response = await post('/v1/merchant/check', { domain });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(MerchantReply.parse(await response.json()).status, 'no_match');
});
