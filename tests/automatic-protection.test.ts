import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ThreatRequest, type ThreatReply } from '@safestep/contracts';
import { Protection } from '../apps/extension/core/protection';
import { Store } from '../apps/extension/core/store';
import { advance } from '../apps/extension/core/state';
import { expectedAddress, explainExpectedAddress } from '../apps/extension/sites/expected-address';

const origin = 'https://www.videolan.org',
  second = 'https://resell.store';
const press = () => new Promise((resolve) => setTimeout(resolve, 4));
test('the exact protection pause retains its destination warning after retiring the action epoch',async t=>{
  const f=world(t);await f.emit();await until(()=>f.shown()?.threat?.status==='no_match');
  const s=f.store.get(1);
  s.cp.task={id:'test-task',state:'planning',adaptive:{version:1,status:'Planning'}} as typeof s.cp.task;
  f.handler(async q=>f.reply(q,'match'));
  const verdict=await f.target(second+'/discover');
  assert.equal(verdict.allow,false);
  advance(s);s.cp.task!.state='paused';s.cp.task!.adaptive!.status=verdict.reason!;
  assert.equal(await f.worker.isCurrent(f.tabs.get(1) as chrome.tabs.Tab,f.shown()!),true);
  assert.equal(f.shown()?.destination?.result?.status,'match');
  s.cp.task!.adaptive!.version++;advance(s);
  assert.equal(await f.worker.isCurrent(f.tabs.get(1) as chrome.tabs.Tab,f.shown()!),false);
  assert.equal(f.shown()?.destination,undefined);
});
test('an explicit publisher or typed hostname sets the expected origin without trusting path brand text', () => {
  assert.equal(expectedAddress('Check https://example.org/wiki/VideoLAN'), null);
  assert.equal(
    expectedAddress('Check this address https://example.org/vlc and I expect VideoLAN'),
    'videolan.org',
  );
  assert.equal(expectedAddress('Is this the official Mozilla website?'), 'mozilla.org');
  assert.equal(expectedAddress('Which website? — support.mozilla.org'), 'support.mozilla.org');
  assert.match(
    explainExpectedAddress('https://www.videolan.org/support/', 'videolan.org'),
    /matches the expected/,
  );
  assert.match(
    explainExpectedAddress('https://videolan.org.example.org/support/', 'videolan.org'),
    /does not match/,
  );
});
async function until(test: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (test()) return;
    await press();
  }
  assert.ok(test());
}
function world(t: TestContext) {
  const store = new Store(),
    worker = new Protection(store, async () => {});
  store.prefs.protection = {
    scope: 'selected',
    sites: [origin, second],
    outside: false,
    automaticUrlConsent: 2,
    budget: 5,
  };
  const tabs = new Map([
    [1, { id: 1, url: origin + '/support/', doc: 'one', active: true, incognito: false }],
    [2, { id: 2, url: origin + '/support/', doc: 'two', active: true, incognito: false }],
  ]);
  const grants = new Set([origin + '/*', second + '/*']);
  const memory: Record<string, unknown> = { 'local-ai-session': 'ss3_' + 't'.repeat(43) };
  const requests: ThreatRequest[] = [];
  const shown = () => store.get(1).protection;
  let handler = (req: ThreatRequest): Promise<ThreatReply> =>
    Promise.resolve(reply(req, 'no_match'));
  function reply(req: ThreatRequest, status: ThreatReply['status']): ThreatReply {
    return {
      ...req,
      source: 'Google Web Risk Lookup',
      status,
      checkedAt: new Date().toISOString(),
      categories: status === 'match' ? ['UNWANTED_SOFTWARE'] : [],
      expiresAt: status === 'match' ? new Date(Date.now() + 120000).toISOString() : null,
      reason: status === 'rate_limited' ? 'quota' : status === 'unavailable' ? 'source' : null,
    };
  }
  t.mock.method(globalThis, 'fetch', async (input, opts) => {
    const route = new URL(String(input)).pathname;
    if (route === '/v1/explain/connect')
      return Response.json({
        provider: 'Gemini',
        model: null,
        credentialPresent: false,
        state: 'not_configured',
        connected: true,
      });
    assert.equal(route, '/v1/threat/check');
    const req = ThreatRequest.parse(JSON.parse(String(opts?.body)));
    requests.push(req);
    return Response.json(await handler(req));
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: { id: 'extension', sendMessage: async () => {} },
      action: {
        setBadgeText: async () => {},
        setTitle: async () => {},
        setBadgeBackgroundColor: async () => {},
      },
      tabs: { get: async (id: number) => ({ ...tabs.get(id)! }), sendMessage: async () => {} },
      permissions: {
        contains: async ({ origins }: { origins: string[] }) => origins.every((o) => grants.has(o)),
      },
      storage: {
        session: {
          get: async (k: string | undefined | null) =>
            typeof k === 'string' ? { [k]: memory[k] } : { ...memory },
          set: async (obj: Record<string, unknown>) => Object.assign(memory, obj),
          remove: async (k: string) => {
            delete memory[k];
          },
        },
      },
      scripting: {
        executeScript: async ({
          target,
        }: {
          target: { tabId: number; documentIds?: string[] };
        }) => {
          const tab = tabs.get(target.tabId)!;
          return [
            {
              frameId: 0,
              documentId: tab.doc,
              result: target.documentIds ? 'a'.repeat(32) : new URL(tab.url).origin,
            },
          ];
        },
      },
    },
  });
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'chrome', previous)
      : Reflect.deleteProperty(globalThis, 'chrome'),
  );
  const emit = (id = 1, w = worker) =>
    w.page(
      { op: 'arrive' },
      {
        id: 'extension',
        frameId: 0,
        documentId: tabs.get(id)!.doc,
        tab: tabs.get(id) as chrome.tabs.Tab,
      },
    );
  const target = (
    raw: string,
    kind: 'navigation' | 'download' | 'offer' = 'navigation',
    signal = new AbortController().signal,
  ) =>
    worker.destination(
      store.get(1),
      tabs.get(1) as chrome.tabs.Tab,
      { kind, url: raw, documentId: tabs.get(1)!.doc },
      signal,
    );
  return {
    store,
    worker,
    tabs,
    grants,
    memory,
    requests,
    shown,
    emit,
    target,
    reply,
    handler: (next: typeof handler) => {
      handler = next;
    },
  };
}

