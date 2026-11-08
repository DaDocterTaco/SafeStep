import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompactDock, dockControls } from '../apps/extension/core/dock';
import { blank } from '../apps/extension/core/state';
import { Store } from '../apps/extension/core/store';
import type { DockDisplay, TaskSession } from '@safestep/contracts';

const doc = 'a'.repeat(32),
  route = 'b'.repeat(32),
  site = 'https://public.org',
  extension = 'a'.repeat(32);
function world() {
  const s = blank(4);
  s.cp.invokedOrigin = site;
  s.cp.task = {
    id: crypto.randomUUID(),
    state: 'showing_step',
    revision: crypto.randomUUID(),
    documentId: doc,
    steps: 0,
    adaptive: { version: 1, authorized: true },
  } as TaskSession;
  const store = new Store();
  store.tabs.set(4, s);
  const tab = {
    id: 4,
    windowId: 9,
    active: true,
    url: site + '/docs/help',
    incognito: false,
    status: 'complete',
  } as chrome.tabs.Tab;
  const shown: DockDisplay[] = [],
    closed: number[] = [],
    opened: number[] = [],
    executed: string[] = [],
    paused: string[] = [];
  const control: {
    doc: string;
    route: string;
    ack: boolean;
    holdSpot?: () => Promise<void>;
    holdOpen?: () => Promise<void>;
  } = { doc, route, ack: true };
  const api = {
    runtime: { id: extension },
    tabs: {
      get: async () => tab,
      sendMessage: async (_id: number, m: DockDisplay) => {
        shown.push(m);
        return { ok: control.ack };
      },
    },
    windows: { get: async () => ({ focused: true }) },
    scripting: {
      executeScript: async (options: { files?: string[] }) => {
        if (options.files) return [];
        await control.holdSpot?.();
        return [{ frameId: 0, documentId: control.doc, result: control.route }];
      },
    },
    sidePanel: {
      close: async ({ windowId }: { windowId: number }) => {
        closed.push(windowId);
      },
      open: async ({ windowId }: { windowId: number }) => {
        opened.push(windowId);
        await control.holdOpen?.();
      },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { value: api, configurable: true, writable: true });
  const manager = () =>
    new CompactDock(
      store,
      async (_s, _t, c) => {
        executed.push(c.kind === 'assistControl' ? c.action : c.kind);
      },
      async (_s, reason) => {
        paused.push(reason);
      },
    );
  const dock = manager(),
    sender = {
      id: extension,
      frameId: 0,
      documentId: doc,
      tab,
      url: tab.url,
    } as chrome.runtime.MessageSender;
  const sent = () => {
    const last = shown.findLast((m) => m.op === 'show');
    assert(last?.op === 'show');
    return last;
  };
  const request = (action: string) => ({
    channel: 'dock-control',
    cap: sent().cap,
    route: sent().route,
    action,
  });
  return {
    s,
    tab,
    shown,
    closed,
    opened,
    executed,
    paused,
    control,
    manager,
    dock,
    sender,
    sent,
    request,
  };
}
test('Tuck waits for the current document to acknowledge a usable dock, and refuses an unavailable layout', async () => {
  const w = world();
  w.control.ack = false;
  await assert.rejects(w.dock.tuck(w.s, w.tab, w.s.cp.task!.id), /compact controls/);
  assert.deepEqual(w.closed, []);
  assert.equal(w.paused.length, 1);
  w.control.ack = true;
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  assert.deepEqual(w.closed, [9]);
  assert.deepEqual(w.sent().actions, ['open', 'pause', 'stop', 'takeover']);
  assert(!w.sent().actions.includes('show'));
  assert(!JSON.stringify(w.sent()).includes('public.org'));
});
test('Page controls cannot execute across a changed route, document, task revision, capability or page sender', async () => {
  const w = world();
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  const req = w.request('stop');
  const ready = Promise.resolve();
  assert(!(await w.dock.receive({ ...req, action: 'automatic' }, w.sender, ready)));
  assert(!(await w.dock.receive({ ...req, cap: crypto.randomUUID() }, w.sender, ready)));
  assert(!(await w.dock.receive(req, { ...w.sender, frameId: 1 }, ready)));
  assert(!(await w.dock.receive(req, { ...w.sender, documentId: 'f'.repeat(32) }, ready)));
  w.control.route = 'c'.repeat(32);
  assert(!(await w.dock.receive(req, w.sender, ready)));
  w.control.route = route;
  w.s.cp.task!.revision = crypto.randomUUID();
  assert(!(await w.dock.receive(req, w.sender, ready)));
  assert.deepEqual(w.executed, []);
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  assert(await w.dock.receive(w.request('takeover'), w.sender, ready));
  assert.deepEqual(w.executed, ['takeover']);
});
test('the tucked goal belongs to the current document and omits private text', async () => {
  const w = world();
  const task = w.s.cp.task!;
  task.goal = 'Find the return deadline without opening checkout';
  await w.dock.tuck(w.s, w.tab, task.id);
  assert.equal(w.sent().goal, task.goal);
  assert.equal(dockControls(w.s, 'f'.repeat(32)).goal, undefined);
  task.goal = 'Find my receipt for someone@example.org';
  assert.equal(dockControls(w.s, doc).goal, undefined);
  task.goal = 'Find the return deadline';
  task.state = 'completed';
  assert.equal(dockControls(w.s, doc).goal, undefined);
});
test('A restarted worker accepts presentation-only Open immediately but refuses an old local action', async () => {
  const w = world();
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  const fresh = w.manager();
  assert(!(await fresh.receive(w.request('restore'), w.sender, Promise.resolve())));
  const never = new Promise<never>(() => {});
  const opening = fresh.receive(w.request('open'), w.sender, never);
  assert.deepEqual(w.opened, [9]);
  assert(await opening);
  assert.deepEqual(w.executed, []);
});
test('two overlapping gestures on one dock surface cannot dispatch the same local control twice', async () => {
  const w = world();
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  const same = w.request('pause');
  const results = await Promise.all([
    w.dock.receive(same, w.sender, Promise.resolve()),
    w.dock.receive(same, w.sender, Promise.resolve()),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(w.executed, ['pause']);
});
test('an earlier intervention or Restore survives same-capability Open during live document validation', async () => {
  for (const [action, change] of [
    ['stop', 'unchanged'],
    ['pause', 'unchanged'],
    ['takeover', 'unchanged'],
    ['restore', 'unchanged'],
    ['stop', 'document'],
    ['stop', 'revocation'],
    ['stop', 'navigation'],
    ['stop', 'task'],
  ]) {
    const w = world();
    if (action === 'restore')
      w.s.cleanup = { binding: { documentId: doc }, enabled: true, hidden: 1 } as NonNullable<
        typeof w.s.cleanup
      >;
    await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
    let enter!: () => void, release!: () => void;
    const checking = new Promise<void>((ok) => {
        enter = ok;
      }),
      held = new Promise<void>((ok) => {
        release = ok;
      });
    w.control.holdSpot = async () => {
      enter();
      await held;
    };
    const request = w.request(action!),
      open = w.request('open');
    const stop = w.dock.receive(request, w.sender, Promise.resolve());
    await checking;
    const viewing = w.dock.receive(open, w.sender, Promise.resolve());
    w.dock.opened(w.tab.windowId, w.tab.id);
    assert.deepEqual(w.opened, [9], 'presentation opens immediately');
    assert(await viewing);
    assert.deepEqual(w.executed, [], 'action must wait for exact document verification');
    const duplicate = w.dock.receive(request, w.sender, Promise.resolve());
    if (change === 'document') w.control.doc = 'f'.repeat(32);
    if (change === 'revocation') w.dock.revoked([site + '/*']);
    if (change === 'navigation') w.dock.navigation(4, { status: 'loading' }, w.tab);
    if (change === 'task') w.s.cp.task!.revision = crypto.randomUUID();
    release();
    assert.equal(
      await stop,
      change === 'unchanged',
      'only a previously requested, still-bound intervention executes',
    );
    assert.equal(await duplicate, false, 'never replay a consumed command');
    assert.deepEqual(w.executed, change === 'unchanged' ? [action] : []);
  }
});
test('Open first closes the capability to subsequent page actions', async () => {
  const w = world();
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  let release!: () => void;
  w.control.holdOpen = () =>
    new Promise<void>((ok) => {
      release = ok;
    });
  const open = w.dock.receive(w.request('open'), w.sender, Promise.resolve());
  assert(!(await w.dock.receive(w.request('stop'), w.sender, Promise.resolve())));
  release();
  assert(await open);
  assert.deepEqual(w.executed, []);
});
test('a Stop can supersede an unvalidated Show step on its current document', async () => {
  const w = world();
  w.s.cp.task!.adaptive!.authorized = false;
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  let enter!: () => void, release!: () => void;
  const checking = new Promise<void>((ok) => {
    enter = ok;
  });
  w.control.holdSpot = () =>
    new Promise<void>((ok) => {
      release = ok;
      enter();
    });
  const show = w.dock.receive(w.request('show'), w.sender, Promise.resolve());
  await checking;
  delete w.control.holdSpot;
  assert(await w.dock.receive(w.request('stop'), w.sender, Promise.resolve()));
  release();
  assert(!(await show));
  assert.deepEqual(w.executed, ['stop']);
});
test('A vanishing dock pauses only its bound automatic operation, and new page bindings do not inherit the old control', async () => {
  const w = world();
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  assert(await w.dock.receive(w.request('lost'), w.sender, Promise.resolve()));
  assert.equal(w.paused.length, 1);
  assert.deepEqual(w.executed, []);
  await w.dock.tuck(w.s, w.tab, w.s.cp.task!.id);
  const shown = w.request('stop');
  w.dock.navigation(4, { status: 'loading' }, w.tab);
  assert(!(await w.dock.receive(shown, w.sender, Promise.resolve())));
  assert.equal(w.paused.length, 2);
  const different = dockControls(w.s, 'f'.repeat(32));
  assert.deepEqual(different.actions, ['open']);
});
