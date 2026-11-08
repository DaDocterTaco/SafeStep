// Builder checks on real public pages. Live mode requires a guarded private service. Fixture mode uses only a local proposal generator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFixture } from './support/functional-navigation-fixture.mjs';
import { get as httpGet } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ChatRouteReply,
  AssistReply,
  validatedChatRoute,
  checkedIntent,
  checkedStep,
} from '@safestep/contracts';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { fingerprint } from '../scripts/stage1.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const build = process.env.SAFESTEP_NAV_BUILD;
assert.match(build, /^stage-8-[0-9a-f]{12}$/);
const bundle = resolve(root, 'artifacts', build, 'chrome-mv3');
const ext = await fingerprint(bundle);
assert.equal(build, 'stage-8-' + ext.sha256.slice(0, 12));
const refPath = join(root, 'docs/evidence', build, 'current-reference.json');
const ref = await readFile(refPath, 'utf8')
  .then(JSON.parse)
  .catch(() => ({}));
if (ref.extensionSHA256) assert.equal(ref.extensionSHA256, ext.sha256);
const releaseReference = ref.path ? JSON.parse(await readFile(ref.path, 'utf8')) : null;
async function compiledIdentity(group) {
  if (!group) return null;
  const hash = createHash('sha256');
  for (const file of Object.keys(group.files).sort()) {
    const bytes = await readFile(file);
    hash.update(file + '\0' + bytes.length + '\0');
    hash.update(bytes);
  }
  const actual = hash.digest('hex');
  return { actual, reference: group.sha256, matches: actual === group.sha256 };
}
const actualAPI = await compiledIdentity(releaseReference?.api),
  actualContracts = await compiledIdentity(releaseReference?.compiledContracts);
const live = process.env.SAFESTEP_NAV_MODE === 'live';
function providerReceipts(row) {
  const ledger = new DatabaseSync(join(root, '.test-artifacts/stage8-paid-budget/ledger.sqlite'), {
    readOnly: true,
  });
  try {
    const ops = { route: 'chat_route', intent: 'assist_intent', step: 'assist_step' };
    const reserved = new Set();
    const data = ledger
      .prepare(
        'SELECT id,session,at,ended,http,state,category,total,operation,charged,reserved FROM attempts WHERE model=? AND at BETWEEN ? AND ? ORDER BY at',
      )
      .all(expectedModel, Date.parse(row.started) - 750, Date.parse(row.ended) + 750);
    for (const obs of row.connector) {
      const start = Date.parse(obs.at);
      const candidates = data.filter(
        (x) =>
          !reserved.has(x.id) &&
          x.operation === ops[obs.operation] &&
          x.at >= start - 250 &&
          x.at <= start + 1800 &&
          x.total === obs.tokens,
      );
      if (candidates.length !== 1) continue;
      const x = candidates[0];
      reserved.add(x.id);
      obs.providerReceipt = {
        id: x.id,
        session: x.session,
        googleHTTP: x.http,
        state: x.state,
        category: x.category,
        tokens: x.total,
        accountedUSD: (x.charged ?? x.reserved) / 2000000,
      };
    }
    return row.connector
      .filter((c) => c.bound && c.validated && c.status === 'available')
      .every(
        (c) => c.providerReceipt?.googleHTTP === 200 && c.providerReceipt?.state === 'settled',
      );
  } finally {
    ledger.close();
  }
}
if (live)
  assert(
    actualAPI?.matches && actualContracts?.matches,
    'Live runs require the identified final API and contract outputs.',
  );
