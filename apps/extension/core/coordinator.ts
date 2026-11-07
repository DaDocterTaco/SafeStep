import {
  Changed,
  Fault,
  matchReply,
  parseWire,
  permittedOrigin,
  type BridgeRequest,
  type ErrorCode,
  type PanelRequest,
  type PanelView,
  type TaskSession,
  type WorkflowId,
} from '@safestep/contracts';
import { expectedNavigation, workflows } from '../sites/profiles';
import { access, bridgeFile, pattern, probe, removedOrigin } from './access';
import { advance, canHighlight, checkRequest, guard, live, type RecordState } from './state';
import { Store } from './store';

const fault = (e: unknown): ErrorCode => (e instanceof Fault ? e.code : 'blocked_by_policy');
async function deadline<T>(p: Promise<T>, ms = 4500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Fault('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class Coordinator {
  readonly store = new Store();
  readonly ready = this.initialize();
  private async initialize() {
    await this.store.load();
    const sites = this.store.prefs.sites;
    this.store.prefs.sites = (
      await Promise.all(
        sites.map(async (s) =>
          (await chrome.permissions.contains({ origins: [pattern(s)] })) ? s : null,
        ),
      )
    ).filter((s) => s !== null);
    await this.store.configure();
    await Promise.all(
      [...this.store.tabs.values()].map(async (s) => {
        let t: chrome.tabs.Tab;
        try {
          t = await chrome.tabs.get(s.cp.tabId);
        } catch {
          await this.store.drop(s.cp.tabId);
          return;
        }
        s.windowId = t.windowId;
        if (s.cp.task?.documentId && s.cp.knownOrigin)
          s.binding = { documentId: s.cp.task.documentId, origin: s.cp.knownOrigin };
        if (
          s.cp.knownOrigin &&
          sites.includes(s.cp.knownOrigin) &&
          !this.store.prefs.sites.includes(s.cp.knownOrigin)
        ) {
          s.cp.invokedOrigin = null;
          await this.stop(s, 'paused', 'permission_revoked');
          return;
        }
        if (!live(s.cp.task)) return;
        // Stored handles are never restored. A fresh snapshot clears any surviving outline.
        await this.inspect(s, t, s.cp.task!.goal, s.cp.task!.mode, 'recover');
      }),
    );
  }
  private async tabFor(r: PanelRequest) {
    const t = await chrome.tabs.get(r.tabId).catch(() => {
      throw new Fault('stale_document');
    });
    if (!t.active || t.windowId !== r.windowId) throw new Fault('stale_document');
    return t;
  }
  private async send(
    s: RecordState,
    b: { documentId: string; origin: string },
    n: number,
    command: BridgeRequest['command'],
  ) {
    const req: BridgeRequest = {
      v: 2,
      channel: 'bridge',
      requestId: crypto.randomUUID(),
      tabId: s.cp.tabId,
      epoch: n,
      ...b,
      command,
    };
    let raw: unknown;
    try {
      raw = await deadline(chrome.tabs.sendMessage(s.cp.tabId, req, { documentId: b.documentId }));
    } catch (e) {
      throw e instanceof Fault ? e : new Fault('stale_document');
    }
    const reply = matchReply(req, raw);
    if (!reply) throw new Fault('invalid_message');
    if (!reply.ok) throw new Fault(reply.error ?? 'invalid_message');
    return reply;
  }
  private fence(s: RecordState) {
    const b = s.binding;
    if (!b) return Promise.resolve();
    return this.send(s, b, s.cp.epoch, { kind: 'fence' }).then(
      () => {},
      () => {},
    );
  }
  private async stop(s: RecordState, state: 'paused' | 'cancelled', issue: ErrorCode | null) {
    advance(s);
    s.navigation = undefined;
    s.cp.issue = issue;
    if (live(s.cp.task)) {
      s.cp.task!.state = state;
      s.cp.task!.cancelled = state === 'cancelled';
    }
    await Promise.all([this.store.save(s), this.fence(s)]);
  }
  async invoked(t: chrome.tabs.Tab) {
    await this.ready;
    if (t.id === undefined) return;
    const s = this.store.get(t.id),
      site = permittedOrigin(t.url);
    s.windowId = t.windowId;
    if (s.cp.invokedOrigin !== site) await this.stop(s, 'paused', site ? null : 'unsupported_page');
    s.cp.invokedOrigin = site;
    s.cp.knownOrigin = site;
    s.cp.issue = site ? null : 'unsupported_page';
    await this.store.save(s);
  }
  private async inspect(
    s: RecordState,
    t: chrome.tabs.Tab,
    goal: string,
    mode: TaskSession['mode'],
    cause: 'inspect' | 'recover' | 'resume' | 'start' | 'observe' | 'navigate' = 'inspect',
    startWorkflow?: WorkflowId,
  ) {
    const old = s.cp.task;
    const recover = cause === 'recover';
    const keep =
      cause !== 'start' &&
      live(old) &&
      old!.goal === goal &&
      old!.mode === mode &&
      (cause !== 'inspect' || !old!.guide);
    const workflow = startWorkflow ?? (keep ? old?.guide?.workflow : undefined);
    const from = keep ? old?.guide?.step : undefined;
    s.navigation = undefined;
    const prior =
      cause !== 'inspect' && keep && old?.documentId && old.revision
        ? { documentId: old.documentId, revision: old.revision }
        : null;
    const n = advance(s);
    const task: TaskSession = {
      id: keep ? old!.id : crypto.randomUUID(),
      tabId: s.cp.tabId,
      epoch: n,
      goal,
      mode,
      state: 'inspecting',
      cancelled: false,
      documentId: null,
      revision: null,
      lastVerified: keep ? old!.lastVerified : null,
      steps: keep ? old!.steps : 0,
      ...(workflow ? { guide: { workflow, step: from ?? 1 } } : {}),
    };
    s.cp.task = task;
    s.cp.issue = null;
    s.windowId = t.windowId;
    await this.store.save(s);
    try {
      const a = await access(s, this.store.prefs, t);
      guard(s, n);
      const doc = await deadline(probe(s.cp.tabId, a.site));
      guard(s, n);
      s.cp.knownOrigin = a.site;
      s.binding = { origin: a.site, documentId: doc };
      await deadline(
        chrome.scripting.executeScript({
          target: { tabId: s.cp.tabId, documentIds: [doc] },
          files: [bridgeFile],
        }),
      );
      guard(s, n);
      const reply = await this.send(s, s.binding, n, {
        kind: 'snapshot',
        access: a.access,
        ...(workflow ? { workflow } : s.inspectProfile ? { profile: s.inspectProfile } : {}),
        ...(prior?.documentId === doc ? { previousRevision: prior.revision } : {}),
      });
      guard(s, n);
      const fresh = await chrome.tabs.get(s.cp.tabId);
      guard(s, n);
      if ((!fresh.active && !recover) || (await probe(s.cp.tabId, a.site)) !== doc)
        throw new Fault('stale_document');
      guard(s, n);
      s.snapshot = reply.snapshot;
      task.documentId = doc;
      task.revision = s.snapshot!.context.revision;
      task.lastVerified = 'inspected';
      task.steps = Math.min(1000000, task.steps + 1);
      task.state = recover ? 'paused' : 'awaiting_user';
      if (workflow) {
        const facts = s.snapshot?.guide;
        if (!facts || facts.workflow !== workflow) throw new Fault('invalid_message');
        if (!recover) {
          // A reload/back/unrelated page cannot reuse the old suggestion. Even expected
          // navigation must produce the allowed next state in this fresh document.
          const forward =
            cause !== 'navigate' ||
            (from === 2 && facts.step === 3) ||
            (from === 3 && facts.result === 'complete');
          if (!forward || (cause === 'observe' && from !== undefined && facts.step < from)) {
            task.state = 'paused';
            s.cp.issue = 'stale_document';
          } else {
            task.guide!.step = facts.step;
            if (facts.result === 'complete') task.state = 'completed';
            else if (facts.result === 'target' && facts.ref) {
              await this.send(s, s.binding, n, {
                kind: 'highlight',
                ref: facts.ref,
                revision: task.revision,
              });
              guard(s, n);
              if (!(await chrome.tabs.get(s.cp.tabId)).active) throw new Fault('stale_document');
              guard(s, n);
              task.state = 'showing_step';
              task.lastVerified = 'highlighted';
            } else task.state = 'paused';
          }
        }
      }
      await this.store.save(s);
    } catch (e) {
      if (s.cp.epoch === n) await this.stop(s, 'paused', fault(e));
      if (!recover) throw e;
    }
  }
  private async pageAction(s: RecordState, r: PanelRequest) {
    const c = r.command;
    if (c.kind !== 'highlight' && c.kind !== 'clear' && c.kind !== 'reveal')
      throw new Fault('invalid_message');
    if (!s.snapshot || !s.binding || s.busy) throw new Fault('blocked_by_policy');
    if (!s.cp.task || !['showing_step', 'awaiting_user'].includes(s.cp.task.state))
      throw new Fault('blocked_by_policy');
    if (c.kind === 'highlight') canHighlight(s, c.step);
    if (
      c.kind === 'reveal' &&
      ((s.snapshot.guide?.ref ?? s.cue?.ref) !== c.ref || s.cp.task.state !== 'showing_step')
    )
      throw new Fault('stale_document');
    if (s.cp.task.guide && c.kind !== 'reveal') throw new Fault('blocked_by_policy');
    const n = s.cp.epoch,
      b = s.binding,
      revision = s.snapshot.context.revision;
    s.busy = r.requestId;
    try {
      const a = await access(s, this.store.prefs, await this.tabFor(r));
      guard(s, n);
      if (a.site !== b.origin || (await probe(r.tabId, a.site)) !== b.documentId)
        throw new Fault('stale_document');
      guard(s, n);
      const applied = await this.send(
        s,
        b,
        n,
        c.kind === 'highlight'
          ? { kind: 'highlight', ref: c.step.ref, revision }
          : c.kind === 'reveal'
            ? { kind: 'reveal', ref: c.ref, revision }
            : { kind: 'clear', revision },
      );
      guard(s, n);
      await this.tabFor(r);
      guard(s, n);
      if (s.cp.task) {
        const ref = c.kind === 'highlight' ? c.step.ref : c.kind === 'reveal' ? c.ref : null;
        s.cue = ref && applied.placement ? { ref, placement: applied.placement } : undefined;
        s.cp.task.lastVerified = c.kind !== 'clear' ? 'highlighted' : 'cleared';
        s.cp.task.steps = Math.min(1000000, s.cp.task.steps + 1);
        s.cp.task.state = c.kind !== 'clear' ? 'showing_step' : 'awaiting_user';
      }
      await this.store.save(s);
    } catch (e) {
      if (n === s.cp.epoch) await this.stop(s, 'paused', fault(e));
      throw e;
    } finally {
      if (s.busy === r.requestId) s.busy = undefined;
    }
  }
  private async view(s: RecordState, t: chrome.tabs.Tab) {
    let status: PanelView['access'];
    const site = permittedOrigin(t.url);
    try {
      status = (await access(s, this.store.prefs, t)).access;
    } catch (e) {
      const code = fault(e);
      status =
        code === 'permission_revoked' || code === 'unsupported_page' ? code : 'permission_required';
    }
    return this.store.view(s, t, site, status);
  }
  async handle(r: PanelRequest) {
    await this.ready;
    const t = await this.tabFor(r),
      s = this.store.get(r.tabId);
    s.windowId = t.windowId;
    const c = r.command;
    if (c.kind === 'view') return this.view(s, t);
    checkRequest(s, r);
    switch (c.kind) {
      case 'inspect':
        s.inspectProfile = c.profile;
        await this.inspect(s, t, c.goal, c.mode);
        break;
      case 'guide':
        await this.inspect(s, t, workflows[c.workflow].goal, 'guide', 'start', c.workflow);
        break;
      case 'reveal':
      case 'highlight':
      case 'clear':
        await this.pageAction(s, r);
        break;
      case 'pause':
      case 'cancel':
        if (!live(s.cp.task)) throw new Fault('blocked_by_policy');
        await this.stop(
          s,
          c.kind === 'pause' ? 'paused' : 'cancelled',
          c.kind === 'pause' ? null : 'cancelled',
        );
        break;
      case 'resume':
        if (s.cp.task?.state !== 'paused') throw new Fault('blocked_by_policy');
        await this.inspect(s, t, s.cp.task.goal, s.cp.task.mode, 'resume');
        break;
      case 'restore':
        await this.stop(s, 'paused', null);
        break;
      case 'textSize':
        this.store.prefs.largeText = c.large;
        await this.store.configure();
        break;
      case 'siteDenied':
        s.cp.issue = 'permission_denied';
        await this.store.save(s);
        break;
      case 'siteGranted': {
        const site = permittedOrigin(t.url);
        if (!site || !(await chrome.permissions.contains({ origins: [pattern(site)] })))
          throw new Fault('permission_required');
        guard(s, r.epoch);
        if (!this.store.prefs.sites.includes(site)) {
          if (this.store.prefs.sites.length >= 64) throw new Fault('blocked_by_policy');
          this.store.prefs.sites.push(site);
        }
        s.cp.issue = null;
        await this.store.configure();
        await this.store.save(s);
        break;
      }
      case 'siteRemoved': {
        const site = permittedOrigin(t.url) ?? s.cp.knownOrigin;
        if (!site) throw new Fault('permission_required');
        await this.removeSites([pattern(site)]);
        await chrome.permissions.remove({ origins: [pattern(site)] }).catch(() => false);
        break;
      }
      case 'forget':
        await this.forget();
        return this.view(this.store.get(r.tabId), t);
    }
    return this.view(s, await this.tabFor(r));
  }
  async removeSites(patterns: string[]) {
    const sites = this.store.prefs.sites.filter((s) => removedOrigin(s, patterns));
    this.store.prefs.sites = this.store.prefs.sites.filter((s) => !sites.includes(s));
    await Promise.all(
      [...this.store.tabs.values()].map(async (s) => {
        const site = s.cp.knownOrigin ?? s.cp.invokedOrigin;
        if (!site || !removedOrigin(site, patterns)) return;
        if (s.cp.issue !== 'permission_revoked' || s.cp.invokedOrigin) {
          s.cp.invokedOrigin = null;
          await this.stop(s, 'paused', 'permission_revoked');
        }
      }),
    );
    await this.store.configure();
  }
  async forget() {
    const sites = this.store.prefs.sites.slice();
    this.store.prefs = { largeText: false, sites: [] };
    await Promise.all(
      [...this.store.tabs.values()].map(async (s) => {
        s.cp.invokedOrigin = null;
        await this.stop(s, 'cancelled', null);
        await this.store.drop(s.cp.tabId);
      }),
    );
    await this.store.configure();
    for (const site of new Set(sites.map(pattern)))
      await chrome.permissions.remove({ origins: [site] }).catch(() => false);
  }
  async changed(raw: unknown, sender: chrome.runtime.MessageSender) {
    const c = parseWire(Changed, raw);
    if (
      !c ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.tab?.id !== c.tabId ||
      sender.documentId !== c.documentId
    )
      return;
    await this.ready;
    const s = this.store.tabs.get(c.tabId);
    if (
      s &&
      s.cp.epoch === c.epoch &&
      s.binding?.documentId === c.documentId &&
      (s.snapshot?.context.revision === c.revision || s.cp.task?.state === 'inspecting')
    ) {
      if (c.reason === 'placement') {
        if (c.cue && s.cue?.ref === c.cue.ref && s.cp.task?.state === 'showing_step') {
          s.cue = c.cue;
          // This ephemeral view changed without changing the checkpoint. Notify open panels.
          await chrome.runtime
            .sendMessage({ channel: 'cue-updated', tabId: c.tabId })
            .catch(() => {});
        }
        return;
      }
      if (s.cp.task?.guide && s.cp.task.state === 'showing_step') {
        const n = s.cp.epoch,
          t = await chrome.tabs.get(c.tabId);
        if (s.cp.epoch !== n || !t.active) return;
        if (t.status === 'loading') return; // Navigation handles its own fresh-document inspection.
        await this.inspect(s, t, s.cp.task.goal, s.cp.task.mode, 'observe');
        return;
      }
      await this.stop(
        s,
        'paused',
        c.reason === 'element_missing' ? 'element_missing' : 'stale_document',
      );
    }
  }
  async activation(active: { tabId: number; windowId: number }) {
    await this.ready;
    await Promise.all(
      [...this.store.tabs.values()]
        .filter(
          (s) =>
            s.windowId === active.windowId &&
            s.cp.tabId !== active.tabId &&
            (s.snapshot || s.cp.task?.state === 'inspecting'),
        )
        .map((s) => this.stop(s, 'paused', 'stale_document')),
    );
  }
  async navigation(id: number, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) {
    await this.ready;
    const s = this.store.tabs.get(id);
    if (!s) return;
    const task = s.cp.task;
    if (task?.guide && (change.status === 'loading' || change.url)) {
      if (task.state === 'completed') task.state = 'paused';
      const g = task.guide,
        prior = s.navigation;
      const proposed = task.state === 'showing_step' && s.snapshot?.guide?.result === 'target';
      const allowed =
        !!t.active &&
        ((proposed && expectedNavigation(g.workflow, g.step, t.url)) ||
          (prior?.taskId === task.id && expectedNavigation(prior.workflow, prior.from, t.url)));
      const nav = allowed
        ? { taskId: task.id, workflow: g.workflow, from: prior?.from ?? g.step }
        : undefined;
      const site = permittedOrigin(t.url);
      if (site !== s.cp.invokedOrigin) s.cp.invokedOrigin = null;
      s.cp.knownOrigin = site;
      // Fence synchronously, before any async reply can restore the prior document.
      const stopped = this.stop(s, 'paused', site ? 'stale_document' : 'permission_required');
      s.navigation = nav;
      const n = s.cp.epoch;
      await stopped;
      if (s.cp.epoch !== n) return;
      if (change.status === 'loading' || t.status === 'loading') return;
      if (!nav) return;
    }
    if (task?.guide) {
      if (
        (change.status === 'complete' || change.url) &&
        s.navigation?.taskId === task.id &&
        t.active
      ) {
        const nav = s.navigation;
        s.navigation = undefined;
        if (expectedNavigation(nav.workflow, nav.from, t.url) && task.state === 'paused')
          await this.inspect(s, t, task.goal, task.mode, 'navigate');
      } else if (
        change.status === 'complete' &&
        task.state === 'paused' &&
        s.cp.issue === 'stale_document' &&
        t.active
      ) {
        await this.inspect(s, t, task.goal, task.mode, 'recover');
      }
      return;
    }
    if (change.status === 'loading' || change.url) {
      const site = permittedOrigin(t.url);
      if (site !== s.cp.invokedOrigin) s.cp.invokedOrigin = null;
      s.cp.knownOrigin = site;
      if (live(s.cp.task) || s.snapshot)
        await this.stop(
          s,
          'paused',
          site ? 'stale_document' : t.url ? 'unsupported_page' : 'permission_required',
        );
      else {
        advance(s);
        await this.store.save(s);
      }
    }
    if (
      change.status === 'complete' &&
      s.cp.task?.state === 'paused' &&
      ['stale_document', 'permission_required', 'unsupported_page'].includes(s.cp.issue ?? '') &&
      t.active
    )
      await this.inspect(s, t, s.cp.task.goal, s.cp.task.mode, 'recover');
  }
}
