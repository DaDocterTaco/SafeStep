// Explicit operator-only smoke through one paired candidate API. The safe page is IANA.
// The Google test addresses are strings in Lookup requests; Chrome never visits them.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  ChatRouteReply,
  ThreatReply,
  ThreatRequest,
  Features,
  validatedChatRoute,
} from '@safestep/contracts';
import { fingerprint } from './stage1.mjs';
import { nativeSession } from '../tests/support/native-stage2.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import {
  guardedRuntimeActive,
  WebRiskService,
  webRiskDirectory,
  initializeWebRiskBudget,
} from '../apps/api/dist/web-risk.js';
import { webRiskLimits } from '../apps/api/dist/web-risk-budget.js';
import { checkAutomaticArrivals, until } from './web-risk-arrival-check.mjs';
const args = process.argv.slice(2);
const automatic = args.includes('--automatic-arrival');
const samples = automatic
  ? [
      {
        label: 'Initial IANA Example Domains arrival on enable',
        url: 'https://www.iana.org/help/example-domains',
        expected: 'no_match',
        purpose: 'arrival',
      },
      {
        label: 'IANA Instructions and Guides, native panel closed',
        url: 'https://www.iana.org/help',
        expected: 'no_match',
        purpose: 'arrival',
      },
      ...(args.includes('--phishing-control')
        ? [
            {
              label: 'Official phishing test via Lookup only',
              url: 'http://testsafebrowsing.appspot.com/s/phishing.html',
              expected: 'SOCIAL_ENGINEERING',
              purpose: 'manual',
            },
          ]
        : []),
    ]
  : [
      {
        label: 'Google documented malware control',
        url: 'http://testsafebrowsing.appspot.com/s/malware.html',
        expected: 'MALWARE',
      },
      {
        label: 'Public IANA control',
        url: 'https://www.iana.org/help/example-domains',
        expected: 'no_match',
      },
      {
        label: 'Google documented unwanted-software control',
        url: 'http://testsafebrowsing.appspot.com/s/unwanted.html',
        expected: 'UNWANTED_SOFTWARE',
      },
    ];
const hint = {
  mode: 'dry plan',
  sourceCap:
    'Retain preflight 12/day. Never initialize over an existing directory, migrate or change profile.',
  controls: samples,
  disclosures: automatic
    ? 'Pair normally, grant only www.iana.org and enable automatic public URL checks. The actual two IANA documents are visited. The optional phishing control is checked via API only. No model call is part of an arrival; explicit optional model routing requires a separately named current session.'
    : 'An actual run sends only the three displayed public URL strings to direct Google Lookup, under the dedicated server key. It opens a temporary Chrome profile on the public IANA page; model requests require an additional explicit option and a valid current operator window.',
  schedule:
    'At most ' +
    samples.length +
    ' distinct requests; stop on missing access, source/quota error, expiry, unexpected session use or invalid reply. No model-window rollover.',
};
if (!args.includes('--run')) {
  console.log(JSON.stringify(hint, null, 2));
  process.exit(0);
}
assert(
  args.every(
    (a) =>
      [
        '--run',
        '--init-preflight-if-absent',
        '--model-once-if-active',
        '--automatic-arrival',
        '--phishing-control',
      ].includes(a) ||
      /^--model-session=\d{1,8}$/.test(a) ||
      /^stage-8-[0-9a-f]{12}$/.test(a),
  ),
);
if (automatic)
  assert(!args.includes('--init-preflight-if-absent'), 'The existing journal must be retained.');
if (args.includes('--phishing-control')) assert(automatic);
const expectedModelSession = Number(
  args.find((a) => a.startsWith('--model-session='))?.split('=')[1] ?? 0,
);
if (args.includes('--model-once-if-active'))
  assert(expectedModelSession > 0, 'An explicitly approved existing model session ID is required.');
const build = args.find((a) => /^stage-8-[0-9a-f]{12}$/.test(a));
if (args.includes('--model-once-if-active'))
  assert.equal(process.env.SAFESTEP_GEMINI_CALLER_ROLE,'builder','An atomic eight-slot owner reserve is required.');
