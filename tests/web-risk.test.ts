import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreatReply, ThreatRequest } from '@safestep/contracts';
import { makeApi } from '../apps/api/src/app';
import { GeminiService, newPairToken } from '../apps/api/src/gemini';
import { ProvidersService } from '../apps/api/src/providers';
import { initializeWebRiskBudget, WebRiskService } from '../apps/api/src/web-risk';

const authorized = { WEB_RISK_API_KEY: 'fixture-only-key', SAFESTEP_WEB_RISK_AUTHORIZED: 'true' };
const root: ThreatRequest = { scope: 'root', url: 'https://www.iana.org/' };
const page: ThreatRequest = { scope: 'page', url: 'https://www.iana.org/help/example-domains' };
const validCategories = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'];
const signal = () => new AbortController().signal;
function budget(t: TestContext, cap = 12) {
  const prefix = mkdtempSync(join(tmpdir(), 'safestep-web-risk-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const directory = join(prefix, 'web-risk');
  initializeWebRiskBudget(directory, cap);
  return directory;
}
function positive(expires: number) {
  return { threat: { threatTypes: validCategories, expireTime: new Date(expires).toISOString() } };
}
test('fixed Google Lookup shape, validated scope, provider expiry and positive-only per-URL caching', async (t) => {
  let now = Date.now(),
    calls = 0;
  const service = new WebRiskService(
    authorized,
    budget(t),
    async (raw, options) => {
      const url = new URL(String(raw));
      assert.equal(url.origin + url.pathname, 'https://webrisk.googleapis.com/v1/uris:search');
      assert.deepEqual([...url.searchParams.keys()], ['uri', 'threatTypes', 'threatTypes', 'threatTypes']);
      assert.deepEqual(url.searchParams.getAll('threatTypes'), validCategories);
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.body, undefined);
      assert.equal(new Headers(options?.headers).get('x-goog-api-key'), 'fixture-only-key');
      calls++;
      return Response.json(url.searchParams.get('uri') === root.url ? positive(now + 1000) : {});
    },
    () => now,
  );
  const first = ThreatReply.parse(await service.check(root, signal()));
  assert.equal(first.status, 'match');
  assert.deepEqual(first.categories, validCategories);
  assert.equal(first.expiresAt, new Date(now + 1000).toISOString());
  now += 999;
  assert.deepEqual(await service.check(root, signal()), first);
  assert.equal(calls, 1);
  for (let i = 0; i < 2; i++) {
    const miss = await service.check(page, signal());
    assert.equal(miss.status, 'no_match');
    assert.equal(miss.url, page.url);
    assert.equal(miss.expiresAt, null);
    assert.deepEqual(miss.categories, []);
  }
  now++;
  assert.equal((await service.check(root, signal())).checkedAt, new Date(now).toISOString());
  assert.equal(calls, 4);
});
test('credential, dedicated owner opt-in and usable budget are independent prerequisites', async (t) => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return Response.json({});
  };
  const directory = budget(t);
  for (const [env, reason] of [
    [
      { GEMINI_API_KEY: 'labelled-fixture', SAFESTEP_WEB_RISK_AUTHORIZED: 'true' },
      'not_configured',
    ],
    [{ WEB_RISK_API_KEY: 'labelled-fixture' }, 'disabled'],
    [{ ...authorized, SAFESTEP_WEB_RISK_AUTHORIZED: 'false' }, 'disabled'],
  ] as const) {
    const service = new WebRiskService(env, directory, transport);
    assert.equal((await service.check(root, signal())).reason, reason);
    assert.notEqual(service.readiness().status, 'ready');
  }
  const service = new WebRiskService(authorized, directory, transport);
  assert.equal(service.readiness().status, 'ready');
  rmSync(join(directory, 'limits.sqlite'));
  assert.throws(() => initializeWebRiskBudget(directory));
  assert.equal((await service.check(root, signal())).reason, 'source');
  writeFileSync(join(directory, 'limits.sqlite'), 'unusable fixture');
  assert.equal((await service.check(root, signal())).reason, 'source');
  assert.equal(service.readiness().status, 'connector_unavailable');
  assert.equal(calls, 0);
});
test('invalid, expired, oversized, mismatched and unrelated upstream evidence stays unavailable', async (t) => {
  let now = Date.now();
  const cases: (() => Response)[] = [
    () => Response.json({ errors: [] }),
    () => Response.json({ threat: {} }),
    () =>
      Response.json({
        threat: {
          threatTypes: ['SOCIAL_ENGINEERING_EXTENDED_COVERAGE'],
          expireTime: new Date(now + 60000).toISOString(),
        },
      }),
    () =>
      Response.json({
        threat: {
          threatTypes: ['MALWARE', 'MALWARE'],
          expireTime: new Date(now + 60000).toISOString(),
        },
      }),
    () => Response.json(positive(now)),
    () => Response.json(positive(now - 1)),
    () => Response.json({}, { status: 201 }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response(' '.repeat(8193) + '{}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () =>
      Object.defineProperty(Response.json(positive(now + 60000)), 'url', {
        value: 'https://example.org/',
      }),
    () => Response.json({ message: 'private provider details' }, { status: 403 }),
  ];
  let i = 0;
  const service = new WebRiskService(
    authorized,
    budget(t, 20),
    async () => cases[i++]!(),
    () => now,
  );
  for (const run of cases) {
    const r = ThreatReply.parse(await service.check(root, signal()));
    assert.equal(r.status, 'unavailable', run.toString());
    assert.equal(r.reason, 'source');
    assert.equal(r.expiresAt, null);
    assert(!JSON.stringify(r).includes('private provider details'));
  }
  assert.equal(i, cases.length);
});
test('provider HTTP 429 produces a redacted durable backoff with no automatic retry', async (t) => {
  const directory = budget(t);
  let now = Date.now(),
    calls = 0;
  const getService = () =>
    new WebRiskService(
      authorized,
      directory,
      async () => {
        calls++;
        return calls === 1
          ? Response.json(
              { message: 'private upstream detail' },
              {
                status: 429,
                headers: { 'retry-after': '125' },
              },
            )
          : Response.json({});
      },
      () => now,
    );
  const first = await getService().check(root, signal());
  assert.equal(first.status, 'rate_limited');
  assert(!JSON.stringify(first).includes('private upstream detail'));
  now += 124999;
  assert.equal((await getService().check(page, signal())).reason, 'quota');
  assert.equal(calls, 1);
  now++;
  assert.equal((await getService().check(page, signal())).status, 'no_match');
  assert.equal(calls, 2);
});
test('shared UTC daily limit survives restart, concurrent processes, failed calls and clock rollback', async (t) => {
  const directory = budget(t, 2);
  const time = Date.UTC(2026, 10, 5, 12);
  const child = `
    import { WebRiskService } from './apps/api/src/web-risk.ts';
    const svc = new WebRiskService({ WEB_RISK_API_KEY:'test', SAFESTEP_WEB_RISK_AUTHORIZED:'true' },
      process.argv[1], async () => { throw Error('labelled source outage'); }, () => Number(process.argv[2]));
    const receipt = await svc.check({ scope:'root', url:'https://www.iana.org/' }, new AbortController().signal);
    process.stdout.write(receipt.status);
  `;
  const fork = (clock: number) =>
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      child,
      directory,
      String(clock),
    ]);
  const outcomes = (await Promise.all([fork(time), fork(time), fork(time), fork(time)]))
    .map((r) => r.stdout)
    .sort();
  assert.deepEqual(outcomes, ['rate_limited', 'rate_limited', 'unavailable', 'unavailable']);
  assert.equal((await fork(time - 86400000)).stdout, 'rate_limited');
  assert.equal((await fork(time + 86400000)).stdout, 'unavailable');
});
test('duplicate requests share one attempt; an abandoned reader cannot cancel another reader', async (t) => {
  let release!: () => void,
    calls = 0,
    aborted = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WebRiskService(authorized, budget(t, 1), async (_url, options) => {
    calls++;
    options?.signal?.addEventListener('abort', () => {
      aborted = true;
    });
    await wait;
    return Response.json({});
  });
  const first = new AbortController();
  const abandoned = service.check(root, first.signal),
    survivor = service.check(root, signal());
  first.abort();
  await assert.rejects(abandoned);
  assert(!aborted);
  release();
  assert.equal((await survivor).status, 'no_match');
  assert.equal(calls, 1);
  assert.equal((await service.check(root, signal())).reason, 'quota');
});
test('timeout and cancelled requests produce no threat finding and cannot seed the positive cache', async (t) => {
  let calls = 0;
  const service = new WebRiskService(
    authorized,
    budget(t),
    async (_url, options) => {
      calls++;
      if (calls === 1) return new Promise<Response>(() => {});
      if (calls === 3) return Response.json({});
      return new Promise<Response>((_, reject) =>
        options?.signal?.addEventListener('abort', () => reject(Error('aborted'))),
      );
    },
    Date.now,
    20,
  );
  // Keep the test process active while native AbortSignal.timeout uses an unref'ed timer.
  const guard = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(guard));
  const slow = await service.check(root, signal());
  assert.equal(slow.reason, 'timeout');
  const controller = new AbortController(),
    abandoned = service.check(root, controller.signal);
  controller.abort();
  await assert.rejects(abandoned);
  assert.equal((await service.check(root, signal())).status, 'no_match');
  assert.equal(calls, 3);
});
test('paired threat HTTP route rejects invalid subjects, origins, expired sessions and the generic lookup bypass', async (t) => {
  const directory = budget(t);
  const token = newPairToken(),
    origin = 'chrome-extension://' + 'a'.repeat(32);
  let calls = 0,
    bypassCalls = 0,
    injectMismatch = false;
  const legacy = new ProvidersService(authorized, [
    {
      id: 'url_threat',
      async lookup() {
        bypassCalls++;
        throw Error('legacy bypass');
      },
    },
  ]);
  const source = new WebRiskService(authorized, directory, async () => {
    calls++;
    return Response.json({});
  });
  const api = makeApi(legacy, new GeminiService({}, token), undefined, {
    readiness: () => source.readiness(),
    async check(input, client) {
      const result = await source.check(input, client);
      return injectMismatch
        ? {
            ...result,
            ...root,
            status: 'match',
            categories: ['MALWARE'],
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          }
        : result;
    },
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const address = api.address();
  assert(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const post = (path: string, body: unknown, headers?: Record<string, string>) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const headers = { Origin: origin, Authorization: 'Bearer ' + token };
  const path = '/v1/threat/check';
  assert.equal((await post(path, root)).status, 403);
  assert.equal((await post(path, root, headers)).status, 403);
  assert.equal((await post('/v1/explain/connect', {}, headers)).status, 200);
  assert.equal((await post(path, root, { ...headers, Origin: 'https://example.com' })).status, 403);
  assert.equal(
    (await post(path, root, { ...headers, Origin: 'chrome-extension://' + 'b'.repeat(32) })).status,
    403,
  );
  for (const unsafe of [
    'https://www.iana.org/?token=private',
    'http://localhost/',
    'https://private@www.iana.org/',
  ]) {
    const r = await post(path, { scope: 'page', url: unsafe }, headers);
    assert.equal(r.status, 400);
    assert(!(await r.text()).includes(unsafe));
  }
  assert.equal((await post(path, { ...root, optIn: true }, headers)).status, 400);
  const generic = {
    provider: 'url_threat',
    subject: { kind: 'website_risk', domain: 'example.com' },
  };
  assert.equal((await post('/v1/lookup', generic)).status, 403);
  assert.equal((await post('/v1/lookup', generic, headers)).status, 403);
  assert.equal(bypassCalls, 0);
  assert.equal(calls, 0);
  const good = await post(path, page, headers);
  assert.equal(good.headers.get('access-control-allow-origin'), origin);
  assert.equal(ThreatReply.parse(await good.json()).status, 'no_match');
  assert.equal(calls, 1);
  injectMismatch = true;
  const dropped = ThreatReply.parse(await (await post(path, page, headers)).json());
  assert.equal(dropped.url, page.url);
  assert.equal(dropped.scope, 'page');
  assert.equal(dropped.reason, 'source');
  assert.deepEqual(dropped.categories, []);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 60000 });
  assert.equal((await post(path, page, headers)).status, 403);
  assert.equal(calls, 2);
});
