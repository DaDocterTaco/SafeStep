import {
  Fault,
  parseWire,
  ShopPageReply,
  ShopChange,
  ShopReserve,
  sameBinding,
  type ShoppingData,
  type ShoppingKind,
  type ReviewBinding,
  type ShopPageRequest,
  type ShopView,
} from '@safestep/contracts';
import { access, probe, bridgeFile } from './access';
import type { Store } from './store';
import type { RecordState } from './state';
type Capture = { at: string; scope: string; records: number };
export class Shopping {
  private seq = 0;
  private budgetQueue: Promise<unknown> = Promise.resolve();
  resetBudget() {
    this.budgetQueue = this.budgetQueue
      .catch(() => {})
      .then(() => chrome.storage.session.remove('shop-set-budget'));
    return this.budgetQueue;
  }
  reserve(raw: unknown, sender: chrome.runtime.MessageSender): Promise<boolean> {
    const m = parseWire(ShopReserve, raw);
    if (
      !m ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.documentId !== m.binding.documentId ||
      sender.tab?.id !== m.binding.tabId
    )
      return Promise.resolve(false);
    const u = new URL(m.binding.origin);
    const market = u.hostname.endsWith('.resell.store')
      ? 'resell'
      : u.hostname === 'addons.mozilla.org'
        ? 'mozilla'
        : u.origin;
    return this.reserveEvidence(market, m.kind, m.subject, m.binding.operationId, () => {
      const s = this.store.tabs.get(m.binding.tabId),
        b = s?.cp.shopping?.[m.kind];
      return (
        !!s &&
        !!b &&
        sameBinding(b, m.binding) &&
        s.shopTokens?.[m.kind] === b.operationId &&
        s.cp.epoch === b.epoch
      );
    });
  }
  reserveEvidence(
    market: string,
    kind: ShoppingKind,
    subject: string,
    operationId: string,
    current: () => boolean,
  ): Promise<boolean> {
    const reserve = async () => {
      if (!current()) return false;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([market, kind, subject])),
      );
      const key = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join(
        '',
      );
      const { ['shop-set-budget']: raw } = await chrome.storage.session.get('shop-set-budget');
      const sets: Record<string, string[]> = {};
      if (raw !== undefined) {
        if (!raw || typeof raw !== 'object') return false;
        for (const [key, value] of Object.entries(raw)) {
          if (
            !/^[a-f0-9]{64}$/.test(key) ||
            !Array.isArray(value) ||
            value.length > 3 ||
            !value.every((x) => typeof x === 'string' && x.length === 36)
          )
            return false;
          sets[key] = value;
        }
      }
      if (!current()) return false;
      const used = sets[key] ?? [];
      if (used.includes(operationId)) return true;
      if (used.length >= 3 || (!sets[key] && Object.keys(sets).length >= 256)) return false;
      sets[key] = [...used, operationId];
      await chrome.storage.session.set({ 'shop-set-budget': sets });
      return true;
    };
    const result = this.budgetQueue.catch(() => {}).then(reserve);
    this.budgetQueue = result;
    return result;
  }
  private history = new Map<string, { owner: number; items: Capture[]; expires: number }>();
  constructor(private store: Store) {}
  clearHistory(id?: number) {
    for (const [key, h] of this.history)
      if (id === undefined || h.owner === id) this.history.delete(key);
  }
  private async send(b: ReviewBinding, kind: ShoppingKind, command: ShopPageRequest['command']) {
    const r: ShopPageRequest = {
      channel: 'shop-page',
      requestId: crypto.randomUUID(),
      kind,
      binding: b,
      command,
    };
    const raw = await chrome.tabs
      .sendMessage(b.tabId, r, { documentId: b.documentId })
      .catch(() => null);
    const v = parseWire(ShopPageReply, raw);
    if (
      !v?.ok ||
      v.requestId !== r.requestId ||
      !sameBinding(b, v.binding) ||
      (v.data && (!sameBinding(b, v.data.binding) || v.data.kind !== kind))
    )
      throw new Fault('stale_document');
    return v.data;
  }
  close(s: RecordState, k: ShoppingKind) {
    const b = s.cp.shopping?.[k];
    if (s.cp.shopping) delete s.cp.shopping[k];
    if (s.shopping) delete s.shopping[k];
    if (s.shopTokens) delete s.shopTokens[k];
    if (b) void this.send(b, k, { op: 'close' }).catch(() => {});
  }
  clear(s: RecordState) {
    for (const k of ['seller', 'product'] as const) this.close(s, k);
    s.cancelShopping = undefined;
  }
  private partition(d: ShoppingData) {
    const c = d.context;
    return JSON.stringify([
      d.binding.tabId,
      c.market,
      d.kind,
      c.seller,
      c.catalog,
      c.listing,
      c.isbn,
      c.format,
      c.year,
      c.variant,
      c.condition,
      d.source,
      d.filter,
      d.scope,
      d.automatedFilter,
    ]);
  }
  private capture(d: ShoppingData) {
    if (
      !['reviews_available', 'limited_evidence', 'no_reviews_in_view', 'explicit_zero'].includes(
        d.status,
      )
    )
      return [];
    const now = Date.now();
    for (const [key, h] of this.history) if (h.expires <= now) this.history.delete(key);
    const key = this.partition(d);
    const prior = this.history.get(key)?.items.filter((h) => Date.parse(h.at) + 300000 > now) ?? [];
    if (this.history.size >= 96 && !this.history.has(key))
      this.history.delete(this.history.keys().next().value!);
    const items = [...prior, { at: d.captured, scope: d.scope, records: d.records.length }].slice(
      -3,
    );
    this.history.set(key, { items, expires: now + 300000, owner: d.binding.tabId });
    return items;
  }
  async read(s: RecordState, t: chrome.tabs.Tab, k: ShoppingKind) {
    this.close(s, k);
    const token = crypto.randomUUID(),
      epoch = s.cp.epoch;
    (s.shopTokens ??= {})[k] = token;
    s.cancelShopping = () => this.clear(s);
    const current = () => {
      if (s.shopTokens?.[k] !== token || s.cp.epoch !== epoch) throw new Fault('stale_document');
    };
    try {
      const a = await access(s, this.store.prefs, t);
      current();
      const doc = await probe(s.cp.tabId, a.site);
      current();
      const b: ReviewBinding = {
        operationId: token,
        taskId: s.cp.task?.id ?? null,
        tabId: s.cp.tabId,
        documentId: doc,
        origin: a.site,
        epoch,
        revision: crypto.randomUUID(),
        generation: (this.seq = Math.max(this.seq + 1, Date.now() * 1000)),
      };
      (s.cp.shopping ??= {})[k] = b;
      s.cp.knownOrigin = a.site;
      await this.store.save(s);
      current();
      await chrome.scripting.executeScript({
        target: { tabId: b.tabId, documentIds: [doc] },
        files: [bridgeFile],
      });
      current();
      const d = await this.send(b, k, { op: 'read' });
      current();
      if (!d || !(await chrome.tabs.get(b.tabId)).active || (await probe(b.tabId, a.site)) !== doc)
        throw new Fault('stale_document');
      current();
      const view: ShopView = { data: d, history: this.capture(d) };
      (s.shopping ??= {})[k] = view;
      await this.store.save(s);
      await this.notify(s);
    } catch (e) {
      if (s.shopTokens?.[k] === token) {
        this.close(s, k);
        await this.store.save(s);
      }
      throw e;
    }
  }
  private async notify(s: RecordState) {
    await chrome.runtime.sendMessage({ channel: 'cue-updated', tabId: s.cp.tabId }).catch(() => {});
  }
  async act(s: RecordState, t: chrome.tabs.Tab, k: ShoppingKind, id: string, reveal = false) {
    const d = s.shopping?.[k]?.data;
    if (!d || d.binding.operationId !== id) throw new Fault('stale_document');
    if (reveal && (s.cue || s.review?.selected || s.cp.task?.state === 'showing_step'))
      throw new Fault('blocked_by_policy');
    try {
      const a = await access(s, this.store.prefs, t);
      if (a.site !== d.binding.origin || (await probe(t.id!, a.site)) !== d.binding.documentId)
        throw new Fault('stale_document');
      const result = await this.send(
        d.binding,
        k,
        reveal && d.target ? { op: 'reveal', ref: d.target } : { op: 'verify' },
      );
      if (!result || s.shopping?.[k]?.data !== d) throw new Fault('stale_document');
    } catch (e) {
      if (s.shopping?.[k]?.data === d) {
        this.close(s, k);
        await this.store.save(s);
      }
      throw e;
    }
  }
  async changed(raw: unknown, sender: chrome.runtime.MessageSender) {
    const m = parseWire(ShopChange, raw);
    if (
      !m ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.documentId !== m.binding.documentId ||
      sender.tab?.id !== m.binding.tabId
    )
      return;
    const s = this.store.tabs.get(m.binding.tabId),
      b = s?.cp.shopping?.[m.kind];
    if (s && b && sameBinding(b, m.binding)) {
      this.close(s, m.kind);
      await this.store.save(s);
      await this.notify(s);
    }
  }
}
