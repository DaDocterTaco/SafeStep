import {
  Fault,
  CompareView,
  Offer,
  defaultCompareSettings,
  comparisonQuestion,
  evaluateComparison,
  isCanonicalOfferUrl,
  offerKey,
  type CompareAction,
  type CompareSettings,
} from '@safestep/contracts';
import { ComparisonSource, comparisonRoute } from '../sites/comparison';
import { access, probe } from './access';
import type { Store } from './store';
import type { RecordState } from './state';
import type { Shopping } from './shopping';
import { watchComparison } from '../page/comparison-watch';
import { comparisonAI } from './comparison-ai';
import type { DestinationPreflight } from './destination-check';

const ttl = 300000;
const coverage = () => ({ searched: 0, checked: 0, excluded: 0, batches: 0, more: false });
type Owner = {
  id: string;
  canonical: string;
  window: number;
  doc: string;
  epoch: number;
  task: string | null;
  watch: string;
  variantChanged?: boolean;
  controller?: AbortController;
  opening?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  offers: Map<string, Offer>;
  seen: Set<string>;
  removed: Map<string, string>;
  missingDetails: Set<string>;
  offset: number;
};
const key = (o: Offer) => JSON.stringify([o.market, o.id, o.url, o.attributes.variant ?? '']);
type Status = CompareView['status'];
function empty(id: string, version: number, status: Status, message: string): CompareView {
  return {
    id,
    version,
    status,
    message,
    baseline: null,
    settings: defaultCompareSettings(),
    candidates: [],
    coverage: coverage(),
    at: new Date().toISOString(),
  };
}
export class Comparisons {
  private owners = new Map<number, Owner>();
  constructor(
    private store: Store,
    private shopping: Shopping,
    private preflight?: DestinationPreflight,
  ) {}
  private async publish(s: RecordState) {
    if (s.cp.compare && s.comparison?.baseline) {
      s.cp.compare.settings = s.comparison.settings;
      s.cp.compare.baselineId = s.comparison.baseline.id;
    }
    await this.store.save(s);
    await chrome.runtime.sendMessage({ channel: 'cue-updated', tabId: s.cp.tabId }).catch(() => {});
  }
  async recover(s: RecordState) {
    const c = s.cp.compare;
    if (!c) return;
    // Retire controls still painted in an open panel when the old worker exited.
    c.version++;
    s.comparison = empty(
      c.id,
      c.version,
      'paused',
      'Recovered comparison. Refresh to check the original page again.',
    );
    if (c.settings) s.comparison.settings = c.settings;
    await this.publish(s);
  }
  invalidate(s: RecordState, message: string, status: Status = 'stale') {
    const o = this.owners.get(s.cp.tabId),
      v = s.comparison;
    if (o) {
      o.opening?.abort();
      o.controller?.abort();
      o.controller = undefined;
      clearTimeout(o.timer);
    }
    if (!v) return;
    v.version++;
    if (s.cp.compare) s.cp.compare.version = v.version;
    v.status = status;
    v.message = message;
    v.explanation = [];
    delete v.explanationOffers;
    delete v.ai;
    v.candidates = v.candidates.map((c) => ({
      ...c,
      recommended: false,
      savings: null,
      savingsPercent: null,
      subtotal: null,
      reasons: [],
    }));
    void this.publish(s);
  }
  forget(s: RecordState) {
    const o = this.owners.get(s.cp.tabId);
    o?.controller?.abort();
    o?.opening?.abort();
    clearTimeout(o?.timer);
    this.owners.delete(s.cp.tabId);
    delete s.cp.compare;
    delete s.comparison;
    delete s.invalidateComparison;
  }
  pageChanged(id: string, sender: chrome.runtime.MessageSender) {
    const tab = sender.tab?.id;
    if (tab === undefined || sender.id !== chrome.runtime.id || sender.frameId !== 0) return;
    const o = this.owners.get(tab),
      s = this.store.tabs.get(tab);
    if (s && o?.watch === id && o.doc === sender.documentId) {
      o.variantChanged = true;
      this.invalidate(
        s,
        'The selected variant changed. Close this comparison and confirm the new baseline.',
      );
    }
  }
  private async watch(tab: number, doc: string, id: string, install: boolean) {
    return (
      (
        await chrome.scripting.executeScript({
          target: { tabId: tab, documentIds: [doc] },
          func: watchComparison,
          args: [id, install],
        })
      )[0]?.result === true
    );
  }
  private async valid(s: RecordState, o: Owner, v: number) {
    const t = await chrome.tabs.get(s.cp.tabId);
    if (
      !t.active ||
      t.windowId !== o.window ||
      !(await chrome.windows.get(t.windowId)).focused ||
      !t.url ||
      comparisonRoute(new URL(t.url)) !== o.canonical
    )
      throw new Fault('stale_document');
    const a = await access(s, this.store.prefs, t);
    if ((await probe(t.id!, a.site)) !== o.doc || !(await this.watch(t.id!, o.doc, o.watch, false)))
      throw new Fault('stale_document');
    if (
      this.owners.get(s.cp.tabId) !== o ||
      s.comparison?.version !== v ||
      s.cp.epoch !== o.epoch ||
      (s.cp.task?.id ?? null) !== o.task
    )
      throw new Fault('stale_document');
  }
  private source(s: RecordState, o: Owner, ctrl: AbortController) {
    const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(60000)]);
    const reservations = new Map<string, string>();
    return new ComparisonSource(new URL(o.canonical), signal, (market, kind, subject, scope) => {
      const k = JSON.stringify([market, kind, subject, scope]);
      let id = reservations.get(k);
      if (!id) {
        id = crypto.randomUUID();
        reservations.set(k, id);
      }
      return this.shopping.reserveEvidence(
        market === 'practice' ? new URL(o.canonical).origin : market,
        kind,
        subject,
        id,
        () => o.controller === ctrl && !signal.aborted,
      );
    });
  }
  private arm(s: RecordState, o: Owner) {
    clearTimeout(o.timer);
    const v = s.comparison;
    if (!v?.baseline) return;
    const expiry = Math.min(
      ...[v.baseline, ...v.candidates.map((c) => c.offer)].map((x) => Date.parse(x.captured) + ttl),
    );
    o.timer = setTimeout(
      () => {
        if (this.owners.get(s.cp.tabId) === o)
          this.invalidate(s, 'Captured information expired. Refresh to compare current evidence.');
      },
      Math.max(0, expiry - Date.now()),
    );
  }
  expire(s: RecordState) {
    const v = s.comparison;
    if (
      v?.baseline &&
      [
        'ready',
        'partial',
        'no_matches',
        'only_baseline',
        'needs_checking',
        'idle',
        'clarify',
      ].includes(v.status) &&
      [v.baseline, ...v.candidates.map((c) => c.offer)].some(
        (o) => Date.parse(o.captured) + ttl <= Date.now(),
      )
    )
      this.invalidate(s, 'Captured information expired. Refresh to compare current evidence.');
  }
  private work(
    s: RecordState,
    o: Owner,
    job: (src: ComparisonSource, version: number, signal: AbortSignal) => Promise<void>,
  ) {
    const ctrl = new AbortController();
    o.opening?.abort();
    o.controller?.abort();
    o.controller = ctrl;
    const version = s.comparison!.version;
    void (async () => {
      await this.valid(s, o, version);
      await job(this.source(s, o, ctrl), version, ctrl.signal);
    })()
      .catch((e) => {
        if (o.controller !== ctrl || ctrl.signal.aborted || s.comparison?.version !== version)
          return;
        const message =
          e instanceof Fault
            ? 'The page, access or task changed. Refresh from the original listing.'
            : e instanceof Error
              ? e.message
              : 'Source unavailable.';
        this.invalidate(
          s,
          message.slice(0, 255),
          e instanceof Fault ? 'stale' : 'source_unavailable',
        );
      })
      .finally(() => {
        if (o.controller === ctrl) o.controller = undefined;
      });
  }
  private results(s: RecordState, o: Owner) {
    const v = s.comparison!,
      b = v.baseline!;
    if (v.status === 'source_unavailable') {
      v.candidates = v.candidates.filter((candidate) => !o.removed.has(candidate.offer.id));
      return;
    }
    const assessed = evaluateComparison(
      b,
      [...o.offers.values()].filter((x) => !o.removed.has(x.id)),
      v.settings,
    );
    v.candidates = assessed
      .filter((x) => x.fit !== 'incompatible' && x.fit !== 'unavailable')
      .slice(0, 3);
    v.coverage.excluded = assessed.filter(
      (x) => x.fit === 'incompatible' || x.fit === 'unavailable',
    ).length;
    v.excludedReasons = assessed
      .filter((c) => c.fit === 'incompatible' || c.fit === 'unavailable')
      .slice(0, 6)
      .map((c) => (c.offer.title + ' · ' + (c.fitReason ?? c.fit)).slice(0, 500));
    const confirmed = v.candidates.filter((c) => c.fit === 'confirmed');
    if (o.missingDetails.size) {
      v.status = 'partial';
      v.message =
        'Some candidate details or evidence were unavailable. Only verified facts are shown.';
    } else if (confirmed.length) {
      v.status = 'ready';
      v.message = confirmed.some((x) => x.recommended)
        ? 'Choices ordered by your priorities among the checked options.'
        : 'No confirmed advantage. You can keep the original.';
    } else if (v.candidates.length) {
      v.status = 'needs_checking';
      v.message = 'Essential facts are missing. Check the listed uncertainties.';
    } else if (o.removed.size) {
      v.status = 'no_matches';
      v.message = 'No options remain to compare. You can add a removed offer or start a new search.';
    } else if (
      v.coverage.searched &&
      v.settings.mode === 'same_product_other_sellers' &&
      (!o.offers.size || [...o.offers.values()].every((x) => x.seller === b.seller))
    ) {
      v.status = 'only_baseline';
      v.message = 'Only the baseline or its seller was found. No verified other seller.';
    } else {
      v.status = 'no_matches';
      v.message = v.coverage.searched
        ? 'No suitable alternatives meet the requirements.'
        : 'No matching search results.';
    }
    this.arm(s, o);
  }
  private async prepare(s: RecordState, t: chrome.tabs.Tab, recover = false) {
    const accessNow = await access(s, this.store.prefs, t),
      url = t.url && comparisonRoute(new URL(t.url)),
      old = s.cp.compare;
    if (recover && old?.url !== url) throw new Fault('stale_document');
    this.forget(s);
    const id = crypto.randomUUID(),
      v = empty(
        id,
        (old?.version ?? 0) + 1,
        'checking_candidates',
        'Reading the current product identity…',
      );
    s.comparison = v;
    if (!url) {
      v.status = 'unsupported';
      v.message = 'Open a supported Resell listing or Mozilla Firefox catalog product.';
      s.cp.compare = { id, version: v.version, origin: accessNow.site, url: accessNow.site };
      await this.publish(s);
      return;
    }
    const doc = await probe(s.cp.tabId, accessNow.site);
    if (s.comparison !== v) throw new Fault('stale_document');
    const o: Owner = {
      id,
      window: t.windowId,
      doc,
      epoch: s.cp.epoch,
      task: s.cp.task?.id ?? null,
      canonical: url,
      watch: crypto.randomUUID(),
      offers: new Map(),
      seen: new Set(),
      removed: new Map(),
      missingDetails: new Set(),
      offset: 0,
    };
    this.owners.set(s.cp.tabId, o);
    s.cp.compare = { id, version: v.version, origin: accessNow.site, url };
    s.invalidateComparison = () =>
      this.invalidate(s, 'The owning task changed. Refresh or start from the current product.');
    await this.watch(s.cp.tabId, doc, o.watch, true);
    await this.publish(s);
    this.work(s, o, async (src, version) => {
      const b = Offer.parse(await src.baseline(new URL(url)));
      await this.valid(s, o, version);
      if (recover && old?.baselineId && old.baselineId !== b.id) throw new Fault('stale_document');
      v.baseline = b;
      v.settings = recover && old?.settings ? old.settings : defaultCompareSettings(b);
      v.at = b.captured;
      v.status = 'idle';
      v.message = 'Confirm the mode, requirements and public search terms.';
      this.arm(s, o);
      await this.publish(s);
    });
  }
  async operate(s: RecordState, t: chrome.tabs.Tab, a: CompareAction) {
    if (a.op === 'prepare') return this.prepare(s, t);
    const v = s.comparison,
      o = this.owners.get(s.cp.tabId);
    if (!v || v.id !== a.session || v.version !== a.version) throw new Fault('stale_document');
    if (a.op === 'clear') {
      this.forget(s);
      await this.publish(s);
      return;
    }
    if (a.op === 'cancel') {
      this.invalidate(s, 'Comparison cancelled. No pending search will be replayed.', 'cancelled');
      return;
    }
    if (!o || !v.baseline) {
      if (a.op === 'refresh') return this.prepare(s, t, true);
      throw new Fault('stale_document');
    }
    if (a.op === 'refresh' && ['stale', 'paused'].includes(v.status)) {
      if (o.variantChanged) throw new Fault('stale_document');
      if (!t.url || comparisonRoute(new URL(t.url)) !== o.canonical)
        throw new Fault('stale_document');
      const doc = await probe(t.id!, new URL(o.canonical).origin);
      o.doc = doc;
      o.task = s.cp.task?.id ?? null;
      o.epoch = s.cp.epoch;
      o.watch = crypto.randomUUID();
      await this.watch(t.id!, doc, o.watch, true);
    } else await this.valid(s, o, v.version);
    if (v.version !== a.version) throw new Fault('stale_document');
    this.expire(s);
    if (['stale', 'paused'].includes(v.status) && a.op !== 'refresh')
      throw new Fault('stale_document');
    if (a.op === 'open' || a.op==='openSource') {
      const offers=[v.baseline, ...v.candidates.map((c) => c.offer)];
      let url:string;
      if(!('url' in a)){
        const offer=offers.find(x=>x.id===a.id);
        if(!offer || !isCanonicalOfferUrl(offer.url) || Date.parse(offer.captured)+ttl<=Date.now())
          throw new Fault('blocked_by_policy');
        url=offer.url;
      }else{
        const supplied=[v.searchSource,...offers.filter(x=>Date.parse(x.captured)+ttl>Date.now()).flatMap(x=>[x.sellerEvidence?.source,x.productEvidence?.source])];
        if(!supplied.includes(a.url))throw new Fault('stale_document');
        url=a.url;
      }
      if(this.preflight) {
        o.opening?.abort();
        const controller=new AbortController();
        o.opening=controller;
        try {
          const check=await this.preflight(s,t,{kind:a.op==='open'?'offer':'source',url,documentId:o.doc},controller.signal);
          if(!check.allow || controller.signal.aborted) {
            if(o.opening===controller && !controller.signal.aborted && s.comparison===v && v.version===a.version) {
              v.message=check.reason??'The offer URL could not be checked. Take over manually.';
              await this.publish(s);
            }
            return;
          }
        }finally{if(o.opening===controller)o.opening=undefined;}
      }
      await this.valid(s, o, a.version);
      await chrome.tabs.create({ windowId: o.window, url, active: true });
      return;
    }
    o.controller?.abort();
    o.controller = undefined;
    v.version++;
    s.cp.compare!.version = v.version;
    delete v.ai;
    v.explanation = [];
    delete v.explanationOffers;
    if (a.op === 'sort') {
      v.settings = { ...v.settings, priorities: a.priorities };
      this.results(s, o);
      await this.publish(s);
      return;
    }
    if (a.op === 'remove') {
      for (const [key, x] of o.offers)
        if (x.id === a.id) {
          o.removed.set(a.id, x.url);
          o.offers.delete(key);
          o.seen.delete(x.url);
        }
      this.results(s, o);
      await this.publish(s);
      return;
    }
    if (a.op === 'keep') {
      v.status = 'idle';
      v.message = 'Kept the original product.';
      v.candidates = [];
      o.offers.clear();
      await this.publish(s);
      return;
    }
    if ('settings' in a) {
      const keepSelection =
        v.settings.mode === 'compare_selected' && a.settings.mode === 'compare_selected';
      v.settings = a.settings;
      v.candidates = [];
      delete v.searchSource;
      v.excludedReasons = [];
      v.coverage = coverage();
      if (!keepSelection) o.offers.clear();
      o.seen.clear();
      // Explicit removals persist across refinements and refreshes in this
      // comparison. The user can still explicitly add that offer back.
      o.missingDetails.clear();
      o.offset = 0;
    }
    if (a.op === 'edit') {
      v.status = 'idle';
      v.message = 'Requirements changed. Run Find options to check them.';
      await this.publish(s);
      return;
    }
    if (a.op === 'explain' || a.op === 'interpret') {
      const operation = a.op;
      const previous = v.status;
      v.ai = 'Asking Gemini…';
      await this.publish(s);
      this.work(s, o, async (_src, ver, signal) => {
        try {
          const result = await comparisonAI(operation, v, signal);
          await this.valid(s, o, ver);
          if (result.settings) {
            v.settings = result.settings;
            v.status = 'idle';
          } else v.status = previous;
          v.explanation = result.reasons;
          v.explanationOffers = result.offerIds;
          v.ai = result.message;
        } catch (e) {
          if (signal.aborted || v.version !== ver) return;
          v.ai = e instanceof Error ? e.message : 'Gemini unavailable.';
        }
        await this.publish(s);
      });
      return;
    }
    if (a.op === 'more' && (!v.coverage.more || v.coverage.batches >= 3))
      throw new Fault('blocked_by_policy');
    if (a.op === 'add' && o.offers.size >= 3 && v.settings.mode === 'compare_selected') {
      v.message = 'Remove an option before adding another.';
      await this.publish(s);
      return;
    }
    const question=comparisonQuestion(v.settings);
    if(question){v.status='clarify';v.message=question;await this.publish(s);return;}
    if (
      (a.op === 'find' || a.op === 'more') &&
      v.settings.mode !== 'compare_selected' &&
      !v.settings.query.trim()
    ) {
      v.status = 'clarify';
      v.message = 'Enter public search terms for this product.';
      await this.publish(s);
      return;
    }
    if (v.settings.mode === 'similar_products' && !v.settings.allowedDifferences.length) {
      v.status = 'clarify';
      v.message = 'Specify which differences are acceptable for similar products.';
      await this.publish(s);
      return;
    }
    const refresh = a.op === 'refresh',
      selected = a.op === 'add';
    v.status = 'searching';
    v.message = refresh ? 'Refreshing prices and evidence…' : 'Checking supported offers…';
    await this.publish(s);
    this.work(s, o, async (src, ver) => {
      if (refresh) {
        const b = Offer.parse(await src.baseline(new URL(o.canonical)));
        await this.valid(s, o, ver);
        if (
          offerKey(b) !== offerKey(v.baseline!) ||
          b.catalog !== v.baseline!.catalog ||
          b.quantity !== v.baseline!.quantity ||
          b.url !== v.baseline!.url
        )
          throw new Fault('stale_document');
        v.baseline = b;
        v.coverage = coverage();
        o.seen.clear();
        o.offset = 0;
        if (v.settings.mode !== 'compare_selected') o.offers.clear();
      }
      const b = v.baseline!;
      const missingDetails = new Set(refresh ? [] : o.missingDetails);
      let urls: string[] = [];
      if (selected) urls = [a.url];
      else if (v.settings.mode === 'compare_selected') {
        urls = refresh ? [...Array.from(o.offers.values(), (x) => x.url), ...o.missingDetails] : [];
        if (refresh) o.offers.clear();
      } else {
        const batch = await src.search(v.settings, o.offset);
        await this.valid(s, o, ver);
        v.searchSource = batch.source;
        v.coverage.searched += batch.returned;
        o.offset += batch.returned;
        v.coverage.batches++;
        v.coverage.more = batch.hasMore && batch.returned > 0 && v.coverage.batches < 3;
        urls = batch.urls;
      }
      v.status = 'checking_candidates';
      await this.publish(s);
      let checked = 0;
      const removedURLs = new Set(o.removed.values());
      for (const raw of new Set(urls)) {
        if (raw === b.url || (!selected && removedURLs.has(raw)) || checked >= 6) continue;
        if (o.seen.has(raw) && (!selected || [...o.offers.values()].some((x) => x.url === raw)))
          continue;
        checked++;
        o.seen.add(raw);
        try {
          const offer = Offer.parse(await src.offer(new URL(raw)));
          await this.valid(s, o, ver);
          missingDetails.delete(raw);
          if (offer.market !== b.market || (offer.id === b.id && offer.url === b.url)) continue;
          if (selected) o.removed.delete(offer.id);
          else if (o.removed.has(offer.id)) continue;
          o.offers.set(key(offer), offer);
        } catch (e) {
          if (e instanceof Fault) throw e;
          missingDetails.add(raw);
        }
      }
      await this.valid(s, o, ver);
      o.missingDetails = missingDetails;
      v.coverage.checked += checked;
      v.at = new Date().toISOString();
      this.results(s, o);
      await this.publish(s);
    });
  }
}