test('automatic arrival coalesces active and background documents, ignores harmless fragments and checks a new document', async (t) => {
  const f = world(t);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.handler(async (q) => {
    await hold;
    return f.reply(q, 'no_match');
  });
  await Promise.all([f.emit(1), f.emit(2)]);
  await until(() => f.requests.length === 1);
  release();
  await until(() =>
    [1, 2].every((id) => f.store.get(id).protection?.threat?.status === 'no_match'),
  );
  assert.deepEqual(f.requests, [{ url: origin + '/support/', scope: 'page', purpose: 'arrival' }]);
  const tab = f.tabs.get(1)!;
  tab.url += '#Overview';
  await f.emit();
  await f.worker.activated(1);
  assert.equal(f.requests.length, 1);
  tab.url = origin + '/vlc/features.html';
  await f.emit();
  await until(() => f.requests.length === 2);
  tab.doc = 'reloaded';
  await f.emit();
  await until(() => f.requests.length === 3);
});

test('automatic target decisions hold a positive, refuse missing coverage or permission, and never replace the current page result', async (t) => {
  const f = world(t);
  await f.emit();
  await until(() => f.shown()?.threat?.status === 'no_match');
  f.handler(async (q) => f.reply(q, 'match'));
  const target = second + '/discover';
  for (const kind of ['navigation', 'offer', 'download'] as const) {
    assert.equal((await f.target(target, kind)).allow, false);
    assert.equal(f.shown()?.destination?.result?.purpose, 'target');
    assert.equal(f.shown()?.threat?.url, origin + '/support/');
  }
  assert.equal(f.requests.filter((x) => x.purpose === 'target').length, 1);
  assert.equal((await f.target(second + '/account?token=private')).allow, false);
  f.grants.delete(second + '/*');
  assert.equal((await f.target(target)).allow, false);
  assert.equal(f.requests.length, 2);
  f.grants.add(second + '/*');
  f.handler(async (q) => f.reply(q, 'unavailable'));
  assert.equal((await f.target(second + '/docs/guide')).allow, false);
  f.handler(async (q) => f.reply(q, 'no_match'));
  const cleared = await f.target(second + '/docs/guide');
  assert.equal(cleared.allow, true, cleared.reason);
  assert.equal((await f.target(second + '/miscellaneous')).allow, false);
});

