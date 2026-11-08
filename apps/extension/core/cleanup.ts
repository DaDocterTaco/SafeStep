import {
  cleanupScope,
  Fault,
  parseWire,
  sameBinding,
  CleanReply,
  CleanNotice,
  type ReviewBinding,
  type CleanupView,
} from '@safestep/contracts';
import { access, bridgeFile, probe } from './access';
import type { Store } from './store';
import type { RecordState } from './state';
export class PageCleanup {
  private readonly previews=new Map<number,{operationId:string;turnId:string|null;scope:ReturnType<typeof cleanupScope>}>();
  constructor(private store: Store) {}
  private async send(b: ReviewBinding, cmd: string, id?: string, ids?:string[]) {
    const requestId = crypto.randomUUID(),
      raw = await chrome.tabs
        .sendMessage(
          b.tabId,
          { channel: 'clean-page', binding: b, requestId, cmd, ...(id ? { id } : {}),...(ids?{ids}:{}) },
          { documentId: b.documentId },
        )
        .catch(() => null);
    const result = parseWire(CleanReply, raw);
    if (
      !result?.view ||
      result.requestId !== requestId ||
      !sameBinding(result.binding, b) ||
      !sameBinding(result.view.binding, b)
    )
      throw new Fault('stale_document');
    return result.view;
  }
  async reset(s: RecordState) {
    this.previews.delete(s.cp.tabId);
    const b = s.cp.cleanup;
    delete s.cp.cleanup;
    delete s.cleanup;
    if (b) await this.send(b, 'restore').catch(() => {});
  }
  async operate(
    s: RecordState,
    t: chrome.tabs.Tab,
    action: 'preview' | 'apply' | 'restore' | 'restore_one',
    id?: string,
    selection?:{operationId:string;revision:string;ids:string[]},
  ) {
    const a = await access(s, this.store.prefs, t),
      doc = await probe(t.id!, a.site);
    if (action === 'preview') {
      await chrome.scripting.executeScript({
        target: { tabId: t.id!, documentIds: [doc] },
        files: [bridgeFile],
      });
      s.cp.cleanup = {
        taskId: s.cp.task?.id ?? null,
        tabId: t.id!,
        documentId: doc,
        origin: a.site,
        generation: Date.now() * 1000,
        epoch: s.cp.epoch,
        revision: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
      };
      const chat=s.cp.chat;
      const owner=chat?.turns.find(turn=>turn.id===chat.activeTurnId && !turn.historical && turn.feature==='page_cleanup');
      this.previews.set(s.cp.tabId,{operationId:s.cp.cleanup.operationId,turnId:owner?.id??null,scope:cleanupScope(owner?.original??'')});
    }
    const b = s.cp.cleanup;
    if (!b || b.documentId !== doc || b.origin !== a.site) throw new Fault('stale_document');
    if(selection && (action!=='apply' || selection.operationId!==b.operationId || selection.revision!==b.revision ||
      selection.ids.some(id=>!s.cleanup?.items.some(i=>i.id===id&&!i.hidden))))throw new Fault('stale_document');
    let eligibleIds=selection?.ids;
    if(action==='apply'){
      const tab=await chrome.tabs.get(b.tabId);
      if(!tab.active || tab.windowId!==t.windowId || !(await chrome.windows.get(tab.windowId)).focused || s.cp.cleanup!==b)
        throw new Fault('stale_document');
      const policy=this.previews.get(s.cp.tabId), chat=s.cp.chat;
      if(policy?.operationId!==b.operationId || (policy.turnId && (!chat || chat.activeTurnId!==policy.turnId ||
        !chat.turns.some(turn=>turn.id===policy.turnId && !turn.historical && turn.operationId===b.operationId))))
        throw new Fault('stale_document');
      if(policy.scope.restricted){
        const allowed=(s.cleanup?.items??[]).filter(i=>!i.hidden && policy.scope.allowed.includes(i.reason)).map(i=>i.id);
        if(!allowed.length || eligibleIds?.some(id=>!allowed.includes(id)))throw new Fault('blocked_by_policy');
        eligibleIds??=allowed;
      }
    }
    const v = await this.send(b, action, id,eligibleIds);
    if (
      s.cp.cleanup !== b ||
      !(await chrome.tabs.get(b.tabId)).active ||
      (await probe(b.tabId, a.site)) !== doc
    )
      throw new Fault('stale_document');
    s.cleanup = v;
    await this.store.save(s);
  }
  async changed(raw: unknown, sender: chrome.runtime.MessageSender): Promise<RecordState | null> {
    const m = parseWire(CleanNotice, raw);
    if (
      !m ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.documentId !== m.binding.documentId ||
      sender.tab?.id !== m.binding.tabId ||
      !sameBinding(m.view.binding, m.binding)
    )
      return null;
    const s = this.store.tabs.get(m.binding.tabId);
    if (!s?.cp.cleanup || !sameBinding(s.cp.cleanup, m.binding)) return null;
    const prior = s.cleanup;
    if (JSON.stringify(prior) === JSON.stringify(m.view)) return null;
    const before = new Set(prior?.items.filter((i) => i.hidden).map((i) => i.id));
    const after = m.view.items.filter((i) => i.hidden);
    s.cleanup = m.view;
    // Cleanup items are document-local handles. The saved checkpoint only contains
    // their binding, so a storage change cannot notify the open panel of new items.
    await chrome.runtime
      .sendMessage({ channel: 'cue-updated', tabId: m.binding.tabId })
      .catch(() => {});
    return after.length !== before.size || after.some((i) => !before.has(i.id)) ? s : null;
  }
}
