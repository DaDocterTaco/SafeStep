import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import {
  ExplainHealth,
  ExplainReply,
  ExplanationInput,
  Lookup,
  explanationChoices,
  validatedExplanation,
  type ExplanationInput as Input,
  type FeatureResult,
} from '@safestep/contracts';
import { GeminiService, newPairToken } from '../apps/api/src/gemini';
import { makeApi } from '../apps/api/src/app';
import { ProvidersService, type Provider } from '../apps/api/src/providers';
import { packageMatches } from '../apps/extension/sites/downloads';
const input = (kind: 'download' | 'website' = 'website'): Input => ({
  operationId: crypto.randomUUID(),
  bindingToken: crypto.randomUUID(),
  kind,
  profile: kind === 'download' ? 'vlc_windows_x64' : null,
  platform: kind === 'download' ? 'Windows' : null,
  architecture: kind === 'download' ? 'x64' : null,
  selected: null,
  alternatives: [],
  evidence: [
    { id: 'e1', code: 'host' },
    { id: 'e2', code: kind === 'website' ? 'urgent_dialog' : 'missing' },
  ],
  reviewCoverage: 'unavailable',
  threatCoverage: 'unavailable',
  limited: true,
});
function fixture(r: Input) {
  const c = explanationChoices(r);
  return {
    summary: c.summary,
    nextStep: c.nextStep,
    coverageLimits: [c.limits[0]!],
    reasons: [c.reasons.find((i) => i.evidenceId === 'e2')!],
  };
}
const env = { GEMINI_API_KEY: 'DUMMY_SERVER_ONLY', GEMINI_MODEL: 'gemini-test-fixture' };
test('D01–D04 publisher rules verify exact owner, release, architecture, filename and scheme', () => {
  const seven = 'https://github.com/ip7z/7zip/releases/download/26.05/7z2605-x64.exe';
  const vlc = 'https://get.videolan.org/vlc/4.1.9/win64/vlc-4.1.9-win64.exe';
  for (const [id, url, v] of [
    ['seven_zip_windows_x64_exe', seven, '26.05'],
    ['vlc_windows_x64', vlc, '4.1.9'],
  ] as const) {
    assert(packageMatches(id, new URL(url), v));
    for (const u of [
      url.replace('https:', 'http:'),
      url + '?token=dummy',
      url + '#x',
      url.replace('https://', 'https://brand@'),
      url.replace('.exe', '.msi'),
      url.replace('64', '86'),
      url
        .replace('github.com', 'github.com.fake.test')
        .replace('get.videolan.org', 'get.videolan.org.fake.test'),
    ])
      assert(!packageMatches(id, new URL(u), v));
  }
  for (const u of [
    seven.replace('ip7z', 'someone'),
    seven.replace('/7zip/', '/7zipp/'),
    seven.replace('7z2605', '7z2401'),
    seven.replace('x64', 'arm64'),
  ])
    assert(!packageMatches('seven_zip_windows_x64_exe', new URL(u), '26.05'));
  assert(!packageMatches('vlc_windows_x64', new URL(vlc.replace('/vlc/', '/other/')), '4.1.9'));
});
test('A03/A04 strict model output cannot introduce a claim, domain, action, fabricated rating or evidence ID', () => {
  const r = input(),
    a = fixture(r);
  assert(validatedExplanation(a, r));
  for (const patch of [
    { reasons: [{ evidenceId: 'e9', text: a.reasons[0]!.text }] },
    { summary: 'Guaranteed safe. 97 percent.' },
    { nextStep: 'Download from other.test now.' },
    { reasons: [{ evidenceId: 'e1', text: 'Trustpilot rating 4.9/5' }] },
    { coverageLimits: ['File scanned and passed'] },
    { tool: 'click' },
    { reasons: [a.reasons[0], a.reasons[0]] },
  ])
    assert.equal(validatedExplanation({ ...a, ...patch }, r), null);
  for (const bad of [
    { ...r, rawHtml: 'dummy' },
    { ...r, evidence: [{ id: 'e1', code: 'click this link' }] },
    { ...r, platform: 'Windows' },
    { ...r, evidence: Array(13).fill(r.evidence[0]) },
  ])
    assert(!ExplanationInput.safeParse(bad).success);
});
test('A02 implementation path: official SDK sends the fixed structured request to a mock transport, never a live provider', async (t) => {
  let hits = 0;
  const r = input('download'),
    a = fixture(r);
  t.mock.method(globalThis, 'fetch', async (raw: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(raw instanceof Request ? raw.url : String(raw));
    assert.equal(u.origin, 'https://generativelanguage.googleapis.com');
    assert(u.pathname.endsWith('/models/gemini-test-fixture:generateContent'));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.maxOutputTokens, 600);
    assert(body.generationConfig.responseJsonSchema);
    const reasons=body.generationConfig.responseJsonSchema.properties.reasons;
    assert.equal(reasons.maxItems,Math.min(3,r.evidence.length));
    assert.deepEqual(reasons.items.anyOf.map((option:{properties:{evidenceId:{enum:string[]}}})=>option.properties.evidenceId.enum[0]),r.evidence.map(e=>e.id));
    assert(!JSON.stringify(body).includes(r.bindingToken));
    assert(!JSON.stringify(body).includes('DUMMY_SERVER_ONLY'));
    assert.equal(body.tools, undefined);
    hits++;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: JSON.stringify(a) }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { totalTokenCount: 37 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const api = new GeminiService(env, newPairToken());
  assert.equal(api.health().state, 'configured_unverified');
  const reply = await api.explain(r, new AbortController().signal);
  assert.equal(hits, 1);
  assert.equal(reply.status, 'available');
  assert.equal(reply.tokens, 37);
  assert.equal(reply.bindingToken, r.bindingToken);
});
test('A05 rejection, cancellation, deadline, empty output, malformed JSON and upstream failures remain unavailable', async () => {
  const r = input();
  for (const code of [401, 403, 429]) {
    const svc = new GeminiService(env, newPairToken(), async () => {
      throw { status: code };
    });
    const a = await svc.explain(r, new AbortController().signal);
    assert.equal(a.status, code === 429 ? 'rate_limited' : 'unavailable');
    assert.equal(a.explanation, null);
  }
  for (const text of ['', 'bad', '{"rating":5}']) {
    const svc = new GeminiService(env, newPairToken(), async () => ({ text, tokens: null }));
    assert.equal((await svc.explain(r, new AbortController().signal)).status, 'invalid_response');
  }
  const svc = new GeminiService(
    env,
    newPairToken(),
    async () =>
      new Promise((res) =>
        setTimeout(() => res({ text: JSON.stringify(fixture(r)), tokens: null }), 120),
      ),
    20,
  );
  assert.equal((await svc.explain(r, new AbortController().signal)).status, 'timeout');
  const stop = new AbortController();
  const pending = svc.explain(r, stop.signal);
  stop.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(svc.health().state, 'configured_unverified');
});
test('A06/E02 local token pairs once with an extension, rejects an unrelated client, Host, malformed/oversized payload', async (t) => {
  const pair = newPairToken(),
    server = makeApi(new ProvidersService({}), new GeminiService({}, pair));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  const base = 'http://127.0.0.1:' + addr.port + '/v1/explain';
  const o = 'chrome-extension://' + 'a'.repeat(32),
    headers = { Origin: o, Authorization: 'Bearer ' + pair, 'Content-Type': 'application/json' };
  const post = (path: string, body: string, h = headers) =>
    fetch(base + path, { method: 'POST', headers: h, body });
  assert.equal((await post('', JSON.stringify(input()))).status, 403);
  assert.equal(
    (await post('/connect', '', { ...headers, Origin: 'https://example.org' })).status,
    403,
  );
  assert.equal(
    (await post('/connect', '', { ...headers, Authorization: 'Bearer bad' })).status,
    403,
  );
  const connected = ExplainHealth.parse(await (await post('/connect', '')).json());
  assert(connected.connected);
  assert.equal(connected.state, 'not_configured');
  assert(!JSON.stringify(connected).includes(pair));
  assert.equal(
    (await post('/connect', '', { ...headers, Origin: 'chrome-extension://' + 'b'.repeat(32) }))
      .status,
    403,
  );
  assert.equal((await post('', 'x'.repeat(8200))).status, 413);
  assert.equal(
    (await post('', JSON.stringify({ ...input(), url: 'http://private/' }))).status,
    400,
  );
  const forged = await new Promise<number | undefined>((ok, no) => {
    const req = httpRequest(base + '/health', { headers: { Host: 'attacker.test' } }, (res) => {
      res.resume();
      ok(res.statusCode);
    });
    req.on('error', no);
    req.end();
  });
  assert.equal(forged, 403);
  const response = ExplainReply.parse(await (await post('', JSON.stringify(input()))).json());
  assert.equal(response.status, 'not_configured');
  assert(
    !Lookup.safeParse({
      provider: 'url_threat',
      subject: { kind: 'website_risk', domain: 'localhost' },
    }).success,
  );
});
test('A06 one pending call per operation, six calls per minute, thirty per session, pairing token expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const token = newPairToken(),
    r = input(),
    origin = 'chrome-extension://' + 'a'.repeat(32);
  const svc = new GeminiService(env, token, async (q) => ({
    text: JSON.stringify(fixture(q)),
    tokens: null,
  }));
  assert(svc.pair(origin, 'Bearer ' + token, true));
  const send = () => svc.explain(input(), new AbortController().signal);
  for (let minute = 0; minute < 5; minute++) {
    for (let i = 0; i < 6; i++) assert.equal((await send()).status, 'available');
    assert.equal((await send()).status, 'rate_limited');
    t.mock.timers.tick(60001);
  }
  assert.equal((await send()).status, 'rate_limited');
  t.mock.timers.tick(30 * 60000);
  assert(!svc.pair(origin, 'Bearer ' + token));
  let release!: () => void;
  const held = new GeminiService(env, newPairToken(), async () => {
    await new Promise<void>((ok) => {
      release = ok;
    });
    return { text: JSON.stringify(fixture(r)), tokens: null };
  });
  const pending = held.explain(r, new AbortController().signal);
  assert.equal((await held.explain(r, new AbortController().signal)).status, 'rate_limited');
  release();
  assert.equal((await pending).status, 'available');
});
test('E02/E05 fixture threat cache partitions exact subjects and respects positive expiry before and after 60 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let calls = 0;
  const connector: Provider = {
    id: 'url_threat',
    positiveThreatExpiry: (r) => Date.parse(r.evidence[0]!.expiresAt!),
    async lookup(subject) {
      calls++;
      const at = new Date().toISOString();
      const r: FeatureResult = {
        featureId: 'site_trust',
        subject,
        availability: 'available',
        finding: 'Labelled synthetic positive match',
        explanation: 'Fixture only',
        limitations: ['Fixture only'],
        nextStep: '',
        evidence: [
          {
            id: 'fixture',
            subject,
            source: 'Fixture source',
            sourceUrl: null,
            retrievedAt: at,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            freshness: '120s fixture',
            availability: 'available',
            finding: 'Synthetic match',
            coverage: 'Only the named fixture homepage',
          },
        ],
      };
      return r;
    },
  };
  const svc = new ProvidersService({ WEB_RISK_API_KEY: 'DUMMY_SERVER_ONLY' }, [connector]);
  const get = (domain: string) =>
    svc.lookup(
      { provider: 'url_threat', subject: { kind: 'website_risk', domain } },
      new AbortController().signal,
    );
  await get('one.example.com');
  t.mock.timers.tick(61000);
  await get('one.example.com');
  assert.equal(calls, 1);
  await get('two.example.com');
  assert.equal(calls, 2);
  t.mock.timers.tick(60000);
  await get('one.example.com');
  assert.equal(calls, 3);
});
