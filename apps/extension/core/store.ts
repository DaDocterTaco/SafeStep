import { Checkpoint, Fault, Preferences, type PanelView } from '@safestep/contracts';
import { blank, live, type RecordState } from './state';
import { syncRegistrations } from './access';

const prefix = 'task:';
export class Store {
  tabs = new Map<number, RecordState>();
  prefs: Preferences = { largeText: false, sites: [] };
  private writes: Promise<unknown> = Promise.resolve();
  private configs: Promise<unknown> = Promise.resolve();
  async load() {
    await Promise.all([
      chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    ]);
    const [l, s] = await Promise.all([
      chrome.storage.local.get('preferences'),
      chrome.storage.session.get(null),
    ]);
    const p = Preferences.safeParse(l.preferences);
    if (p.success) this.prefs = p.data;
    for (const [key, raw] of Object.entries(s)) {
      if (!key.startsWith(prefix)) continue;
      const c = Checkpoint.safeParse(raw);
      if (c.success && key === prefix + c.data.tabId)
        this.tabs.set(c.data.tabId, { cp: c.data, snapshot: null });
    }
  }
  get(tabId: number) {
    let s = this.tabs.get(tabId);
    if (s) return s;
    if (this.tabs.size >= 64) {
      const idle = [...this.tabs.values()].find((r) => !live(r.cp.task) && !r.cp.cleanup && !r.cp.compare && !r.abortChat);
      if (!idle) throw new Fault('blocked_by_policy');
      void this.drop(idle.cp.tabId);
    }
    s = blank(tabId);
    this.tabs.set(tabId, s);
    return s;
  }
  private write(fn: () => Promise<unknown>) {
    this.writes = this.writes.catch(() => {}).then(fn);
    return this.writes;
  }
  save(s: RecordState) {
    if (this.tabs.get(s.cp.tabId) !== s) return Promise.resolve();
    const cp = structuredClone(s.cp);
    return this.write(() => chrome.storage.session.set({ [prefix + cp.tabId]: cp }));
  }
  drop(id: number) {
    this.tabs.get(id)?.abortChat?.();
    this.tabs.get(id)?.invalidateComparison?.();
    this.tabs.get(id)?.abortAssist?.();
    this.tabs.get(id)?.cancelShopping?.();
    this.tabs.delete(id);
    return this.write(() => chrome.storage.session.remove(prefix + id));
  }
  configure() {
    const p = structuredClone(this.prefs);
    this.configs = this.configs
      .catch(() => {})
      .then(async () => {
        await chrome.storage.local.set({ preferences: p });
        await syncRegistrations(p);
      });
    return this.configs;
  }
  async view(
    s: RecordState,
    t: chrome.tabs.Tab,
    site: string | null,
    access: PanelView['access'],
  ): Promise<PanelView> {
    const snapshot =
      (access === 'temporary' || access === 'site') && s.snapshot?.context.origin === site
        ? s.snapshot
        : null;
    return {
      ...(s.cp.chat ? {chat:s.cp.chat} : {}),
      tabId: t.id!,
      epoch: s.cp.epoch,
      origin: site,
      access,
      issue: s.cp.issue,
      snapshot,
      ...(s.protection && s.protection.origin===site ? {protection:s.protection} : {}),
      ...(s.comparison &&
      s.cp.compare?.origin === site &&
      (access === 'site' || access === 'temporary')
        ? { comparison: s.comparison }
        : {}),
      ...(s.cleanup &&
      (access === 'site' || access === 'temporary') &&
      s.cleanup.binding.origin === site
        ? { cleanup: s.cleanup }
        : {}),
      ...(s.shopping && (access === 'site' || access === 'temporary')
        ? {
            shopping: Object.fromEntries(
              Object.entries(s.shopping).filter(
                ([, v]) =>
                  v.data.binding.origin === site &&
                  v.data.binding.epoch === s.cp.epoch &&
                  Date.parse(v.data.captured) + 300000 > Date.now(),
              ),
            ),
          }
        : {}),
      ...(s.review &&
      s.review.binding.origin === site &&
      (access === 'temporary' || access === 'site')
        ? { review: s.review }
        : {}),
      ...(s.reviewStale ? { reviewStale: true } : {}),
      ...(snapshot && s.cue ? { cue: s.cue } : {}),
      task: s.cp.task,
      prefs: this.prefs,
    };
  }
}
