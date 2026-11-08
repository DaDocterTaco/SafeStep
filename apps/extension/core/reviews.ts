import {
  Fault,
  parseWire,
  ReviewChange,
  ReviewPageReply,
  sameBinding,
  type ReviewBinding,
  type ReviewPageRequest,
  type Selection,
  type FileProfile,
} from '@safestep/contracts';
import { isPublisherTerminal } from '../sites/publisher-goal';
import { access, bridgeFile, probe } from './access';
import type { Store } from './store';
import type { RecordState } from './state';
import type { DestinationPreflight } from './destination-check';
import type { ReviewData } from '@safestep/contracts';

let sequence = 0;
export class Reviews {
  private pending = new Map<number, AbortController>();
  private held = new Map<number,string>();
  constructor(private store: Store,private preflight?:DestinationPreflight) {}
  private async checkSelected(s:RecordState,t:chrome.tabs.Tab,data:ReviewData) {
    if(!this.preflight || !data.selected)return true;
    const hit=data.candidates.find(x=>x.ref===data.selected && x.relation==='publisher_link');
    if(!hit || !hit.publisherPath || !hit.address.host || hit.address.scheme!=='https' || hit.address.port)throw new Fault('blocked_by_policy');
    const url='https://'+hit.address.host+hit.publisherPath;
    const controller=new AbortController();
    this.pending.get(s.cp.tabId)?.abort();
    this.pending.set(s.cp.tabId,controller);
    try{
      const check=await this.preflight(s,t,{kind:'download',url,documentId:data.binding.documentId},controller.signal);
      if(controller.signal.aborted || s.cp.review?.operationId!==data.binding.operationId)throw new Fault('stale_document');
      if(!check.allow){
        this.held.set(s.cp.tabId,data.binding.operationId);
        await this.send(data.binding,{kind:'hide'});
        return false;
      }
      this.held.delete(s.cp.tabId);
      // The publisher control may have changed while the source was checking.
      if(!await this.send(data.binding,{kind:'verify'}))throw new Fault('stale_document');
      return true;
    }finally{
      if(this.pending.get(s.cp.tabId)===controller)this.pending.delete(s.cp.tabId);
    }
  }
  private async send(b: ReviewBinding, command: ReviewPageRequest['command']) {
    const req: ReviewPageRequest = {
      v: 1,
      channel: 'review-page',
      requestId: crypto.randomUUID(),
      binding: b,
      command,
    };
    const reply = parseWire(
      ReviewPageReply,
      await chrome.tabs.sendMessage(b.tabId, req, { documentId: b.documentId }).catch(() => null),
    );
    if (
      !reply?.ok ||
      reply.requestId !== req.requestId ||
      !sameBinding(b, reply.binding) ||
      (reply.data && !sameBinding(b, reply.data.binding))
    )
      throw new Fault('stale_document');
    return reply.data;
  }
  close(s: RecordState, stale = false) {
    this.pending.get(s.cp.tabId)?.abort();
    this.held.delete(s.cp.tabId);
    const binding = s.cp.review;
    s.review = undefined;
    s.cp.review = undefined;
    s.cancelReview = undefined;
    s.reviewStale = stale;
    return binding
      ? this.send(binding, { kind: 'close' }).then(
          () => {},
          () => {},
        )
      : Promise.resolve();
  }
  async dismiss(s: RecordState) {
    await this.close(s);
    await this.store.save(s);
  }
  async finishDownload(s: RecordState, t: chrome.tabs.Tab, profile: FileProfile) {
    const task = s.cp.task;
    if (!task?.adaptive || task.adaptive.download !== profile || !t.url || !isPublisherTerminal(new URL(t.url),profile))
      throw new Fault('blocked_by_policy');
    const epoch=task.epoch;
    await this.read(s,t,{kind:'download',profile},task.id);
    const data=s.review;
    if(!data?.selected || this.held.get(s.cp.tabId)===data.binding.operationId || data.binding.taskId!==task.id || task.epoch!==epoch || s.cp.task!==task) return false;
    await this.verify(s,t,data.binding.operationId);
    return s.review===data && s.cp.task===task && s.cp.epoch===epoch;
  }
  async read(s: RecordState, t: chrome.tabs.Tab, selection: Selection, owner?: string) {
    const expected = s.cp.task?.guide?.workflow ?? s.inspectProfile;
    if (selection.kind === 'website' && expected) selection = { ...selection, expected };
    if (
      selection.kind === 'download' &&
      s.cp.task &&
      ['showing_step', 'awaiting_user', 'inspecting'].includes(s.cp.task.state) && s.cp.task.id !== owner
    )
      throw new Fault('blocked_by_policy');
    this.close(s);
    const epoch = s.cp.epoch,
      taskId = s.cp.task?.id ?? null;
    const generation = (sequence = Math.max(sequence + 1, Date.now() * 1000));
    const cancel = () => this.close(s);
    s.cancelReview = cancel;
    const current = () => {
      if (s.cancelReview !== cancel || s.cp.epoch !== epoch || !t.active)
        throw new Fault('stale_document');
    };
    try {
      const a = await access(s, this.store.prefs, t);
      current();
      s.cp.knownOrigin = a.site;
      const doc = await probe(s.cp.tabId, a.site);
      current();
      const b: ReviewBinding = {
        operationId: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        generation,
        epoch,
        taskId,
        tabId: s.cp.tabId,
        origin: a.site,
        documentId: doc,
      };
      s.cp.review = b;
      await this.store.save(s);
      current();
      await chrome.scripting.executeScript({
        target: { tabId: b.tabId, documentIds: [doc] },
        files: [bridgeFile],
      });
      current();
      let data = await this.send(b, { kind: 'read', selection });
      current();
      if (!data || JSON.stringify(data.selection) !== JSON.stringify(selection))
        throw new Fault('invalid_message');
      if (data.selected) {
        const show=await this.checkSelected(s,t,data);
        current();
        if(show)data = await this.send(b, { kind: 'show', ref: data.selected, scroll: false });
        current();
      }
      if (
        !data ||
        !(await chrome.tabs.get(b.tabId)).active ||
        (await probe(b.tabId, a.site)) !== doc
      )
        throw new Fault('stale_document');
      current();
      s.review = data;
      await this.store.save(s);
      await this.notify(s);
    } catch (e) {
      if (s.cancelReview === cancel) {
        this.close(s, true);
        await this.store.save(s);
      }
      throw e;
    }
  }
  private async notify(s: RecordState) {
    await chrome.runtime.sendMessage({ channel: 'cue-updated', tabId: s.cp.tabId }).catch(() => {});
  }
  async verify(s: RecordState, t: chrome.tabs.Tab, id: string) {
    const d = s.review;
    if (!d || d.binding.operationId !== id) throw new Fault('stale_document');
    try {
      const a = await access(s, this.store.prefs, t);
      if (
        a.site !== d.binding.origin ||
        (await probe(t.id!, a.site)) !== d.binding.documentId ||
        s.review !== d
      )
        throw new Fault('stale_document');
      const verified = await this.send(d.binding, { kind: 'verify' });
      if (!verified || s.review !== d) throw new Fault('stale_document');
    } catch (e) {
      if (s.review === d) {
        this.close(s, true);
        await this.store.save(s);
      }
      throw e;
    }
  }
  async reveal(s: RecordState, t: chrome.tabs.Tab, id: string) {
    const d = s.review;
    if (!d || d.binding.operationId !== id || !d.selected) throw new Fault('stale_document');
    const b = d.binding;
    const a = await access(s, this.store.prefs, t);
    if (a.site !== b.origin || (await probe(b.tabId, b.origin)) !== b.documentId || s.review !== d)
      throw new Fault('stale_document');
    try {
      if(!await this.checkSelected(s,t,d))return;
      const result = await this.send(b, { kind: 'show', ref: d.selected, scroll: true });
      if (!result || s.review !== d) throw new Fault('stale_document');
      s.review = result;
      await this.notify(s);
    } catch (e) {
      if (s.review === d) {
        this.close(s, true);
        await this.store.save(s);
      }
      throw e;
    }
  }
  async changed(raw: unknown, sender: chrome.runtime.MessageSender) {
    const m = parseWire(ReviewChange, raw);
    if (
      !m ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.documentId !== m.binding.documentId ||
      sender.tab?.id !== m.binding.tabId
    )
      return;
    const s = this.store.tabs.get(m.binding.tabId);
    if (!s?.cp.review || !sameBinding(s.cp.review, m.binding)) return;
    if (m.placement) {
      if (s.review) s.review.placement = m.placement;
    } else {
      if(s.cp.task?.adaptive?.download && s.cp.task.id===m.binding.taskId && s.cp.task.state==='completed'){
        s.cp.task.state='paused';
        s.cp.task.adaptive.status='The download control changed. Resume to inspect the current package.';
      }
      this.close(s, true);
      await this.store.save(s);
    }
    await this.notify(s);
  }
}