const apiHost = live ? '127.0.0.7' : '127.0.0.8';
const apiOrigin = 'http://' + apiHost + ':4317';
const expectedModel = live ? 'gemini-3.5-flash-lite' : 'gemini-fixture-only';
const names = [
  'wiki-guide',
  'wiki-auto',
  'mars-guide',
  'mars-auto',
  'mdn-guide',
  'mdn-auto',
  'python-guide',
  'python-auto',
  'transfer-guide',
  'transfer-auto',
  'vlc-guide',
  'vlc-auto',
  'zip-guide',
  'zip-auto',
];
const selected = process.argv[2]?.split(',') ?? [];
const widths = process.argv[3] === 'both' ? [1440, 1366] : [Number(process.argv[3])];
assert(
  selected.length &&
    selected.every((n) => names.includes(n)) &&
    widths.every((w) => [1440, 1366].includes(w)),
);
const out = join(
  root,
  'docs/evidence/functional-navigation/native',
  build,
  new Date().toISOString().replace(/[:.]/g, '-') +
    '-' +
    (live ? 'live' : 'fixture') +
    '-' +
    widths.join('-'),
);
await mkdir(out, { recursive: true });
const mainWiki = 'https://en.wikipedia.org/wiki/Main_Page';
const mdnRoot =
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array';
let fixtureToken;
const time = () => new Date().toISOString();
const button = (p, name) => p.locator('::-p-aria(' + name + '[role="button"])').setTimeout(9000);
const state = async (s) => (await view(s.panel)).v;
const active = (v) => v.chat?.turns.find((t) => t.id === v.chat.activeTurnId);
const sessionRows = [];
function scenario(name) {
  const auto = !name.endsWith('-guide');
  if (/^(wiki|mars)/.test(name)) {
    const subject = name.startsWith('mars') ? 'Mars' : 'Earth';
    return {
      name,
      auto,
      code: auto ? 'S8-L02' : 'S8-L01',
      start: mainWiki,
      goal:
        (auto ? 'Take me to' : 'Show me how to find') +
        ' the Wikipedia article about the atmosphere of ' +
        subject +
        '.',
      title: 'Atmosphere of ' + subject,
    };
  }
  if (name.startsWith('mdn')) {
    const method = 'filter';
    return {
      name,
      auto,
      code: auto ? 'S8-L02' : 'S8-L01',
      start: mdnRoot,
      goal:
        (auto ? 'Take me to' : 'Show me') +
        ' the Examples section for JavaScript Array.' +
        method +
        ' on MDN.',
      method,
    };
  }
  if (name.startsWith('python'))
    return {
      name,
      auto,
      start: 'https://docs.python.org/3/tutorial/index.html',
      goal:
        (auto ? 'Take me to' : 'Show me') +
        ' the Handling Exceptions section of the Python tutorial.',
      heading: 'Handling Exceptions',
      endPath: '/3/tutorial/errors.html',
      endHash: 'handling-exceptions',
    };
  if (name.startsWith('transfer'))
    return {
      name,
      auto,
      start: 'https://www.iana.org/help',
      goal: (auto ? 'Take me to' : 'Help me find') + ' Example Domains.',
      heading: 'Example Domains',
      endPath: '/help/example-domains',
    };
  const vlc = name.startsWith('vlc');
  return {
    name,
    auto,
    code: 'S8-L03',
    start: vlc ? 'https://www.videolan.org/' : 'https://www.7-zip.org/',
    goal:
      'Help me find the ' +
      (vlc ? 'VLC' : '7-Zip') +
      ' Windows x64 EXE download on the official website.',
    choice: (vlc ? 'VLC' : '7-Zip') + ' · Windows x64 EXE',
    profile: vlc ? 'vlc_windows_x64' : 'seven_zip_windows_x64_exe',
  };
}
async function until(fn, why, ms = 30000) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) {
    const x = await fn();
    if (x) return x;
    await sleep(140);
  }
  throw Error('Timed out: ' + why);
}
async function health() {
  const get = async (part) => {
    return new Promise((resolve, reject) => {
      const req = httpGet(
        apiOrigin + '/v1/' + part + '/health',
        { headers: { host: '127.0.0.1:4317' }, signal: AbortSignal.timeout(3000) },
        async (res) => {
          try {
            assert.equal(res.statusCode, 200);
            let body = '';
            for await (const chunk of res) body += chunk;
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        },
      );
      req.on('error', reject);
    });
  };
  const [chat, assist] = await Promise.all([get('chat'), get('assist')]);
  assert(
    chat.configured &&
      assist.configured &&
      [chat.model, assist.model].every((x) => x === expectedModel),
    'Approved service/model unavailable.',
  );
  return { chat, assist };
}
async function pair(s) {
  const token = live
    ? (
        await readFile(join(root, '.test-artifacts/functional-paid/.env.safestep-session'), 'utf8')
      ).trim()
    : fixtureToken;
  assert(/^ss3_[A-Za-z0-9_-]{43}$/.test(token), 'Paired service needs a fresh temporary token.');
  await button(s.panel, 'Settings').click();
  await s.panel.locator('summary::-p-text(Connect local AI)').click();
  await s.panel.type('input[type=password]', token);
  await button(s.panel, 'Connect').click();
  await s.panel.waitForFunction(
    (m) => document.body.innerText.includes('Connected to Gemini · ' + m),
    { timeout: 8000 },
    expectedModel,
  );
  await button(s.panel, 'Close Settings').click();
}
function publicPlace(raw) {
  const u = new URL(raw);
  const known = ['search', 'title', 'ns0', 'wprov', 'fulltext', 'profile', 'searchToken'];
  const keys = [...u.searchParams.keys()];
  const provenance = u.searchParams.get('wprov');
  return {
    origin: u.origin,
    path: u.pathname,
    fragment: u.hash.replace(/^#/, ''),
    ...(keys.length
      ? {
          publicQueryKeys: keys.filter((k) => known.includes(k)),
          otherQueryCount: keys.filter((k) => !known.includes(k)).length,
        }
      : {}),
    ...(/^(acrw1|srpw1)_[0-9]{1,2}$/.test(provenance ?? '')
      ? { publicProvenance: provenance }
      : {}),
  };
}
async function observeConnector(s, r) {
  const worker = await s.browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + s.id + '/'),
    { timeout: 8000 },
  );
  const cdp = await worker.createCDPSession();
  const captures = new Map(),
    pending = new Set();
  cdp.on('Network.requestWillBeSent', (e) => {
    const u = new URL(e.request.url);
    if (
      e.request.method !== 'POST' ||
      u.origin !== 'http://127.0.0.1:4317' ||
      !['/v1/chat/route', '/v1/assist/intent', '/v1/assist/step'].includes(u.pathname)
    )
      return;
    const operation = u.pathname.split('/').at(-1);
    const receipt = { at: time(), operation, status: 'pending' };
    // Inputs are transient. Persist no headers, credentials, page snapshots, free text, or binding tokens.
    let input;
    try {
      input = JSON.parse(e.request.postData ?? '');
    } catch {}
    r.connector.push(receipt);
    captures.set(e.requestId, { receipt, input });
  });
  cdp.on('Network.responseReceived', (e) => {
    const x = captures.get(e.requestId);
    if (x) x.receipt.http = e.response.status;
  });
  cdp.on('Network.loadingFailed', (e) => {
    const x = captures.get(e.requestId);
    if (x) x.receipt.status = 'transport_error';
  });
  cdp.on('Network.loadingFinished', (e) => {
    const x = captures.get(e.requestId);
    if (!x) return;
    const capture = (async () => {
      try {
        const res = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
        const body = JSON.parse(
          res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body,
        );
        const chat = x.receipt.operation === 'route';
        const dto = (chat ? ChatRouteReply : AssistReply).parse(body);
        x.receipt.status = dto.status;
        x.receipt.bound =
          !!x.input &&
          dto.operationId === x.input.operationId &&
          dto.bindingToken === x.input.bindingToken;
        x.receipt.tokens = dto.tokens;
        x.receipt.elapsedMs = dto.elapsedMs;
        if (chat && dto.decision && x.input) {
          const decision = validatedChatRoute(dto.decision, x.input);
          x.receipt.validated = !!decision;
          x.receipt.decision = decision?.kind;
          x.receipt.feature = decision?.kind === 'routed' ? decision.feature : undefined;
        } else if (!chat && dto.explanation && x.input) {
          const intent = x.receipt.operation === 'intent';
          const checked = intent
            ? checkedIntent(dto.explanation, x.input.goal)
            : checkedStep(dto.explanation, x.input);
          x.receipt.validated = !!checked;
          x.receipt.decision = intent ? checked?.action : checked?.kind;
        }
      } catch {
        x.receipt.status = 'unobserved_response';
      } finally {
        captures.delete(e.requestId);
      }
    })();
    pending.add(capture);
    void capture.finally(() => pending.delete(capture));
  });
  await cdp.send('Network.enable', { maxPostDataSize: 65536 });
  return async () => {
    await Promise.all([...pending]);
  };
}
async function shot(s, r, label) {
  for (const [name, page] of [
    ['panel', s.panel],
    ['page', s.page],
  ]) {
    const file = [r.attempt, r.name, r.width, label, name].join('-') + '.png';
    await page.screenshot({ path: join(out, file) });
    r.screens.push(file);
  }
}
async function outlined(page) {
  const h = await page.evaluateHandle(() => {
    const ring = document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();
    if (!ring || document.querySelectorAll('[data-safestep-outline]').length !== 1) return null;
    return (
      [
        ...document.querySelectorAll(
          'a[href],main button,main summary,h1,h2,h3,h4,#p-search input[type=search]',
        ),
      ].find((el) => {
        const b = el.getBoundingClientRect();
        return (
          b.width > 0 &&
          Math.abs(b.left - ring.left - 3) < 2 &&
          Math.abs(b.top - ring.top - 3) < 2 &&
          Math.abs(b.width - ring.width + 6) < 2
        );
      }) ?? null
    );
  });
  return h.asElement();
}
async function manual(s, t, r) {
  const el = await outlined(s.page);
  if (!el) return false;
  const type = await el.evaluate((e) => ({
    tag: e.localName,
    href: e.href ?? null,
    disclosure:
      e.localName === 'summary' ||
      (e.localName === 'button' && !e.closest('form') && e.hasAttribute('aria-expanded')),
  }));
  if (/^h[1-4]$/.test(type.tag)) {
    await button(s.panel, 'Show this target').click();
    return true;
  }
  if (type.tag === 'input') {
    assert(t.adaptive.searchQuery && new URL(s.page.url()).origin === 'https://en.wikipedia.org');
    await el.click();
    await el.type(t.adaptive.searchQuery);
    await s.page.keyboard.press('Enter');
  } else if (type.disclosure) await el.click();
  else {
    assert(
      type.tag === 'a' && type.href,
      'manual mode only activates a verified public link or Wikipedia search',
    );
    const u = new URL(type.href);
    assert(
      u.origin === new URL(r.start).origin && !/\.(exe|msi|zip|dmg|7z)(?:$|[?#])/i.test(type.href),
      'terminal file or external activation forbidden',
    );
    await el.click();
  }
  r.guideSiteActions.push({
    at: time(),
    tag: type.tag,
    destination: type.href
      ? publicPlace(type.href)
      : type.disclosure
        ? 'outlined disclosure'
        : 'displayed public search',
  });
  return true;
}
async function terminal(s, v, r) {
  r.destination = publicPlace(s.page.url());
  if (r.profile) {
    const review = v.review,
      c = review?.candidates.find((x) => x.ref === review.selected);
    assert(
      review?.fileState === 'identified' &&
        review.selection.profile === r.profile &&
        review.binding.taskId === v.task.id,
    );
    assert(c?.publisherPath);
    const target = await outlined(s.page);
    assert(target, 'exact terminal control has an aligned outline');
    const href = await target.evaluate((e) => e.href);
    const u = new URL(href);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.pathname, c.publisherPath);
    assert.equal(u.hostname, r.profile === 'vlc_windows_x64' ? 'get.videolan.org' : 'github.com');
    r.package = {
      label: c.label,
      destination: publicPlace(href),
      reason: c.reason,
      packageHint: c.packageHint,
      source: review.sources.map((x) => x.kind),
    };
  } else if (r.heading) {
    const result = await s.page.evaluate((text) => {
      const headings = [...document.querySelectorAll('h1,h2,h3')];
      const heading = headings.find((h) =>
        h.textContent.trim().toLowerCase().includes(text.toLowerCase()),
      );
      const box = heading?.getBoundingClientRect();
      return {
        visible: !!box && box.top < innerHeight && box.bottom > 0,
        text: heading?.textContent.trim().slice(0, 100),
      };
    }, r.heading);
    assert(result.visible, 'verified intended heading is in view');
    assert.equal(r.destination.path.replace(/\/$/, ''), r.endPath);
    if (r.endHash) assert.equal(r.destination.fragment, r.endHash);
    r.observedHeading = result;
  } else {
    const final = await s.page.evaluate(
      ({ title, method }) => {
        const nodes = title
          ? [...document.querySelectorAll('h1')]
          : [...document.querySelectorAll('main h2,main h3')];
        const h = nodes.find(
          (h) =>
            (h.innerText || h.textContent).trim().toLowerCase() ===
            (title ?? 'Examples').toLowerCase(),
        );
        const box = h?.getBoundingClientRect();
        return {
          text: h?.textContent.trim(),
          visible: !!box && box.top < innerHeight && box.bottom > 0,
          method,
        };
      },
      { title: r.title, method: r.method },
    );
    r.heading = final;
    assert(final.visible, 'requested heading actually in view');
    if (r.title)
      assert.equal(decodeURIComponent(r.destination.path), '/wiki/' + r.title.replaceAll(' ', '_'));
    else assert.equal(r.destination.origin + r.destination.path, mdnRoot + '/' + r.method);
  }
}
async function submit(panel, text) {
  await panel.focus('#chat-composer');
  await panel.keyboard.type(text);
  await panel.keyboard.press('Enter');
}
async function run(spec, width) {
  const r = {
    ...spec,
    width,
    attempt: sessionRows.length + 1,
    status: 'fail',
    started: time(),
    screens: [],
    states: [],
    connector: [],
    arrivals: [],
    guideSiteActions: [],
    fileRequests: 0,
    downloads: 0,
    automaticStart: null,
  };
  let s, settle, fixtureServer;
  try {
    if (!live) {
      const local = await startFixture(spec, r, apiHost);
      fixtureServer = local.server;
      fixtureToken = local.token;
    }
    r.before = await health();
    // Let recent real intent/step operations age out of the six-per-minute window.
    const last = r.before.assist.recent.at(-1);
    const wait = last ? 61000 - (Date.now() - Date.parse(last.at)) : 0;
    if (wait > 0) await sleep(wait);
    s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, spec.start, {
      apiHost,
      attachWorker: true,
      prepare: async (page) => {
        page.on('framenavigated', (f) => {
          if (f === page.mainFrame()) r.arrivals.push({ at: time(), ...publicPlace(f.url()) });
        });
        await page.setRequestInterception(true);
        page.on('request', (q) => {
          if (/\.(exe|msi|dmg|zip|7z)$/i.test(new URL(q.url()).pathname)) {
            r.fileRequests++;
            void q.abort().catch(() => {});
          } else void q.continue().catch(() => {});
        });
      },
    });
    r.dimensions = s.dimensions;
    r.chrome = await s.browser.version();
    const install = (await s.root.send('Extensions.getExtensions')).extensions.find(
      (t) => t.id === s.id,
    );
    assert(install?.enabled && resolve(install.path) === bundle);
    r.loaded = { id: s.id, path: install.path };
    await s.root.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    s.root.on('Browser.downloadWillBegin', () => r.downloads++);
    settle = await observeConnector(s, r);
    await pair(s);
    await submit(s.panel, r.goal);
    let clarified = false;
    const accepted = await until(
      async () => {
        const v = await state(s),
          a = active(v),
          t = v.task;
        if (a?.state === 'clarifying' && !clarified) {
          clarified = true;
          r.clarification = { question: a.text, choices: a.choices ?? [] };
          const exact = r.choice && a.choices?.includes(r.choice);
          if (exact) await button(s.panel, r.choice).click();
          else {
            const restatement = r.title
              ? 'The Wikipedia article titled ' + r.title + '.'
              : r.method
                ? 'The Examples heading on the Array.' + r.method + ' documentation page.'
                : 'The official ' + r.choice + '.';
            assert((r.goal + ' — ' + restatement).length <= 240);
            await submit(s.panel, restatement);
          }
          return false;
        }
        if (
          t?.state === 'paused' ||
          ['error', 'unsupported', 'unavailable', 'awaiting_access'].includes(a?.state)
        )
          throw Error(t?.adaptive?.status ?? a.text);
        if (
          a?.feature &&
          !['visual_guidance', 'automatic_navigation', 'download_guidance'].includes(a.feature)
        )
          throw Error('Unexpected feature ' + a.feature);
        return (
          t?.state === 'awaiting_confirmation' && t.adaptive?.intent && a?.taskId === t.id && t
        );
      },
      'validated chat and intent produced an unapproved task',
      40000,
    );
    assert(
      accepted.goal === r.goal || accepted.goal.startsWith(r.goal + ' — '),
      'original request retained',
    );
    assert(!accepted.adaptive.authorized && accepted.steps === 0);
    r.task = {
      id: accepted.id,
      goal: accepted.goal,
      profile: accepted.adaptive.profile,
      searchQuery: accepted.adaptive.searchQuery,
      intent: accepted.adaptive.intent.action,
      required: accepted.adaptive.intent.constraints.map((x) => x.text),
      excluded: accepted.adaptive.intent.excluded.map((x) => x.text),
    };
    await shot(s, r, 'intent');
    if (spec.auto) {
      await button(s.panel, 'Take me there').click();
      assert.equal(s.page.url(), spec.start);
      assert(!(await state(s)).task.adaptive.authorized);
      await shot(s, r, 'scope');
      r.automaticStart = time();
      await button(s.panel, 'Start automatic').click();
    } else await button(s.panel, 'Show me').click();
    let revision,
      lastState,
      confirmed = false;
    const done = await until(
      async () => {
        const v = await state(s),
          t = v.task;
        if (!t) return false;
        assert.equal(t.id, accepted.id);
        assert.equal(t.goal, accepted.goal);
        const marker = [t.state, t.adaptive.status, t.adaptive.journal?.state, t.steps].join('|');
        if (marker !== lastState) {
          lastState = marker;
          r.states.push({
            at: time(),
            state: t.state,
            status: t.adaptive.status,
            steps: t.steps,
            action: t.adaptive.journal?.action,
            journal: t.adaptive.journal?.state,
            location: publicPlace(s.page.url()),
          });
        }
        if (t.state === 'completed') return v;
        if (
          spec.name.startsWith('transfer') &&
          !confirmed &&
          t.adaptive.status.startsWith('Confirm that')
        ) {
          const u = new URL(s.page.url());
          assert.equal(u.pathname.replace(/\/$/, ''), spec.endPath);
          assert(
            await s.page.evaluate(
              (label) =>
                [...document.querySelectorAll('h1')].some((h) => h.innerText.trim() === label),
              spec.heading,
            ),
          );
          await button(s.panel, 'Yes, this is it').click();
          confirmed = true;
          r.confirmedVisibleDestination = true;
        }
        if (['paused', 'cancelled', 'failed'].includes(t.state)) throw Error(t.adaptive.status);
        if (!spec.auto && t.state === 'showing_step' && revision !== t.revision) {
          if (await manual(s, t, r)) revision = t.revision;
        }
        return false;
      },
      'requested terminal destination',
      85000,
    );
    assert(!done.task.adaptive.authorized);
    await terminal(s, done, r);
    assert.equal(r.downloads, 0);
    assert.equal(r.fileRequests, 0);
    if (spec.auto) {
      assert.equal(r.guideSiteActions.length, 0);
      assert(
        r.arrivals.some((a) => a.at >= r.automaticStart && a.path !== new URL(r.start).pathname) &&
          done.task.steps > 0,
        'automatic progress requires a product navigation after Start',
      );
    }
    await shot(s, r, 'destination');
    await settle();
    r.after = await health();
    const available = (op) =>
      r.connector.filter(
        (x) => x.operation === op && x.bound && x.validated && x.status === 'available',
      );
    assert(
      (!live || r.after.chat.verified) &&
        available('route').some((x) => x.validated && ['routed', 'clarify'].includes(x.decision)),
      'a genuine validated route receipt is required for this attempt',
    );
    assert(
      (!live || r.after.assist.intentVerified) && available('intent').length,
      'no genuine intent response for this task',
    );
    assert(
      (!live || r.after.assist.stepVerified) && available('step').length,
      'no genuine step response for this task',
    );
    r.status = 'pass';
  } catch (e) {
    r.error = String(e.message)
      .replace(/ss3_[A-Za-z0-9_-]+|AIza[\w-]+/g, '[redacted]')
      .slice(0, 320);
    if (s) {
      r.finalLocation = publicPlace(s.page.url());
      const v = await state(s).catch(() => null);
      if (v)
        r.last = {
          turn: active(v)?.state,
          feature: active(v)?.feature,
          task: v.task?.state,
          reason: v.task?.adaptive?.status,
        };
      await shot(s, r, 'diagnostic').catch(() => {});
    }
    if (settle) await settle();
    r.after = await health().catch(() => null);
    if (
      r.connector.some((x) =>
        ['rate_limited', 'not_configured', 'unauthorized', 'timeout', 'unavailable'].includes(
          x.status,
        ),
      ) ||
      /unavailable|rate.limit|expired|timed out|ECONNREFUSED|not.?configured|pairing/i.test(r.error)
    )
      r.status = 'blocked';
  } finally {
    if (s) await s.browser.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    r.ended = time();
    if (live && !providerReceipts(r) && r.status === 'pass') {
      r.status = 'blocked';
      r.error = 'A validated product response lacked a unique matching settled provider receipt.';
    }
    sessionRows.push(r);
    await writeFile(
      join(out, 'results.json'),
      JSON.stringify(
        {
          role: 'builder',
          source: live
            ? 'Product-issued requests to isolated paid Gemini'
            : 'Real public pages in installed Chrome; labelled in-memory proposal fixture, zero Gemini calls',
          build,
          bundle,
          extensionSHA256: ext.sha256,
          sourceSHA256: ref.sourceSHA256,
          actualAPI,
          actualContracts,
          model: expectedModel,
          sessionRows,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(r.name, width, r.status, r.error ?? '');
  }
}
trials: for (const width of widths)
  for (const name of selected) {
    if (live && sessionRows.length) await sleep(61000);
    await run(scenario(name), width);
    if (live && sessionRows.at(-1).status === 'blocked') {
      console.error('Stopping at the first service block. See', out);
      process.exitCode = 1;
      break trials;
    }
    if (sessionRows.at(-1).status !== 'pass') process.exitCode = 1;
  }
console.log('Evidence:', out);
