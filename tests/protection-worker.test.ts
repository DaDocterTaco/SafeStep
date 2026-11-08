import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Protection } from '../apps/extension/core/protection';
import { Store } from '../apps/extension/core/store';
import {
  merchantDataset,
  merchantProvider,
  merchantRecordUrl,
  type MerchantReply,
} from '@safestep/contracts';

test('Protection binds late complaints to the granted document, shares one source job, retains quota across worker wake and pauses automatic work', async (t) => {
  const sessions: Record<string, unknown> = { 'local-ai-session': 'ss3_' + 'a'.repeat(43) };
  const url = (host: string) => 'https://' + host + '/public';
  const tabs = new Map([
    [1, { id: 1, url: url('www.wayfair.com'), doc: 'doc1', incognito: false }],
    [2, { id: 2, url: url('www.wayfair.com'), doc: 'doc2', incognito: false }],
    [3, { id: 3, url: url('example.org'), doc: 'doc3', incognito: false }],
  ]);
  const grants = new Set([...tabs.values()].map((x) => new URL(x.url).origin));
  const painted: Array<{ id: number; msg: any }> = [];
  const noop = async () => {};
  const chromeMock = {
    runtime: { id: 'protected-extension', sendMessage: noop },
    action: { setBadgeText: noop, setTitle: noop, setBadgeBackgroundColor: noop },
    tabs: {
      get: async (id: number) => ({ ...tabs.get(id) }),
      sendMessage: async (id: number, msg: any) => {
        painted.push({ id, msg });
      },
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) =>
        origins.every((x) => grants.has(x.replace(/\/\*$/, ''))),
    },
    storage: {
      session: {
        get: async (keys: string | string[] | null) =>
          Object.fromEntries(
            Object.entries(sessions).filter(
              ([k]) => keys === null || (typeof keys === 'string' ? k === keys : keys.includes(k)),
            ),
          ),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(sessions, obj);
        },
        remove: async (key: string) => {
          delete sessions[key];
        },
      },
    },
    scripting: {
      executeScript: async (input: any) => {
        const t = tabs.get(input.target.tabId)!;
        return [
          {
            frameId: 0,
            documentId: t.doc,
            result: input.target.documentIds
              ? String(t.id).padStart(32, '0')
              : new URL(t.url).origin,
          },
        ];
      },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chromeMock });
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'chrome');
  });
  const now = Date.now(),
    date = (n: number) => new Date(now - n * 86400000).toISOString().slice(0, 10);
  const reply: MerchantReply = {
    domain: 'www.wayfair.com',
    status: 'reports',
    severity: 'caution',
    provider: merchantProvider,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
    summary: 'Two dated synthetic reports.',
    limitations: ['Test transport.'],
    source: merchantDataset,
    businessId: '123',
    windowStart: date(365),
    rowsInspected: 2,
    distinctComplaints: 2,
    records: ['1', '2'].map((id, i) => ({
      id,
      date: date(i + 1),
      practices: ['Failure To Deliver/Perform'],
      caseStatus: 'Open',
      url: merchantRecordUrl('123', id),
    })),
  };
  let release!: () => void,
    authenticate = true;
  const hold = new Promise<void>((r) => (release = r));
  const external: string[] = [];
  t.mock.method(globalThis, 'fetch', async (raw: RequestInfo | URL, opts: RequestInit) => {
    assert.equal(opts.credentials, 'omit');
    if (String(raw).endsWith('/connect'))
      return Response.json(
        {
          provider: 'Gemini',
          model: null,
          credentialPresent: false,
          state: 'not_configured',
          connected: authenticate,
        },
        { status: authenticate ? 200 : 403 },
      );
    const body = JSON.parse(String(opts.body));
    assert.deepEqual(Object.keys(body), ['domain']);
    external.push(body.domain);
    await hold;
    return Response.json({ ...reply, domain: body.domain });
  });
  const store = new Store(),
    paused: number[] = [];
  store.prefs.protection = { scope: 'selected', sites: [...grants], outside: true, budget: 1 };
  const first = new Protection(store, async (s) => {
    paused.push(s.cp.tabId);
    s.cp.task!.adaptive!.authorized = false;
  });
  const send = (p: Protection, id: number, op = 'arrive', rev?: string) =>
    p.page(
      { op, revision: rev },
      {
        id: chromeMock.runtime.id,
        frameId: 0,
        documentId: tabs.get(id)!.doc,
        tab: { id } as chrome.tabs.Tab,
      },
    );
  const status = (id: number) => store.tabs.get(id)?.protection;
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 250; i++) {
      if (f()) return;
      await delay(2);
    }
    assert(f());
  };
  await send(first, 1);
  await until(() => external.length === 1);
  await send(first, 2);
  assert.deepEqual(external, ['www.wayfair.com']);
  store.get(2).cp.task = { adaptive: { authorized: true } } as any;
  const moved = tabs.get(1)!;
  moved.url = 'https://www.wayfair.com/account/?token=private-decoy';
  await first.navigation(1, { url: moved.url }, moved as chrome.tabs.Tab);
  await send(first, 1);
  assert.equal(status(1)?.status, 'private');
  release();
  await until(() => status(2)?.status === 'reports');
  assert.deepEqual(paused, [2]);
  assert.equal(status(1)?.status, 'private');
  assert(!painted.some((x) => x.id === 1 && x.msg.view?.status === 'reports'));
  const originalRevision=status(2)!.revision, sibling=tabs.get(2)!;
  sibling.url='https://www.wayfair.com/terms#History';
  await first.navigation(2,{url:sibling.url,status:'loading'},sibling as chrome.tabs.Tab);
  assert.equal(status(2)?.revision,originalRevision);
  assert.equal(status(2)?.status,'reports');
  assert.equal(external.length,1);
  await send(first, 2, 'dismiss', status(2)!.revision);
  assert(status(2)?.dismissed);
  await send(first, 2);
  assert(status(2)?.dismissed);
  await send(first, 3);
  await until(() => status(3)?.status === 'quota');
  assert.equal(external.length, 1);
  authenticate = false;
  const t2 = tabs.get(2)!;
  t2.doc = 'doc2b';
  await first.navigation(2, { status: 'loading' }, t2 as chrome.tabs.Tab);
  await send(first, 2);
  await until(() => status(2)?.status === 'unavailable');
  assert(status(2)?.outside.includes('Pairing'));
  assert(!status(2)?.caution);
  const recovered = new Protection(store, noop);
  await recovered.restore();
  assert.equal(external.length, 1);
  await send(recovered, 3);
  await until(() => status(3)?.status === 'quota');
  assert.equal(external.length, 1);
  grants.delete('https://example.org');
  await recovered.revoked(['https://example.org/*']);
  assert.equal(status(3), undefined);
  const privateTab = tabs.get(1)!;
  privateTab.incognito = true;
  await send(recovered, 1);
  assert.equal(external.length, 1);
  sessions['local-ai-session'] = 'ss3_' + 'b'.repeat(43);
  const amazon = { id: 4, url: 'https://www.amazon.com/', doc: 'doc4', incognito: false };
  tabs.set(4, amazon);
  grants.add(new URL(amazon.url).origin);
  store.prefs.protection.sites.push(new URL(amazon.url).origin);
  await send(recovered, 4);
  await until(() => status(4)?.status === 'reports');
  assert.equal(status(4)?.identity, 'amazon_us');
  assert.equal(status(4)?.caution, true);
});
