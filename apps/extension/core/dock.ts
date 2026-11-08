import {
  DockControl,
  Fault,
  permittedOrigin,
  safeChatText,
  type DockAction,
  type DockDisplay,
  type PanelRequest,
} from '@safestep/contracts';
import { protectionRouteToken } from '../page/protection-route';
import { access, bridgeFile, removedOrigin } from './access';
import { live, type RecordState } from './state';
import type { Store } from './store';

type Command = PanelRequest['command'];
type Show = Extract<DockDisplay, { op: 'show' }>;
type Spot = { id: number; window: number; doc: string; route: string; origin: string };
type Entry = Spot & {
  cap: string;
  signature: string;
  actions: DockAction[];
  spent?: boolean;
  pendingControl?: 'validating' | 'panel_opened';
  opening?: boolean;
};
type Wanted = { window: number; task: string | null; version: number };
export function dockControls(s: RecordState, doc: string) {
  const task = s.cp.task,
    actions: DockAction[] = ['open'];
  const owner = task && (!task.documentId || task.documentId === doc);
  const auto = !!owner && !!task?.adaptive?.authorized && live(task);
  // Only project a public goal onto its own active document, never the chat history.
  const goal =
    owner && task.documentId === doc && live(task) && task.goal && safeChatText(task.goal)
      ? task.goal.trim()
      : undefined;
  if (
    owner &&
    task?.state === 'showing_step' &&
    !auto &&
    (task.adaptive || s.cue || s.snapshot?.guide?.ref)
  )
    actions.push('show');
  else if (s.review?.selected && !s.reviewStale && s.review.binding.documentId === doc)
    actions.push('show');
  if (owner && live(task)) {
    if (task!.state !== 'paused') actions.push('pause');
    actions.push('stop');
    if (auto) actions.push('takeover');
  }
  if (
    (s.cleanup?.binding.documentId === doc && (s.cleanup.enabled || s.cleanup.hidden > 0)) ||
    (s.cue && s.snapshot?.context.documentId === doc) ||
    (s.review?.selected && s.review.binding.documentId === doc)
  )
    actions.push('restore');
  const signature = JSON.stringify([
    s.cp.epoch,
    task?.id,
    task?.revision,
    task?.adaptive?.version,
    task?.state,
    task?.steps,
    auto,
    s.snapshot?.context.revision,
    s.cue?.ref,
    s.cleanup?.binding.operationId,
    s.cleanup?.binding.revision,
    s.review?.binding.operationId,
    s.review?.selected,
    goal,
    actions,
  ]);
  const state: Show['state'] = auto
    ? 'automatic'
    : owner && task?.state === 'paused'
      ? 'paused'
      : owner && live(task)
        ? 'guide'
        : 'idle';
  return { actions, signature, state, goal };
}
export class CompactDock {
  private entries = new Map<number, Entry>();
  private wanted = new Map<number, Wanted>();
  private refreshes = new Map<number, Promise<void>>();
  private dirty = new Set<number>();
  constructor(
    private store: Store,
    private execute: (s: RecordState, t: chrome.tabs.Tab, c: Command) => Promise<unknown>,
    private pause: (s: RecordState, why: string) => Promise<unknown>,
  ) {}
  private async spot(s: RecordState, t: chrome.tabs.Tab): Promise<Spot> {
    if (
      t.id === undefined ||
      !t.active ||
      t.incognito ||
      !(await chrome.windows.get(t.windowId)).focused
    )
      throw new Fault('stale_document');
    const a = await access(s, this.store.prefs, t);
    const rows = await chrome.scripting.executeScript({
      target: { tabId: t.id, frameIds: [0] },
      func: protectionRouteToken,
    });
    const top = rows.find((x) => x.frameId === 0);
    if (!top?.documentId || !top.result || permittedOrigin(t.url) !== a.site)
      throw new Fault('stale_document');
    return { id: t.id, window: t.windowId, doc: top.documentId, route: top.result, origin: a.site };
  }
  private same(a: Spot, b: Spot) {
    return (
      a.id === b.id &&
      a.window === b.window &&
      a.doc === b.doc &&
      a.route === b.route &&
      a.origin === b.origin
    );
  }
  private async tell(e: Spot, body: DockDisplay) {
    const reply = await chrome.tabs
      .sendMessage(e.id, body, { documentId: e.doc })
      .catch(() => null);
    return reply?.ok === true;
  }
  private remove(id: number, forget = true) {
    if (forget) this.wanted.delete(id);
    const old = this.entries.get(id);
    if (!old) return;
    this.entries.delete(id);
    void this.tell(old, { channel: 'dock-display', op: 'clear', cap: old.cap });
  }
  private closePresentation(id: number) {
    const e = this.entries.get(id);
    if (e?.pendingControl) {
      // A presentation change cannot withdraw an already requested
      // intervention or Restore. Lifecycle invalidation remains immediate.
      e.pendingControl = 'panel_opened';
    } else this.remove(id);
  }
  private async unsafe(s: RecordState, message: string) {
    if (s.cp.task?.adaptive?.authorized) await this.pause(s, message);
  }
  private async display(s: RecordState, t: chrome.tabs.Tab, w: Wanted, initial = false) {
    const site = await this.spot(s, t);
    if (
      this.wanted.get(site.id) !== w ||
      w.window !== site.window ||
      w.task !== (s.cp.task?.id ?? null)
    )
      return false;
    const model = dockControls(s, site.doc),
      old = this.entries.get(site.id);
    if (!initial && old && !old.spent && this.same(old, site) && old.signature === model.signature)
      return true;
    const cap = crypto.randomUUID(),
      next: Entry = { ...site, cap, signature: model.signature, actions: model.actions };
    await chrome.scripting.executeScript({
      target: { tabId: site.id, documentIds: [site.doc] },
      files: [bridgeFile],
    });
    if (this.wanted.get(site.id) !== w || w.task !== (s.cp.task?.id ?? null)) return false;
    this.entries.set(site.id, next);
    const ok = await this.tell(site, {
      channel: 'dock-display',
      op: 'show',
      documentId: site.doc,
      cap,
      route: site.route,
      state: model.state,
      actions: model.actions,
      goal: model.goal,
    });
    const current = await chrome.tabs.get(site.id);
    if (
      !ok ||
      this.entries.get(site.id) !== next ||
      this.wanted.get(site.id) !== w ||
      !this.same(await this.spot(s, current), next) ||
      dockControls(s, next.doc).signature !== model.signature
    ) {
      if (this.entries.get(site.id) === next) this.remove(site.id, false);
      if (old) void this.tell(old, { channel: 'dock-display', op: 'clear', cap: old.cap });
      return false;
    }
    return true;
  }
  async tuck(s: RecordState, t: chrome.tabs.Tab, expectedTask: string | null) {
    if (t.id === undefined || expectedTask !== (s.cp.task?.id ?? null))
      throw new Fault('stale_document');
    const w = { window: t.windowId, task: expectedTask, version: 1 };
    this.remove(t.id);
    this.wanted.set(t.id, w);
    try {
      if (!(await this.display(s, t, w, true))) throw new Fault('dock_unavailable');
      // A native panel must not close before an actual current document has
      // acknowledged that it can expose the direct controls for this task.
      await chrome.sidePanel.close({ windowId: t.windowId });
    } catch (e) {
      this.remove(t.id);
      await this.unsafe(
        s,
        'The compact controls could not be shown. Navigation is paused; keep using this panel.',
      );
      throw e instanceof Fault ? e : new Fault('blocked_by_policy');
    }
  }
  opened(windowId: number, tabId?: number) {
    for (const [id, w] of this.wanted)
      if (w.window === windowId && (tabId === undefined || tabId === id))
        this.closePresentation(id);
  }
  drop(id: number) {
    this.remove(id);
  }
  revoked(patterns: string[]) {
    for (const [id, e] of this.entries) {
      if (removedOrigin(e.origin, patterns)) {
        this.remove(id);
        const s = this.store.tabs.get(id);
        if (s)
          void this.unsafe(s, 'Page access was removed. Automatic navigation is paused.').catch(
            () => {},
          );
      }
    }
  }
  changed(id: number) {
    const w = this.wanted.get(id);
    if (!w) return;
    const entry = this.entries.get(id);
    if (entry?.pendingControl || entry?.opening) return;
    if (this.refreshes.has(id)) {
      this.dirty.add(id);
      return;
    }
    const version = w.version;
    const p = Promise.resolve()
      .then(async () => {
        const s = this.store.tabs.get(id);
        if (!s || w.task !== (s.cp.task?.id ?? null)) {
          this.remove(id);
          return;
        }
        const t = await chrome.tabs.get(id);
        if (t.status === 'loading' || !t.active) return;
        if (
          !(await this.display(s, t, w)) &&
          this.wanted.get(id) === w &&
          w.version === version &&
          !this.dirty.has(id)
        ) {
          this.remove(id);
          await this.unsafe(
            s,
            'The compact controls are unavailable. Navigation is paused. Reopen SafeStep from the toolbar.',
          );
        }
      })
      .catch(async () => {
        if (this.wanted.get(id) === w && w.version === version) {
          this.remove(id);
          const s = this.store.tabs.get(id);
          if (s) await this.unsafe(s, 'Page access changed. Automatic navigation is paused.');
        }
      });
    this.refreshes.set(id, p);
    void p.finally(() => {
      this.refreshes.delete(id);
      const dirty = this.dirty.delete(id);
      if (this.wanted.get(id) === w && (dirty || w.version !== version)) this.changed(id);
    });
  }
  activated(tabId: number, windowId: number) {
    for (const [id, w] of this.wanted) if (w.window === windowId && id !== tabId) this.remove(id);
  }
  navigation(id: number, ch: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) {
    const w = this.wanted.get(id);
    if (!w) return;
    if (ch.status === 'loading' || ch.url) {
      w.version++;
      this.remove(id, false);
      const s = this.store.tabs.get(id);
      if (s)
        void this.unsafe(
          s,
          'The page changed while tucked. Automatic navigation is paused for a fresh inspection.',
        ).catch(() => {});
    }
    if (ch.status === 'complete' || (ch.url && t.status !== 'loading')) this.changed(id);
  }
  private senderOK(sender: chrome.runtime.MessageSender) {
    return (
      sender.id === chrome.runtime.id &&
      sender.frameId === 0 &&
      !!sender.documentId &&
      sender.tab?.id !== undefined &&
      sender.tab.active &&
      !sender.tab.incognito &&
      !!permittedOrigin(sender.url) &&
      permittedOrigin(sender.url) === permittedOrigin(sender.tab.url)
    );
  }
  receive(
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    ready: Promise<unknown>,
  ): Promise<boolean> {
    const msg = DockControl.safeParse(raw);
    if (!msg.success || !this.senderOK(sender)) return Promise.resolve(false);
    const id = sender.tab!.id!,
      e = this.entries.get(id),
      m = msg.data;
    const bound =
      !!e &&
      e.doc === sender.documentId &&
      e.window === sender.tab!.windowId &&
      e.origin === permittedOrigin(sender.url) &&
      e.cap === m.cap &&
      e.route === m.route;
    if (m.action === 'open') {
      // This presentation-only fallback lets the user reopen after an idle
      // worker restarted. No task or page action is ever run on a cold token.
      if (e && (!bound || e.opening)) return Promise.resolve(false);
      if (e) e.opening = true;
      const failed = () => {
        if (e && this.entries.get(id) === e) {
          delete e.opening;
          this.changed(id);
        }
        return false;
      };
      try {
        return chrome.sidePanel.open({ windowId: sender.tab!.windowId }).then(() => {
          if (this.entries.get(id) === e) this.closePresentation(id);
          return true;
        }, failed);
      } catch {
        return Promise.resolve(failed());
      }
    }
    if (!e || !bound) return Promise.resolve(false);
    const protectedControl =
      m.action === 'pause' ||
      m.action === 'stop' ||
      m.action === 'takeover' ||
      m.action === 'restore';
    if (m.action !== 'lost' && (e.spent || e.opening || e.pendingControl))
      return Promise.resolve(false);
    if (protectedControl) {
      if (!e.actions.includes(m.action as DockAction)) return Promise.resolve(false);
      e.pendingControl = 'validating';
    }
    return ready
      .then(async () => {
        const s = this.store.tabs.get(id);
        if (!s || this.entries.get(id) !== e) return false;
        if (m.action === 'lost') {
          this.remove(id);
          await this.unsafe(
            s,
            'Compact controls disappeared. Navigation is paused. Reopen SafeStep using the toolbar.',
          );
          return true;
        }
        const t = await chrome.tabs.get(id);
        if (!this.same(await this.spot(s, t), e) || this.entries.get(id) !== e) return false;
        const model = dockControls(s, e.doc);
        if (
          e.spent ||
          (!protectedControl && (e.opening || e.pendingControl)) ||
          model.signature !== e.signature ||
          !model.actions.includes(m.action)
        )
          return false;
        let command: Command;
        const task = s.cp.task;
        switch (m.action) {
          case 'pause':
          case 'stop':
          case 'takeover':
            if (task?.adaptive) command = { kind: 'assistControl', action: m.action };
            else if (m.action !== 'takeover')
              command = { kind: m.action === 'stop' ? 'cancel' : 'pause' };
            else return false;
            break;
          case 'restore':
            command = { kind: 'restore' };
            break;
          case 'show':
            if (task?.adaptive && task.state === 'showing_step')
              command = { kind: 'assistControl', action: 'reveal' };
            else if (s.review?.selected && s.review.binding.documentId === e.doc)
              command = { kind: 'reviewReveal', operationId: s.review.binding.operationId };
            else {
              const ref = s.cue?.ref ?? s.snapshot?.guide?.ref;
              if (!ref || s.snapshot?.context.documentId !== e.doc) return false;
              command = { kind: 'reveal', ref };
            }
            break;
          default:
            return false;
        }
        e.spent = true;
        try {
          await this.execute(s, t, command);
        } finally {
          if (!protectedControl) this.changed(id);
        }
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (!protectedControl || this.entries.get(id) !== e) return;
        const opened = e.pendingControl === 'panel_opened';
        delete e.pendingControl;
        if (opened) this.remove(id);
        else this.changed(id);
      });
  }
}