assert(build);
assert(
  guardedRuntimeActive(),
  'Use --import ./scripts/stage8-paid-ledger.mjs; refusing unguarded launch.',
);
assert(
  process.env.SAFESTEP_WEB_RISK_AUTHORIZED === 'true',
  'Explicit operator permission missing.',
);
assert(process.env.GEMINI_MODEL === 'gemini-3.5-flash-lite');
assert(
  process.env.WEB_RISK_API_KEY?.trim() &&
    process.env.WEB_RISK_API_KEY.trim() !== process.env.GEMINI_API_KEY?.trim(),
);
const path = resolve('docs/evidence', build),
  bundle = resolve('artifacts', build, 'chrome-mv3');
const pointer = JSON.parse(await readFile(join(path, 'current-reference.json'), 'utf8'));
const ref = JSON.parse(await readFile(pointer.path, 'utf8'));
assert.equal(pointer.id, build);
assert.equal((await fingerprint(bundle)).sha256, ref.extensionSHA256);
for (const [file, sum] of Object.entries({ ...ref.api.files, ...ref.compiledContracts.files }))
  assert.equal(
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
    sum,
    file,
  );
assert.equal(webRiskDirectory, join(homedir(), '.safestep', 'web-risk'));
if (!existsSync(webRiskDirectory)) {
  assert(
    args.includes('--init-preflight-if-absent'),
    'No source journal. An explicit first initialization is required.',
  );
  initializeWebRiskBudget(webRiskDirectory, 12);
}
const limits = webRiskLimits(webRiskDirectory);
assert(
  limits.profile === 'preflight' &&
    limits.dayCap === 12 &&
    limits.minuteCap === 12 &&
    limits.monthCap === 372,
);
function riskUse() {
  const db = new DatabaseSync(join(webRiskDirectory, 'limits.sqlite'), { readOnly: true });
  try {
    return {
      attempts: Number(
        db.prepare("SELECT count(*) AS n FROM admissions WHERE kind='lookup'").get().n,
      ),
      today: Number(
        db
          .prepare('SELECT coalesce(sum(units),0) AS n FROM admissions WHERE day=?')
          .get(Math.floor(Date.now() / 86400000)).n,
      ),
      blockedUntil: Number(
        db.prepare('SELECT blockedUntil FROM meter WHERE id=1').get().blockedUntil,
      ),
    };
  } finally {
    db.close();
  }
}
function modelUse() {
  const db = new DatabaseSync(resolve('.test-artifacts/stage8-paid-budget/ledger.sqlite'), {
    readOnly: true,
  });
  try {
    const s = db.prepare('SELECT id,expires FROM sessions ORDER BY id DESC LIMIT 1').get();
    return {
      ...s,
      count: Number(db.prepare('SELECT count(*) AS n FROM attempts WHERE session=?').get(s.id).n),
      recent: Number(
        db.prepare('SELECT count(*) AS n FROM attempts WHERE at>?').get(Date.now() - 60000).n,
      ),
      exposureUSD:
        Number(
          db.prepare('SELECT coalesce(sum(coalesce(charged,reserved)),0) AS n FROM attempts').get()
            .n,
        ) / 2000000,
    };
  } finally {
    db.close();
  }
}
const before = riskUse(),
  modelBefore = modelUse();
assert(
  before.today + samples.length <= limits.dayCap && before.blockedUntil <= Date.now(),
  'Too few available source admissions or active 429 backoff.',
);
const token = newPairToken(),
  realModel = new GeminiService(process.env, token),
  source = new WebRiskService(process.env);
const used = new Set(),
  observations = [];
let allowed = null;
const routeGoal = 'What independent reputation evidence is available about this website?';
let serverModelRequest = false,
  observedRoute = null;
