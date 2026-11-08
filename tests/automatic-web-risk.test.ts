import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import {
  automaticThreatSubject,
  ThreatRequest,
  ThreatReply,
  threatWarningLinks,
  visibleProtection,
  nextProtectionExpiry,
  ChatRouteReply,
  type ProtectionView,
} from '@safestep/contracts';
import { WebRiskService, installGuardedWebRiskTransport } from '../apps/api/src/web-risk';
import {
  initializeWebRiskBudget,
  migrateWebRiskBudget,
  reserveWebRisk,
  finishWebRisk,
  webRiskLimits,
} from '../apps/api/src/web-risk-budget';
import { makeApi } from '../apps/api/src/app';
import { GeminiService, newPairToken } from '../apps/api/src/gemini';
import { budgetedFetch, PaidLedger } from '../scripts/stage8-paid-ledger.mjs';

const env = {
  WEB_RISK_API_KEY: 'synthetic-web-risk-key',
  SAFESTEP_WEB_RISK_AUTHORIZED: 'true',
  GEMINI_API_KEY: 'synthetic-gemini-key',
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
};
function temp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'safestep-aw-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const signal = () => new AbortController().signal;
test('automatic public subjects normalize anchors without exposing queries and keep actual scheme/scope', () => {
  for (const url of [
    'http://en.wikipedia.org/wiki/Atmosphere_of_Earth',
    'https://www.videolan.org/vlc/download-windows.html',
    'https://foxedandfound.resell.store/mastering-art-french-cooking-1961',
    'https://resell.store/discover',
    'https://foxedandfound.resell.store/reviews',
    'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/reviews/',
    'https://held-out.org/docs/web-security',
    'http://public.org/about/team',
    'https://public.org/',
  ]) {
    const req = automaticThreatSubject(url + '#Examples');
    assert.deepEqual(req, { url, scope: 'page', purpose: 'arrival' });
    assert(ThreatRequest.safeParse(req).success);
  }
  const unknown = 'http://held-out.org/directory/thing';
  assert.deepEqual(automaticThreatSubject(unknown, 'target'), {
    scope: 'root',
    url: 'http://held-out.org/',
    purpose: 'target',
  });
  for (const raw of [
    unknown + '?unknown=thing',
    unknown + '#access_token=private',
    unknown + '#session-private',
    'file:///hello',
    'chrome-extension://abc/page',
    'http://127.0.0.1/',
    'http://127.0.0.1.nip.io/docs/public',
    'https://foo.local/help',
    'https://user@public.org/help',
    'https://held-out.org/docs/pAsSwOrD',
    'https://foxedandfound.resell.store/profile',
    'https://foxedandfound.resell.store/account',
    'https://public.org:8080/',
    'https://public.org/products/%2fprivate',
    'https://public.org/docs/%252fsecret',
    'https://public.org/a/../docs',
    'https://public.org/docs/abcdef1234567890',
    'https://held-out.org/docs/5fcc4d8e-80ad-4814-beb5-dcc9c7b7c42e',
    'https://xn--bcher-kva.org/help',
  ]) {
    assert.equal(automaticThreatSubject(raw), null, raw);
  }
  const pkg = 'https://get.videolan.org/vlc/3.0.23/win64/vlc-3.0.23-win64.exe';
  assert.equal(automaticThreatSubject(pkg, 'target')?.url, pkg);
  assert.equal(automaticThreatSubject(pkg, 'arrival')?.scope, 'root');
  assert.equal(
    ThreatRequest.safeParse({ scope: 'page', url: pkg, purpose: 'arrival' }).success,
    false,
  );
  assert.equal(automaticThreatSubject(pkg + '?signed=secret', 'target'), null);
  for (const citation of [
    'https://api.resell.store/v1/market/stores/foxedandfound',
    'https://api.resell.store/v1/stores/foxedandfound/reviews',
  ]) {
    assert.equal(automaticThreatSubject(citation, 'target')?.url, citation);
    assert.equal(automaticThreatSubject(citation, 'arrival')?.scope, 'root');
  }
  const filters =
    'https://resell.store/discover?category=books&sort=price-asc&price=under-25&page=2';
  assert.deepEqual(automaticThreatSubject(filters, 'target'), {
    scope: 'root',
    url: 'https://resell.store/',
    purpose: 'target',
  });
  const search =
    'https://en.wikipedia.org/w/index.php?title=Special%3ASearch&search=Atmosphere+of+Earth&wprov=acrw1_-1';
  assert.deepEqual(automaticThreatSubject(search), {
    scope: 'root',
    url: 'https://en.wikipedia.org/',
    purpose: 'arrival',
  });
  for (const unsafe of [
    filters + '&page=3',
    filters + '&q=books',
    filters + '&token=abc',
    filters.replace('under-25', 'anything'),
    filters.replace('page=2', 'page=0'),
    filters.replace('resell.store', 'some-store.resell.store'),
    search + '&other=anything',
    search.replace('Atmosphere+of+Earth', 'my+personal+address'),
    search.replace('Special%3ASearch', 'Special%3AUserLogin'),
  ])
    assert.equal(automaticThreatSubject(unsafe), null, unsafe);
});
test('one lookup serves all current contexts, retains a persistent positive across restart and never retains a miss', async (t) => {
  const dir = join(temp(t), 'meter');
  initializeWebRiskBudget(dir);
  let now = Date.now(),
    calls = 0,
    release!: () => void;
  const paused = new Promise<void>((res) => (release = res));
  const upstream = async () => {
    calls++;
    await paused;
    return calls === 1
      ? Response.json({
          threat: {
            threatTypes: ['UNWANTED_SOFTWARE'],
            expireTime: new Date(now + 1200).toISOString(),
          },
        })
      : Response.json({});
  };
  const service = () => new WebRiskService(env, dir, upstream, () => now);
  const a = service(),
    url = 'https://held-out.org/';
  const first = a.check({ scope: 'page', purpose: 'arrival', url }, signal()),
    second = a.check({ scope: 'root', purpose: 'target', url }, signal());
  const others = Array.from({ length: 7 }, () =>
    a.check({ scope: 'page', purpose: 'manual', url }, signal()),
  );
  release();
  const [page, root] = await Promise.all([first, second, ...others]);
  assert.equal(calls, 1);
  assert.equal(page.scope, 'page');
  assert.equal(root.scope, 'root');
  assert.equal(root.purpose, 'target');
  assert.equal(root.status, 'match');
  assert(threatWarningLinks(root, now).some((l) => l.label.includes('unwanted software')));
  const fresh = await service().check({ scope: 'page', purpose: 'manual', url }, signal());
  assert.equal(calls, 1);
  assert.equal(fresh.purpose, 'manual');
  assert.equal(service().diagnostics().verifiedUpstreamAt, null);
  assert(!readFileSync(join(dir, 'limits.sqlite')).includes(Buffer.from(url)));
  const v = {
    identity: 'observed',
    caution: false,
    status: 'local',
    destination: { kind: 'download', message: 'Possible risk', result: root },
  } as ProtectionView;
  assert.equal(nextProtectionExpiry(v, now), now + 1200);
  assert.equal(visibleProtection(v, now + 1200).destination, undefined);
  now += 1200;
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await service().check({ scope: 'page', purpose: 'arrival', url }, signal())).status,
      'no_match',
    );
  assert.equal(calls, 3);
});
test('explicit profile migration retains known counts and unknown-month reserve, 429 backoff, concurrency, monthly cap and clock guards', (t) => {
  const dir = join(temp(t), 'web-risk');
  mkdirSync(dir);
  const now = Date.UTC(2026, 10, 15, 12),
    day = Math.floor(now / 86400000),
    file = join(dir, 'limits.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(
    'CREATE TABLE limits(id INTEGER PRIMARY KEY,cap INTEGER,day INTEGER,used INTEGER,blockedUntil INTEGER);',
  );
  legacy.prepare('INSERT INTO limits VALUES(1,12,?,7,?)').run(day, now + 90000);
  legacy.close();
  assert.throws(() => webRiskLimits(dir));
  assert.equal(migrateWebRiskBudget(dir, false, now).dayCap, 12);
  assert.equal(migrateWebRiskBudget(dir, true, now).monthCap, 5000);
  assert.equal(reserveWebRisk(dir, now, 3000), null);
  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare('SELECT used FROM legacy_limits WHERE id=1').get()?.used, 7);
    assert.equal(
      db
        .prepare("SELECT sum(units) AS n FROM admissions WHERE kind='legacy-month-upper-bound'")
        .get()?.n,
      168,
    );
    const t0 = now + 90000;
    const first = reserveWebRisk(dir, t0, 3000),
      second = reserveWebRisk(dir, t0, 3000);
    assert(first && second);
    assert.equal(reserveWebRisk(dir, t0, 3000), null);
    finishWebRisk(dir, first);
    finishWebRisk(dir, second);
    assert.equal(reserveWebRisk(dir, t0 - 1, 3000), null);
    // Simulate retained accounted reservations in the current month, without issuing upstream calls.
    const month = new Date(now).getUTCFullYear() * 12 + new Date(now).getUTCMonth();
    db.prepare(
      "INSERT INTO admissions(at,day,month,units,kind,lease) VALUES(?,?,?,?,'fixture',0)",
    ).run(now - 86400000, day - 1, month, 5000 - 168 - 7 - 2);
    assert.equal(reserveWebRisk(dir, t0 + 60000, 3000), null);
    const december = Date.UTC(2026, 11, 1);
    const next = reserveWebRisk(dir, december, 3000);
    assert(next);
    assert.equal(reserveWebRisk(dir, t0 + 120000, 3000), null);
  } finally {
    db.close();
  }
});
test('automatic source profile admits at most twenty upstream attempts in a rolling minute and 250 in a UTC day', (t) => {
  const dir = join(temp(t), 'meter');
  initializeWebRiskBudget(dir, 12);
  const now = Date.UTC(2026, 10, 8, 10),
    profile = migrateWebRiskBudget(dir, true, now);
  assert.equal(profile.dayCap, 250);
  let admitted = 0;
  for (let batch = 0; batch < 13; batch++) {
    const at = now + batch * 60000;
    for (let i = 0; i < 20; i++) {
      const id = reserveWebRisk(dir, at, 4000);
      if (admitted < 250) {
        assert(id);
        finishWebRisk(dir, id);
        admitted++;
      } else assert.equal(id, null);
    }
    assert.equal(reserveWebRisk(dir, at + 59999, 4000), null);
  }
  assert.equal(admitted, 250);
  assert.equal(reserveWebRisk(dir, now + 13 * 60000, 4000), null);
});
test('one paired local service can use guarded Gemini and Web Risk with distinct credentials and ledgers, rejecting unmetered source fetch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'safestep-aw-pair-')),
    threatDir = join(dir, 'web-risk'),
    paid = new PaidLedger(join(dir, 'gemini'), true);
  let api: ReturnType<typeof makeApi> | undefined;
  t.after(async () => {
    if (api?.listening) {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api!.close(() => resolve()));
    }
    paid.close();
    rmSync(dir, { recursive: true, force: true });
  });
  initializeWebRiskBudget(threatDir, 3);
  const native = globalThis.fetch,
    upstream: string[] = [];
  const simulated = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.origin === 'https://webrisk.googleapis.com') {
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), env.WEB_RISK_API_KEY);
      assert.deepEqual(u.searchParams.getAll('threatTypes'), [
        'MALWARE',
        'SOCIAL_ENGINEERING',
        'UNWANTED_SOFTWARE',
      ]);
      upstream.push('web-risk fixture');
      return Response.json({});
    }
    assert(u.href.includes('/models/gemini-3.5-flash-lite:generateContent'));
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), env.GEMINI_API_KEY);
    upstream.push('gemini fixture');
    return Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                text: JSON.stringify({
                  operation: 'site_trust',
                  message: 'Check public evidence.',
                  choices: [],
                }),
              },
            ],
          },
        },
      ],
      usageMetadata: { totalTokenCount: 40 },
    });
  };
  installGuardedWebRiskTransport(simulated, env, threatDir);
  t.mock.method(globalThis, 'fetch', budgetedFetch(paid, simulated, env.GEMINI_API_KEY));
  await assert.rejects(
    fetch('https://webrisk.googleapis.com/v1/uris:search?uri=https://held-out.org/', {
      headers: { 'x-goog-api-key': env.WEB_RISK_API_KEY },
    }),
  );
  await assert.rejects(fetch('https://webrisk.googleapis.com/v1/evaluate', { method: 'POST' }));
  await assert.rejects(
    fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': env.WEB_RISK_API_KEY, 'content-type': 'application/json' },
        body: '{}',
      },
    ),
  );
  assert.deepEqual(upstream, []);
  const token = newPairToken(),
    service = new WebRiskService(env, threatDir);
  api = makeApi(undefined, new GeminiService(env, token), undefined, service);
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  assert(address && typeof address !== 'string');
  const post = (path: string, body: unknown) =>
    native('http://127.0.0.1:' + address.port + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://' + 'b'.repeat(32),
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post('/v1/explain/connect', {})).status, 200);
  const req = automaticThreatSubject('https://held-out.org/help/reader', 'target')!;
  const risk = ThreatReply.parse(await (await post('/v1/threat/check', req)).json());
  assert.equal(risk.status, 'no_match');
  assert.equal(risk.purpose, 'target');
  assert.deepEqual(upstream, ['web-risk fixture']);
  assert.equal(paid.status().sessions[0].attempts, 0);
  const route = {
    version: 1,
    operationId: crypto.randomUUID(),
    bindingToken: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    contextKey: crypto.randomUUID(),
    text: 'Check the website.',
    history: [],
    subjects: [],
    available: ['site_trust'],
    site: { origin: 'https://held-out.org', path: '/help/reader' },
    mode: null,
  };
  const ai = ChatRouteReply.parse(await (await post('/v1/chat/route', route)).json());
  assert.equal(ai.status, 'available');
  assert.deepEqual(upstream, ['web-risk fixture', 'gemini fixture']);
  assert.equal(paid.status().sessions[0].attempts, 1);
  const db = new DatabaseSync(join(threatDir, 'limits.sqlite'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM admissions WHERE kind='lookup'").get()?.n, 1);
  db.close();
});