test('revocation or a replaced document ends a pending target, with no late display or automatic dispatch', async (t) => {
  const f = world(t);
  await f.emit();
  await until(() => f.shown()?.threat?.status === 'no_match');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.handler(async (q) => {
    await hold;
    return f.reply(q, 'no_match');
  });
  const pending = f.target(second + '/discover');
  await until(() => f.requests.length === 2);
  const tab = f.tabs.get(1)!;
  tab.doc = 'another';
  tab.url = origin + '/account';
  await f.emit();
  release();
  assert.equal((await pending).allow, false);
  assert.equal(f.shown()?.destination, undefined);
  assert.equal(f.requests.length, 2);
  tab.incognito = true;
  await f.emit();
  assert.equal(f.requests.length, 2);
});

test('a limited continuation is single-use and cannot override a later positive', async (t) => {
  const f = world(t);
  await f.emit();
  await until(() => f.shown()?.threat?.status === 'no_match');
  const url = second + '/docs/guide';
  f.handler(async (q) => f.reply(q, 'unavailable'));
  assert.equal((await f.target(url)).allow, false);
  async function accept() {
    const receipt = f.shown()!;
    assert.ok(receipt.destination?.limitedTicket);
    await f.worker.operate(f.tabs.get(1) as chrome.tabs.Tab, {
      op: 'allowLimitedTarget',
      revision: receipt.revision,
      ticket: receipt.destination.limitedTicket,
    });
  }
  await accept();
  assert.equal((await f.target(url)).allow, true);
  assert.equal((await f.target(url)).allow, false);
  await accept();
  f.handler(async (q) => f.reply(q, 'match'));
  assert.equal((await f.target(url)).allow, false);
  assert.equal(f.shown()?.destination?.limitedTicket, undefined);
});

test('a still-valid homepage match survives a new document with an exact-page miss and does not refetch the homepage', async (t) => {
  const f = world(t),
    tab = f.tabs.get(1)!;
  tab.url = origin + '/miscellaneous';
  f.handler(async (q) => f.reply(q, q.scope === 'root' ? 'match' : 'no_match'));
  await f.emit();
  await until(() => f.shown()?.threat?.status === 'match');
  tab.url = origin + '/support/';
  tab.doc = 'new-doc';
  await f.emit();
  await until(() => f.shown()?.threat?.status === 'no_match');
  assert.deepEqual(
    f.shown()?.threatWarnings?.map((x) => x.url),
    [origin + '/'],
  );
  assert.equal(f.requests.filter((x) => x.url === origin + '/').length, 1);
});

test('legacy opt-in stays root-only and actual grants govern both automatic modes',async t=>{
  const f=world(t);
  const p=f.store.prefs.protection!;
  delete p.automaticUrlConsent;p.threatRoot=true;
  await f.emit();await until(()=>f.requests.length===1);
  assert.deepEqual(f.requests[0],{url:origin+'/',scope:'root'});
  p.scope='off';await f.worker.reset();await f.emit();assert.equal(f.requests.length,1);
  p.scope='selected';p.automaticUrlConsent=2;
  f.grants.delete(origin+'/*');await f.emit();assert.equal(f.requests.length,1);
  f.grants.add(origin+'/*');f.tabs.get(1)!.incognito=true;
  await f.emit();assert.equal(f.requests.length,1);
  f.tabs.get(1)!.incognito=false;p.scope='all';
  await f.emit();assert.equal(f.requests.length,1);
  f.grants.add('http://*/*');f.grants.add('https://*/*');
  await f.emit();await until(()=>f.requests.length===2);
  assert.equal(f.requests[1]?.url,origin+'/support/');
  await f.worker.revoked([origin+'/*']);f.grants.delete(origin+'/*');
  await f.emit();assert.equal(f.requests.length,2);
});