const monitoringModel = new Proxy(realModel, {
  get(target, name) {
    if (
      [
        'health',
        'chatHealth',
        'explanationHealth',
        'assistHealth',
        'comparisonHealth',
        'cleanupHealth',
        'pair',
      ].includes(name)
    )
      return target[name].bind(target);
    if (name === 'route')
      return async (input, signal) => {
        assert(modelSpent === 1 && !serverModelRequest && args.includes('--model-once-if-active'));
        const c = modelUse();
        assert(
          c.id === expectedModelSession &&
            c.id === modelBefore.id &&
            c.count === modelBefore.count &&
            c.count < 22 &&
            c.recent < 6 &&
            c.expires > Date.now() + 12000,
        );
        assert.equal(input.text, automatic ? routeGoal : 'Check this public website.');
        serverModelRequest = true;
        const dto = ChatRouteReply.parse(await target.route(input, signal));
        const d = dto.decision && validatedChatRoute(dto.decision, input);
        observedRoute = {
          status: dto.status,
          tokens: dto.tokens,
          elapsedMs: dto.elapsedMs,
          schemaValidated: !!d,
          bound: dto.bindingToken === input.bindingToken && dto.operationId === input.operationId,
          feature: d?.kind === 'routed' ? d.feature : null,
        };
        return dto;
      };
    throw Error('This verification only permits separately authorized chat routing.');
  },
});
const api = makeApi(undefined, monitoringModel, undefined, {
  readiness: () => source.readiness(),
  diagnostics: () => source.diagnostics(),
  async check(input, signal) {
    assert(
      allowed &&
        input.url === allowed &&
        input.scope === 'page' &&
        input.purpose === (samples.find((s) => s.url === allowed)?.purpose ?? 'manual'),
    );
    assert(!used.has(input.url) && used.size < samples.length);
    used.add(input.url);
    allowed = null;
    const marker = riskUse();
    assert.equal(
      marker.attempts - before.attempts,
      observations.filter((x) => x.upstreamAdmission).length,
    );
    assert(marker.attempts - before.attempts < samples.length);
    const receipt = ThreatReply.parse(await source.check(input, signal)),
      after = riskUse(),
      sample = samples.find((s) => s.url === input.url);
    assert.equal(receipt.url, input.url);
    assert.equal(receipt.purpose, input.purpose);
    assert.equal(receipt.scope, input.scope);
    const delta = after.attempts - marker.attempts;
    assert(delta === 0 || delta === 1);
    observations.push({
      ...sample,
      receipt,
      upstreamAdmission: delta,
      journalBefore: marker.attempts,
      journalAfter: after.attempts,
      expectedObserved:
        sample.expected === 'no_match'
          ? receipt.status === 'no_match'
          : receipt.status === 'match' &&
            receipt.categories.includes(sample.expected) &&
            Date.parse(receipt.expiresAt) > Date.now(),
    });
    return receipt;
  },
});
const report = {
  role: 'builder',
  build,
  sourceSHA256: ref.source.sha256,
  extensionSHA256: ref.extensionSHA256,
  apiSHA256: ref.api.sha256,
  contractsSHA256: ref.compiledContracts.sha256,
  evidence: automatic
    ? 'Genuine native selected-site Chrome grant and versioned automatic consent. Source observations are independently reconciled with the durable journal, including panel-closed arrival. Optional phishing probe is a paired Lookup-only control.'
    : 'Real installed Chrome extension origin and operator-paired API. Threat subjects submitted by this bounded harness through the same authenticated endpoint; this is upstream API proof, not automatic-navigation UI acceptance.',
  started: new Date().toISOString(),
  sourceAllowance: limits.profile,
  riskBefore: before,
  modelBefore,
  results: [],
  status: 'blocked',
};
const out = join(
  path,
  automatic ? 'automatic-arrival-live' : 'automatic-web-risk-live',
  report.started.replace(/[:.]/g, '-'),
);
await mkdir(out, { recursive: true });
const save = () => writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
let browser,
  modelAllow = false,
  modelSpent = 0;
