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
import { expectedNavigation, resolveGoal, workflows } from '../sites/profiles';
import { publisherChoice } from '../sites/publisher-goal';
import { access, bridgeFile, pattern, probe, removedOrigin } from './access';
import { advance, canHighlight, checkRequest, guard, live, type RecordState } from './state';
import { Store } from './store';
import { Reviews } from './reviews';
import { Shopping } from './shopping';
import { AdaptiveNavigation } from './adaptive';
import { PageCleanup } from './cleanup';
import { Comparisons } from './comparison';
import { Protection } from './protection';
import { Chat } from './chat';

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
  readonly reviews:Reviews = new Reviews(this.store,(...args)=>this.protection.destination(...args));
  readonly shopping = new Shopping(this.store);
  readonly adaptive:AdaptiveNavigation = new AdaptiveNavigation(this.store,(s,t,profile)=>this.reviews.finishDownload(s,t,profile),
    (...args)=>this.protection.destination(...args));
  readonly cleanup = new PageCleanup(this.store);
  readonly comparisons = new Comparisons(this.store, this.shopping,(...args)=>this.protection.destination(...args));
  readonly protection:Protection = new Protection(this.store,(s,why)=>this.adaptive.pause(s,why));
  readonly chat = new Chat(this.store,(s,t,command)=>this.handle({
    v:2,channel:'panel',requestId:crypto.randomUUID(),tabId:s.cp.tabId,windowId:t.windowId,
    epoch:s.cp.epoch,documentId:s.snapshot?.context.documentId??null,revision:s.snapshot?.context.revision??null,command,
  }));
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
    await this.protection.restore();
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
        await this.chat.recover(s);
        await this.comparisons.recover(s);
        if (s.cp.cleanup) {
          await this.cleanup.reset(s);
          await this.store.save(s);
        }
        if (s.cp.shopping) {
          this.shopping.clear(s);
          await this.store.save(s);
        }
        if (s.cp.review) {
          await this.reviews.close(s, true);
          await this.store.save(s);
        }
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
        if (s.cp.task?.adaptive) {
          const task = s.cp.task,
            a = task.adaptive!;
          if (task.documentId && task.revision && s.cp.knownOrigin)
            await chrome.tabs
              .sendMessage(
                s.cp.tabId,
                {
                  channel: 'assist-page',
                  requestId: crypto.randomUUID(),
                  binding: {
                    operationId: crypto.randomUUID(),
                    taskId: task.id,
                    goalVersion: a.version,
                    tabId: s.cp.tabId,
                    windowId: t.windowId,
                    documentId: task.documentId,
                    revision: task.revision,
                    epoch: s.cp.epoch,
                    generation: Date.now() * 1000,
                    origin: a.origin,
                  },
                  cmd: { op: 'clear' },
                },
                { documentId: task.documentId },
              )
              .catch(() => {});
          await this.adaptive.recover(s, t);
          return;
        }
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
  private async checkedCue(s:RecordState,b:NonNullable<RecordState['binding']>,epoch:number,ref:string,revision:string) {
    if(this.store.prefs.protection?.automaticUrlConsent!==2)return {};
    const current=await this.send(s,b,epoch,{kind:'destination',ref,revision});
    guard(s,epoch);
    const url=current.controlDestination;
    if(url===undefined)throw new Fault('invalid_message');
    if(url!==null) {
      const tab=await chrome.tabs.get(s.cp.tabId);
      const result=await this.protection.destination(s,tab,{kind:'navigation',url:url==='excluded'?'':url,documentId:b.documentId},AbortSignal.timeout(7000));
      guard(s,epoch);
      if(!result.allow)throw new Fault('blocked_by_policy');
    }
    return {checkedDestination:url};
  }
  private async stop(s: RecordState, state: 'paused' | 'cancelled', issue: ErrorCode | null) {
    if (s.cp.task?.adaptive) {
      s.cp.issue = issue;
      await this.adaptive.pause(
        s,
        issue ? 'Page or access changed. Continue with a fresh inspection.' : 'Paused by you.',
        state,
      );
      return;
    }
    advance(s);
    s.navigation = undefined;
    s.citationJump = undefined;
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
    if (cause !== 'observe') s.citationJump = undefined;
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
              if (workflow === 'wikipedia_cite_apa' && facts.step === 3)
                s.citationJump = { taskId: task.id, documentId: doc };
              await this.send(s, s.binding, n, {
                kind: 'highlight',
                ref: facts.ref,
                revision: task.revision,
                ...await this.checkedCue(s,s.binding,n,facts.ref,task.revision),
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
          ? { kind: 'highlight', ref: c.step.ref, revision, ...await this.checkedCue(s,b,n,c.step.ref,revision) }
          : c.kind === 'reveal'
            ? { kind: 'reveal', ref: c.ref, revision, ...await this.checkedCue(s,b,n,c.ref,revision) }
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
    await this.chat.refresh(s,t);
    this.comparisons.expire(s);
    let status: PanelView['access'];
    const site = permittedOrigin(t.url);
    try {
      status = (await access(s, this.store.prefs, t)).access;
    } catch (e) {
      const code = fault(e);
      status =
        code === 'permission_revoked' || code === 'unsupported_page' ? code : 'permission_required';
    }
    const v=await this.store.view(s,t,site,status);
    if(v.protection&&!await this.protection.isCurrent(t,v.protection))delete v.protection;
    return v;
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
      case 'chat':
        await this.chat.operate(s,t,c.action);
        break;
      case 'protection':
        await this.protection.operate(t,c.action);
        break;
      case 'compare':
        if (!['clear','cancel'].includes(c.action.op) && s.cp.task?.adaptive?.authorized)
          await this.adaptive.pause(
            s,
            'Shopping comparison requested. Automatic navigation is paused.',
          );
        await this.comparisons.operate(s, t, c.action);
        break;
      case 'assistGoal':
        if (s.cp.task && !s.cp.task.adaptive) await this.stop(s, 'paused', null);
        if(c.download && publisherChoice(c.goal, t.url ? new URL(t.url).origin : null, c.download).kind !== 'ready')
          throw new Fault('blocked_by_policy');
        await this.adaptive.begin(s, t, c.goal, c.download, !!c.download && c.localPublisher === true);
        break;
      case 'assistControl':
        if(c.action==='automatic' && s.protection?.caution && !s.protection.dismissed){
          await this.adaptive.pause(s,'Review the website warning in Safety checks before approving navigation.');
          break;
        }
        await this.adaptive.control(s, t, c.action);
        break;
      case 'clean':
        if (c.action !== 'preview') await this.stop(s, 'paused', null);
        await this.cleanup.operate(s, t, c.action, c.id,c.selection);
        break;
      case 'shop':
        if(s.cp.task?.adaptive?.authorized) await this.adaptive.pause(s,'Seller or product inspection requested. Automatic navigation is paused.');
        await this.shopping.read(s, t, c.subject);
        break;
      case 'shopDismiss':
        this.shopping.close(s, c.subject);
        await this.store.save(s);
        break;
      case 'shopVerify':
      case 'shopReveal':
        await this.shopping.act(s, t, c.subject, c.operationId, c.kind === 'shopReveal');
        break;
      case 'openShopSource': {
        const data=s.shopping?.[c.subject]?.data;
        if(!data || data.binding.operationId!==c.operationId || !data[c.source])throw new Fault('stale_document');
        const url=data[c.source]!;
        await this.shopping.act(s,t,c.subject,c.operationId);
        const guard=await this.protection.destination(s,t,{kind:'source',url,documentId:data.binding.documentId},AbortSignal.timeout(7000));
        if(!guard.allow)break;
        await this.shopping.act(s,t,c.subject,c.operationId);
        if(s.shopping?.[c.subject]?.data!==data)throw new Fault('stale_document');
        await chrome.tabs.create({url,windowId:t.windowId,active:true});
        break;
      }
      case 'review':
        if(c.selection.kind==='download' && s.cp.task?.adaptive?.authorized)
          await this.adaptive.pause(s,'Download inspection requested. Automatic navigation is paused.');
        if (c.selection.kind === 'download' && s.cancelShopping) this.shopping.clear(s);
        await this.reviews.read(s, t, c.selection);
        break;
      case 'reviewDismiss':
        await this.reviews.dismiss(s);
        break;
      case 'reviewReveal':
        await this.reviews.reveal(s, t, c.operationId);
        break;
      case 'reviewVerify':
        await this.reviews.verify(s, t, c.operationId);
        break;
      case 'inspect':
        s.inspectProfile = c.profile;
        await this.inspect(s, t, c.goal, c.mode);
        break;
      case 'guide':
        if (c.goal && resolveGoal(c.goal) !== c.workflow) throw new Fault('blocked_by_policy');
        await this.inspect(
          s,
          t,
          c.goal ?? workflows[c.workflow].goal,
          'guide',
          'start',
          c.workflow,
        );
        break;
      case 'reveal':
      case 'highlight':
      case 'clear':
        if (s.cancelShopping && c.kind !== 'clear') this.shopping.clear(s);
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
        if (s.cp.cleanup) await this.cleanup.reset(s);
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
    await this.protection.revoked(patterns);
    const sites = this.store.prefs.sites.filter((s) => removedOrigin(s, patterns));
    this.store.prefs.sites = this.store.prefs.sites.filter((s) => !sites.includes(s));
    await Promise.all(
      [...this.store.tabs.values()].map(async (s) => {
        const site = s.cp.knownOrigin ?? s.cp.invokedOrigin;
        if (!site || !removedOrigin(site, patterns)) return;
        if(s.abortChat || s.cp.chat?.activeTurnId)await this.chat.changed(s);
        this.comparisons.forget(s);
        await this.cleanup.reset(s);
        this.shopping.clearHistory(s.cp.tabId);
        if (s.cp.issue !== 'permission_revoked' || s.cp.invokedOrigin) {
          s.cp.invokedOrigin = null;
          await this.stop(s, 'paused', 'permission_revoked');
        }
      }),
    );
    await this.store.configure();
  }
  async forget() {
    const auto=this.store.prefs.protection;
    await this.protection.reset();
    this.shopping.clearHistory();
    await this.shopping.resetBudget();
    await chrome.storage.session.remove('local-ai-session');
    const sites = this.store.prefs.sites.slice();
    this.store.prefs = { largeText: false, sites: [] };
    await Promise.all(
      [...this.store.tabs.values()].map(async (s) => {
        this.comparisons.forget(s);
        await this.cleanup.reset(s);
        s.cp.invokedOrigin = null;
        await this.stop(s, 'cancelled', null);
        await this.store.drop(s.cp.tabId);
      }),
    );
    await this.store.configure();
    for (const site of new Set([...sites,...(auto?.sites??[])].map(pattern).concat(auto?.scope==='all'?['http://*/*','https://*/*']:[])))
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
        if (
          c.cue &&
          s.cp.task?.state === 'showing_step' &&
          (s.cue?.ref === c.cue.ref || s.snapshot?.guide?.ref === c.cue.ref)
        ) {
          if (s.snapshot?.guide?.ref === c.cue.ref) s.snapshot.guide.placement = c.cue.placement;
          else s.cue = c.cue;
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
    for(const s of this.store.tabs.values())if(s.windowId===active.windowId && s.cp.tabId!==active.tabId && (s.abortChat || s.cp.chat?.activeTurnId))
      await this.chat.changed(s);
    for (const s of this.store.tabs.values())
      if (
        s.windowId === active.windowId &&
        s.cp.tabId !== active.tabId &&
        s.comparison &&
        !['stale', 'paused', 'cancelled'].includes(s.comparison.status)
      )
        this.comparisons.invalidate(
          s,
          'The active tab changed. Refresh from the original product.',
        );
    await Promise.all(
      [...this.store.tabs.values()]
        .filter(
          (s) =>
            s.windowId === active.windowId &&
            s.cp.tabId !== active.tabId &&
            (s.snapshot ||
              s.abortAssist ||
              s.cancelReview ||
              s.cancelShopping ||
              s.cp.task?.state === 'inspecting'),
        )
        .map((s) => this.stop(s, 'paused', 'stale_document')),
    );
  }
  async navigation(id: number, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) {
    await this.ready;
    const s = this.store.tabs.get(id);
    if (!s) return;
    if(change.url||change.status==='loading')await this.chat.changed(s,true);
    if (
      s.comparison &&
      (change.url || change.status === 'loading') &&
      !['stale', 'paused', 'cancelled'].includes(s.comparison.status)
    )
      this.comparisons.invalidate(
        s,
        'The product page changed. Refresh to inspect the current document.',
      );
    const cleaning = s.cp.cleanup;
    if (
      cleaning &&
      (change.status === 'loading' || change.url) &&
      (await probe(id, cleaning.origin).catch(() => null)) !== cleaning.documentId &&
      s.cp.cleanup === cleaning
    ) {
      await this.cleanup.reset(s);
      await this.store.save(s);
    }
    if ((change.status === 'loading' || change.url) && s.cancelShopping) {
      this.shopping.clear(s);
      await this.store.save(s);
    }
    if ((change.status === 'loading' || change.url) && s.cancelReview) {
      this.reviews.close(s, true);
      await this.store.save(s);
    }
    const task = s.cp.task;
    if (task?.adaptive) {
      await this.adaptive.navigation(s, change, t);
      return;
    }
    // The content bridge observes the actual APA heading, including the scroll
    // following the fragment change. Chrome can report that same change before
    // or after the bridge. It must not fence a still-active same-document jump.
    const jump = s.citationJump;
    if (
      task &&
      jump?.taskId === task.id &&
      t.active &&
      expectedNavigation('wikipedia_cite_apa', 3, t.url)
    ) {
      const epoch = s.cp.epoch;
      const doc = await probe(id, 'https://en.wikipedia.org').catch(() => null);
      if (epoch !== s.cp.epoch) return;
      if (
        doc === jump.documentId &&
        s.citationJump === jump &&
        !task.cancelled &&
        task.state !== 'paused'
      )
        return;
    }
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