try {
  api.listen(4317, '127.0.0.5');
  await once(api, 'listening');
  browser = await nativeSession(bundle, 1440, 900, 'https://www.iana.org/help/example-domains', {
    apiHost: '127.0.0.5',
    attachWorker: true,
  });
  report.dimensions = browser.dimensions;
  report.chrome = await browser.browser.version();
  assert.equal(
    resolve(
      (await browser.root.send('Extensions.getExtensions')).extensions.find(
        (e) => e.id === browser.id && e.enabled,
      )?.path,
    ),
    bundle,
  );
  // Guard every service worker/panel model endpoint before dispatch. None is
  // used for threat checks. An optional single sealed route is separately armed.
  for (const target of [
    browser.panel.target(),
    await browser.browser.waitForTarget(
      (t) =>
        t.type() === 'service_worker' &&
        t.url().startsWith('chrome-extension://' + browser.id + '/'),
    ),
  ]) {
    const cdp = await target.createCDPSession();
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: 'http://127.0.0.1:4317/*', requestStage: 'Request' }],
    });
    cdp.on('Fetch.requestPaused', async (e) => {
      const p = new URL(e.request.url).pathname;
      let ok =
        e.request.method === 'GET' ||
        e.request.method === 'OPTIONS' ||
        p === '/v1/explain/connect' ||
        p === '/v1/threat/check';
      if (p === '/v1/chat/route' && e.request.method === 'POST' && modelAllow && modelSpent === 0) {
        const m = modelUse();
        ok =
          m.id === modelBefore.id &&
          m.count === modelBefore.count &&
          m.count < 22 &&
          m.recent < 6 &&
          m.expires > Date.now() + 12000 &&
          m.exposureUSD < 3.9;
        modelAllow = false;
        if (ok) modelSpent++;
      }
      await cdp
        .send(
          ok ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          ok
            ? { requestId: e.requestId }
            : { requestId: e.requestId, errorReason: 'BlockedByClient' },
        )
        .catch(() => {});
    });
  }
  const panel = browser.panel,
    btn = (name) => panel.locator('::-p-aria(' + name + '[role="button"])').setTimeout(7500);
  await btn('Settings').click();
  await panel.locator('summary::-p-text(Connect local AI)').click();
  await panel.type('input[type=password]', token);
  await btn('Connect').click();
  await panel.waitForFunction(
    () => document.body.innerText.includes('Connected to Gemini · gemini-3.5-flash-lite'),
    { timeout: 8500 },
  );
  await btn('Close Settings').click();
  async function post(path, body) {
    // Use Chrome's real extension origin; keep the ephemeral bearer in memory.
    return browser.panel.evaluate(
      async ({ path, body, token }) => {
        const resp = await fetch('http://127.0.0.1:4317' + path, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(14000),
        });
        if (!resp.ok) throw Error('Paired API returned HTTP ' + resp.status);
        return resp.json();
      },
      { path, body, token },
    );
  }
  if (automatic) {
    const arrived = await checkAutomaticArrivals({
      browser,
      controls: samples,
      arm: (url) => {
        allowed = url;
      },
      observations,
      record: report,
      out,
    });
    report.results = observations;
    report.arrivalOnlyGeminiGenerations = modelUse().count - modelBefore.count;
    assert.equal(report.arrivalOnlyGeminiGenerations, 0);
    await save();
    if (!arrived) throw Error('A real automatic source result is unavailable or rate limited.');
  }
  for (const sample of samples.filter((s) => !automatic || s.purpose === 'manual')) {
    assert(riskUse().attempts - before.attempts < 3);
    allowed = sample.url;
    const input = ThreatRequest.parse({ scope: 'page', purpose: 'manual', url: sample.url });
    const marker = riskUse();
    const receipt = ThreatReply.parse(await post('/v1/threat/check', input));
    const after = riskUse();
    assert.equal(receipt.url, input.url);
    assert.equal(receipt.scope, 'page');
    assert.equal(receipt.purpose, 'manual');
    assert(after.attempts - marker.attempts >= 0 && after.attempts - marker.attempts <= 1);
    if (!automatic)
      report.results.push({
        ...sample,
        receipt,
        upstreamAdmission: after.attempts - marker.attempts,
        expectedObserved:
          sample.expected === 'no_match'
            ? receipt.status === 'no_match'
            : receipt.status === 'match' &&
              receipt.categories.includes(sample.expected) &&
              Date.parse(receipt.expiresAt) > Date.now(),
      });
    await save();
    if (['unavailable', 'rate_limited'].includes(receipt.status)) break;
  }
  report.modelSanity = 'Not requested; background protection made zero model requests.';
  if (
    args.includes('--model-once-if-active') &&
    report.results.length === samples.length &&
    report.results.every(
      (r) => r.upstreamAdmission === 1 && ['match', 'no_match'].includes(r.receipt.status),
    )
  ) {
    const m = modelUse();
    if (
      m.id === modelBefore.id &&
      m.id === expectedModelSession &&
      m.count === modelBefore.count &&
      m.count < 22 &&
      m.recent < 6 &&
      m.expires > Date.now() + 12000 &&
      m.exposureUSD < 3.9
    ) {
      modelAllow = true;
      if (automatic) {
        await browser.panel.focus('#chat-composer');
        await browser.panel.keyboard.type(routeGoal);
        await browser.panel.keyboard.press('Enter');
        report.modelSanity = await until(() => observedRoute, 'one genuine typed chat result');
        const evidence = await until(
          () =>
            browser.panel.evaluate((g) => {
              const log = document.querySelector('[role=log]');
              const term = log?.innerText;
              return term?.includes(g) && /website|trust/i.test(term.replace(g, ''))
                ? term.slice(-1200)
                : null;
            }, routeGoal),
          'result in the visible chat',
        );
        report.modelSanity.visibleChat = evidence;
        await browser.panel.screenshot({ path: join(out, 'optional-router-panel.png') });
      } else {
        const input = {
          version: 1,
          operationId: randomUUID(),
          bindingToken: randomUUID(),
          conversationId: randomUUID(),
          turnId: randomUUID(),
          contextKey: randomUUID(),
          text: 'Check this public website.',
          history: [],
          subjects: [],
          available: [...Features],
          site: { origin: 'https://www.iana.org', path: '/help/example-domains' },
          mode: null,
        };
        const data = ChatRouteReply.parse(await post('/v1/chat/route', input)),
          decision = data.decision && validatedChatRoute(data.decision, input);
        report.modelSanity = {
          status: data.status,
          tokens: data.tokens,
          schemaValidated: !!decision,
          bound: data.operationId === input.operationId && data.bindingToken === input.bindingToken,
          feature: decision?.kind === 'routed' ? decision.feature : null,
        };
      }
    } else
      report.modelSanity =
        'Blocked: no current approved model slot/window with eight owner calls reserved. No model request.';
  }
  report.status =
    report.results.length === samples.length &&
    report.results.every((r) => r.expectedObserved && r.upstreamAdmission === 1) &&
    (!args.includes('--model-once-if-active') ||
      (report.modelSanity?.schemaValidated &&
        report.modelSanity?.bound &&
        report.modelSanity?.tokens > 0))
      ? 'verified-all-controls'
      : 'partial';
} catch (e) {
  report.error = String(e.message)
    .replace(/AIza[\w-]+|ss3_[\w-]+/g, '[redacted]')
    .slice(0, 240);
} finally {
  if (browser) await browser.browser.close();
  if (api.listening) {
    api.closeAllConnections();
    await new Promise((ok) => api.close(ok));
  }
  report.finished = new Date().toISOString();
  report.riskAfter = riskUse();
  report.modelAfter = modelUse();
  assert(report.riskAfter.attempts - before.attempts <= samples.length);
  assert(report.modelAfter.count - modelBefore.count <= 1);
  if (modelSpent) {
    const db = new DatabaseSync(resolve('.test-artifacts/stage8-paid-budget/ledger.sqlite'), {
      readOnly: true,
    });
    try {
      report.modelLedgerReceipts = db
        .prepare(
          'SELECT id,session,operation,at,state,http,total,category FROM attempts WHERE session=? AND at>=? ORDER BY id',
        )
        .all(modelBefore.id, Date.parse(report.started));
    } finally {
      db.close();
    }
    const rows = report.modelLedgerReceipts;
    if (
      rows.length !== 1 ||
      rows[0]?.operation !== 'chat_route' ||
      rows[0].state !== 'settled' ||
      rows[0].total !== report.modelSanity?.tokens
    )
      report.status = 'partial';
  }
  await save();
  console.log(
    JSON.stringify({
      status: report.status,
      webRiskAdmissions: report.riskAfter.attempts - before.attempts,
      modelCalls: report.modelAfter.count - modelBefore.count,
      report: join(out, 'results.json'),
    }),
  );
}
