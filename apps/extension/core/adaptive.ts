import {
  Fault,
  AssistPageReply,
  AssistNotice,
  AssistReply,
  generationLimitMessage,
  checkedIntent,
  checkedStep,
  parseWire,
  bounds,
  privateText,
  publicSearchQuery,
  wikipediaSearchUrl,
  articleMatchesQuery,
  wikiCitationPage,
  wikiCitationSubject,
  wikiCurrentSection,
  wikiExportGoal,
  catalogGoal,
  publisherBrowseGoal,
  localPilotStep,
  pilotCandidates,
  catalogReadyForPlan,
  wikipediaArticlePrefix,
  returnToCatalog,
  publicCatalogPath,
  publicPath,
  profileForPage,
  validAssistInput,
  sameBinding,
  type AssistBinding,
  type AssistPage,
  type AssistSnapshot,
  type PublicRef,
  type Intent,
  type Step,
  type IntentInput,
  type StepInput,
  type TaskSession,
  type FileProfile,
} from '@safestep/contracts';
import { access, probe, bridgeFile } from './access';
import { advance, type RecordState } from './state';
import type { Store } from './store';
import {
  isPublisherTerminal,
  publisherStep,
  publisherGoal,
  publisherInformationTarget,
} from '../sites/publisher-goal';
import { boundedResponseText } from './bounded-response';
import { pendingWikipediaArticle } from './wikipedia-handoff';
import type {DestinationPreflight} from './destination-check';
type Run = {
  abort: AbortController;
  b?: AssistBinding;
  snap?: AssistSnapshot;
  selected?: PublicRef;
  expected?: string;
  from?: string;
  arrived?: string;
  arrivalDocument?: string;
  inspectArrival?: boolean;
  recoveredTarget?: boolean;
  verifyingLocal?: boolean;
  userSelection?: string;
  normalizationTimer?: ReturnType<typeof setTimeout>;
  visited: Set<string>;
  searchDocument?: string;
  settling?: boolean;
  reveal?: { path: string; doc: string };
  waiting?: boolean;
  transition?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  history: string[];
  local: boolean;
};

// Wait only while an observed condition is missing. Pause/Stop invalidates the
// wait immediately, including one already waiting for a late disclosure.
function nextObservation(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(Error('The operation changed.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function facts(snap: AssistSnapshot) {
  return JSON.stringify([snap.path, snap.complete, ...[...snap.headings, ...snap.controls].map(
    ({ref: _ref, ...fact}) => fact
  )]);
}
export function localSiteGoal(profile:AssistSnapshot['profile'],goal:string){
  if(/\b(?:not|without|except|exclude|never|instead of)\b/i.test(goal))return false;
  return (profile==='catalog' && /\b(?:find|browse|search|show|open|locate|filter|load|see)\b/i.test(goal)) ||
    (profile==='storefront' && returnToCatalog(goal)) ||
    (profile==='publisher' && !!publisherBrowseGoal(goal)) ||
    (profile==='wikipedia' && !!(wikiCitationSubject(goal)||wikiCurrentSection(goal)||wikiExportGoal(goal)||
      wikipediaArticlePrefix(goal)));
}
// Observed search result article commit and same-document cleanup, see the
// builder's article-query receipt. Unknown provenance stays outside the policy.
const wikipediaArticleProvenance = new Set(['srpw1_0']);
export const settingsGoal = (g: string) =>
  /^(?:please )?(?:find|show|open|go to|navigate to) (?:me )?(?:the |my )?username(?: settings?| section)?[.!?]?$/i.test(
    g.trim(),
  );
const statusText: Record<string, string> = {
  not_configured:
    'Gemini is not configured. Connect the local AI service or use manual inspection.',
  unauthorized: 'AI pairing expired. Reconnect the local service.',
  rate_limited: 'AI request limit reached. Retry later.',
  invalid_response: 'The proposed response did not match the goal or this page.',
  timeout: 'The AI request timed out. Retry or take over.',
  unavailable: 'AI service unavailable. Retry or take over.',
};
export class AdaptiveNavigation {
  private runs = new Map<number, Run>();
  private trails = new Map<number,{catalog:string;tenant:string;expires:number}>();
  private sequence = 0;
  constructor(
    private store: Store,
    private finishDownload?: (
      s: RecordState,
      tab: chrome.tabs.Tab,
      profile: FileProfile,
    ) => Promise<boolean>,
    private destinationPreflight?: DestinationPreflight,
  ) {}
  private seq() {
    return (this.sequence = Math.max(this.sequence + 1, Date.now() * 1000));
  }
  private live(s: RecordState, r: Run) {
    if (r.abort.signal.aborted || this.runs.get(s.cp.tabId) !== r || !s.cp.task?.adaptive)
      throw Error('The operation changed.');
  }
  private async publish(s: RecordState) {
    await this.store.save(s);
    await chrome.runtime.sendMessage({ channel: 'cue-updated', tabId: s.cp.tabId }).catch(() => {});
  }
  private async send(b: AssistBinding, cmd: AssistPage['cmd']) {
    const requestId = crypto.randomUUID();
    const raw = await chrome.tabs
      .sendMessage(
        b.tabId,
        { channel: 'assist-page', requestId, binding: b, cmd },
        { documentId: b.documentId },
      )
      .catch(() => null);
    const p = parseWire(AssistPageReply, raw);
    if (
      !p ||
      p.requestId !== requestId ||
      !sameBinding(p.binding, b) ||
      p.binding.goalVersion !== b.goalVersion ||
      p.binding.windowId !== b.windowId ||
      !p.ok
    )
      throw Error(p?.error ?? 'The page changed. Inspect again.');
    return p.snapshot;
  }
  private retire(s: RecordState) {
    const r = this.runs.get(s.cp.tabId);
    if (r) {
      r.abort.abort();
      clearTimeout(r.timer);
      clearTimeout(r.normalizationTimer);
      this.runs.delete(s.cp.tabId);
      if (r.b) void this.send({ ...r.b, generation: this.seq() }, { op: 'clear' }).catch(() => {});
    }
    delete s.abortAssist;
  }
  private createRun(s: RecordState) {
    this.retire(s);
    const r: Run = {
      abort: new AbortController(),
      history: [],
      visited: new Set(),
      local:
        (s.cp.task?.adaptive?.profile === 'practice' && settingsGoal(s.cp.task.goal)) ||
        (!!s.cp.task?.adaptive?.intent && s.cp.task.adaptive.calls===0 &&
          localSiteGoal(s.cp.task.adaptive.profile,s.cp.task.goal)) ||
        (!!s.cp.task?.adaptive?.download &&
          s.cp.task.adaptive.calls === 0 &&
          !!s.cp.task.adaptive.intent),
    };
    this.runs.set(s.cp.tabId, r);
    s.abortAssist = () => this.retire(s);
    return r;
  }
  pause(s: RecordState, why: string, state: TaskSession['state'] = 'paused') {
    if (!s.cp.task?.adaptive) return Promise.resolve();
    const t = s.cp.task,
      a = t.adaptive!;
    this.retire(s);
    advance(s);
    t.state = state;
    t.cancelled = state === 'cancelled';
    a.authorized = false;
    a.status = why;
    if (a.journal && ['claimed', 'dispatched'].includes(a.journal.state))
      a.journal.state = 'uncertain';
    return this.publish(s);
  }
  private async active(s: RecordState, r: Run) {
    this.live(s, r);
    const t = await chrome.tabs.get(s.cp.tabId);
    if (!t.active || t.windowId !== s.windowId || !(await chrome.windows.get(t.windowId)).focused)
      throw Error('The active tab or window changed.');
    const a = await access(s, this.store.prefs, t);
    if (a.site !== s.cp.task!.adaptive!.origin)
      throw Error('Website changed. Start a new task on that site.');
    this.live(s, r);
    return t;
  }
  private async inspect(s: RecordState, r: Run, terms: string[] = []) {
    const tab = await this.active(s, r),
      t = s.cp.task!,
      a = t.adaptive!;
    const url = tab.url && new URL(tab.url);
    const expectedPath = url && publicPath(url, a.profile);
    if (!url || !expectedPath || (a.profile === 'catalog' && url.searchParams.has('q') &&
      url.searchParams.get('q')!==catalogGoal(t.goal).query) ||
      (a.profile === 'wikipedia' && url.pathname === '/w/index.php' && !wikiCitationPage(url) &&
      !wikipediaSearchUrl(url, a.searchQuery ?? publicSearchQuery(t.goal) ?? '')))
      throw Error('This page is outside the approved public route. Take over or start a new task.');
    const doc = await probe(t.tabId, a.origin);
    this.live(s, r);
    if (r.arrivalDocument && doc !== r.arrivalDocument)
      throw Error('The document was replaced. Inspect fresh controls.');
    await chrome.scripting.executeScript({
      target: { tabId: t.tabId, documentIds: [doc] },
      files: [bridgeFile],
    });
    this.live(s, r);
    const b: AssistBinding = {
      operationId: crypto.randomUUID(),
      taskId: t.id,
      tabId: t.tabId,
      windowId: tab.windowId,
      goalVersion: a.version,
      origin: a.origin,
      documentId: doc,
      epoch: s.cp.epoch,
      revision: crypto.randomUUID(),
      generation: this.seq(),
    };
    r.b = b;
    t.documentId = doc;
    t.revision = b.revision;
    s.cp.knownOrigin = a.origin;
    const snap = await this.send(b, { op: 'inspect', goal: t.goal, terms });
    this.live(s, r);
    if (!snap || snap.profile !== a.profile || snap.path !== expectedPath || r.b !== b)
      throw Error('The current public document changed.');
    r.snap = snap;
    return snap;
  }
  private async inspectReadyArrival(s: RecordState, r: Run, terms: string[]) {
    // Two agreeing public observations in the committed top document protect
    // the first planning request from empty or partially hydrated results.
    const deadline = Date.now() + 2500;
    let previous: string | undefined;
    do {
      const snap = await this.inspect(s, r, terms);
      const resultList = snap.profile === 'wikipedia' && snap.path === '/wiki/Special:Search';
      const ready = snap.profile==='catalog'?catalogReadyForPlan(s.cp.task!.goal,snap):!!snap.complete || (resultList
        ? snap.controls.some(c => (c.action === 'activate_readonly_link' && c.path?.startsWith('/wiki/')) ||
            (!r.searchDocument && c.action==='submit_public_search'))
        : snap.controls.length + snap.headings.length > 0);
      const observed = facts(snap);
      if (ready && previous === observed) {
        r.inspectArrival = false;
        return snap;
      }
      previous = observed;
      await nextObservation(r.abort.signal, 100);
    } while (Date.now() < deadline);
    throw Error('The destination opened, but its public controls did not settle. Resume for a fresh inspection or take over.');
  }
  private async confirmSnapshot(s: RecordState, r: Run) {
    const a = s.cp.task!.adaptive!, tab = await this.active(s,r);
    const u = tab.url && new URL(tab.url);
    if (!u || !r.b || !r.snap || publicPath(u,a.profile) !== r.snap.path ||
      (a.profile==='catalog' && u.searchParams.has('q') && u.searchParams.get('q')!==catalogGoal(s.cp.task!.goal).query) ||
      (a.profile === 'wikipedia' && u.pathname === '/w/index.php' && !wikiCitationPage(u) &&
        !wikipediaSearchUrl(u,a.searchQuery ?? publicSearchQuery(s.cp.task!.goal) ?? '')) ||
      (await probe(s.cp.tabId,a.origin)) !== r.b.documentId)
      throw Error('The page changed. Inspect the current document again.');
    this.live(s,r);
  }
  private async request(
    s: RecordState,
    r: Run,
    input: IntentInput | StepInput,
  ): Promise<Intent | Step> {
    const t = s.cp.task!,
      a = t.adaptive!;
    if (!validAssistInput(input))
      throw Error('The request cannot be safely shared. Rephrase the goal.');
    if (Date.now() - a.since > bounds.wall || a.calls >= bounds.calls)
      throw Error('The task time or model-call limit was reached.');
    const token = (await chrome.storage.session.get('local-ai-session'))['local-ai-session'];
    this.live(s, r);
    if (typeof token !== 'string' || !/^ss3_[A-Za-z0-9_-]{43}$/.test(token))
      throw Error(statusText.not_configured);
    a.calls++;
    await this.publish(s);
    this.live(s, r);
    const response = await fetch('http://127.0.0.1:4317/v1/assist/' + input.kind, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([r.abort.signal, AbortSignal.timeout(13000)]),
    });
    this.live(s, r);
    if (!response.ok)
      throw Error(response.status === 403 ? statusText.unauthorized : statusText.unavailable);
    const data=await boundedResponseText(response,bounds.responseBytes,statusText.invalid_response ?? 'Invalid navigation reply.');
    const reply = parseWire(AssistReply, JSON.parse(data));
    this.live(s, r);
    if (
      !reply ||
      reply.operationId !== input.operationId ||
      reply.bindingToken !== input.bindingToken ||
      r.b?.revision !== input.binding.revision
    )
      throw Error('Stale AI response.');
    if (reply.status !== 'available') {
      throw Error((reply.status === 'rate_limited' && reply.limitReason && generationLimitMessage(reply.limitReason)) || statusText[reply.status] || 'AI unavailable.');
    }
    const valid =
      input.kind === 'intent'
        ? checkedIntent(reply.explanation, input.goal)
        : checkedStep(reply.explanation, input);
    if (!valid) throw Error(statusText.invalid_response);
    await this.confirmSnapshot(s,r);
    return valid;
  }
  private envelope(s: RecordState, r: Run) {
    const b = r.b!,
      a = s.cp.task!.adaptive!;
    return {
      operationId: b.operationId,
      bindingToken: b.revision,
      binding: b,
      goal: s.cp.task!.goal,
      profile: a.profile,
      ...(a.download ? { download: a.download } : {}),
    };
  }
  private launch(s: RecordState, r: Run, fn: () => Promise<void>) {
    void fn().catch((e) => {
      if (this.runs.get(s.cp.tabId) === r)
        void this.pause(
          s,
          String(e instanceof Error ? e.message : 'Inspection failed.').slice(0, 175),
        );
    });
  }
  async begin(s: RecordState, tab: chrome.tabs.Tab, raw: string, download?: FileProfile, localPublisher = false) {
    const accessNow = await access(s, this.store.prefs, tab),
      u = new URL(tab.url!),
      p = profileForPage(u);
    const version = (s.cp.task?.adaptive?.version ?? 0) + 1,
      epoch = advance(s),
      sensitive = privateText(raw);
    const t: TaskSession = {
      id: crypto.randomUUID(),
      tabId: s.cp.tabId,
      epoch,
      goal: sensitive ? 'Restate the goal without private information.' : raw,
      mode: 'guide',
      state: 'planning',
      steps: 0,
      lastVerified: null,
      cancelled: false,
      documentId: null,
      revision: null,
      adaptive: {
        version,
        profile: p,
        ...(download ? { download } : {}),
        origin: accessNow.site,
        since: Date.now(),
        calls: 0,
        noProgress: 0,
        authorized: false,
        intent: null,
        status: 'Understanding your goal…',
        journal: null,
      },
    };
    s.cp.task = t;
    s.windowId = tab.windowId;
    s.cp.issue = null;
    if (
      sensitive ||
      !publicPath(u, p) ||
      (/\b(?:on|at|from|visit|open)\s+(?:the\s+)?(?:MDN|developer\.mozilla\.org)\b/i.test(raw) &&
        p !== 'mdn') ||
      (/\b(?:Python tutorial|Python documentation|docs\.python\.org)\b/i.test(raw) &&
        p !== 'python') ||
      (/\b(?:on|at|from|visit|open)\s+(?:the\s+)?Wikipedia\b/i.test(raw) && p !== 'wikipedia') ||
      (/\b(?:on|at|from|visit|open)\s+(?:the\s+)?VideoLAN\b/i.test(raw) &&
        u.hostname !== 'www.videolan.org') ||
      /\b(?:on|at|from|visit|open)\s+(?:the\s+)?(?:eBay|Amazon|Roblox)\b/i.test(raw) ||
      (download && p !== 'publisher' && !isPublisherTerminal(u, download))
    ) {
      return this.pause(
        s,
        sensitive
          ? 'Restate the goal without a password, token or private URL.'
          : 'Open the requested supported public page, then submit this same goal.',
      );
    }
    const r = this.createRun(s);
    r.arrived = publicPath(u, p) ?? undefined;
    await this.publish(s);
    this.launch(s, r, async () => {
      await this.inspect(s, r);
      if (download||localSiteGoal(p,raw))
        r.local =
          localPublisher || typeof (await chrome.storage.session.get('local-ai-session'))['local-ai-session'] !==
          'string';
      this.live(s, r);
      const intent: Intent =
        r.local && (download||localSiteGoal(p,raw))
          ? publisherGoal(raw)
          : r.local
            ? {
                action: 'navigate_settings',
                subjects: [{ start: 0, end: raw.length, text: raw }],
                constraints: [],
                excluded: [],
                question: '',
                choices: [],
              }
            : ((await this.request(s, r, { ...this.envelope(s, r), kind: 'intent' })) as Intent);
      this.live(s, r);
      t.adaptive!.intent = intent;
      if (p === 'wikipedia') t.adaptive!.searchQuery = publicSearchQuery(raw) ?? undefined;
      if (p === 'catalog') t.adaptive!.searchQuery = catalogGoal(raw).query ?? undefined;
      t.state = 'awaiting_confirmation';
      t.adaptive!.status = (
        intent.question ||
        (r.local
          ? download
            ? 'Local publisher guide · '
            : p==='practice'?'Local practice guide · ':'Current public site controls · '
          : 'Understood · ') + raw
      ).slice(0, 180);
      await this.publish(s);
    });
  }
  private practiceStep(snap: AssistSnapshot): Step {
    const target = ['Username', 'Account settings']
      .map((name) => snap.controls.find((c) => c.label === name))
      .find(Boolean);
    return target
      ? { kind: 'next_candidate', ref: target.ref, action: target.action, citations: [target.ref] }
      : { kind: 'cannot_continue', reason: 'missing_target' };
  }
  private async plan(s: RecordState, r: Run, settledDisclosure?: AssistSnapshot) {
    const t = s.cp.task!,
      a = t.adaptive!;
    if (!a.intent || ['clarify', 'unsupported'].includes(a.intent.action))
      throw Error('Clarify the original goal first.');
    if (Date.now() - a.since > bounds.wall || t.steps >= bounds.steps)
      throw Error('The task step or time limit was reached.');
    t.state = 'planning';
    a.status = 'Finding the next step…';
    r.selected = undefined;
    r.expected = undefined;
    r.waiting = false;
    let terms = r.recoveredTarget ? a.intent.subjects.map(p=>p.text.slice(0,65)).slice(0,3) : [];
    for (let n = 0; n <= bounds.lookups; n++) {
      const snap = n===0 && settledDisclosure && r.snap===settledDisclosure
        ? settledDisclosure
        : r.inspectArrival ? await this.inspectReadyArrival(s,r,terms) : await this.inspect(s,r,terms);
      if(snap.ambiguity){
        const choices=snap.ambiguity.slice(0,3).join(', ').slice(0,110);
        await this.pause(s,'Wikipedia lists several meanings. Which article do you want?'+(choices?' '+choices+'.':''));
        return;
      }
      const publisherTab = a.download ? await this.active(s, r) : null;
      if (
        a.download &&
        publisherTab?.url &&
        isPublisherTerminal(new URL(publisherTab.url), a.download)
      ) {
        const tab = publisherTab,
          doc = r.b!.documentId;
        const ready = await this.finishDownload?.(s, tab, a.download);
        this.live(s, r);
        await this.active(s, r);
        if (!ready || (await probe(t.tabId, a.origin)) !== doc)
          throw Error(
            'A unique current publisher download could not be verified. Check the package and alternatives.',
          );
        this.live(s, r);
        t.state = 'completed';
        a.authorized = false;
        a.status =
          'Verified the publisher download control. Review the highlighted package and choose whether to download it.';
        if (a.journal) a.journal.state = 'verified';
        this.retire(s);
        await this.publish(s);
        return;
      }
      if (snap.complete) {
        await this.confirmSnapshot(s,r);
        t.state = 'completed';
        a.status = 'Reached ' + snap.complete;
        a.authorized = false;
        if (a.journal) a.journal.state = 'verified';
        this.retire(s);
        await this.publish(s);
        return;
      }
      const input: StepInput = {
        ...this.envelope(s, r),
        kind: 'step',
        intent: a.intent,
        snapshot: snap,
        previous: r.history.slice(-8),
      };
      const d = r.local
        ? a.download
          ? publisherStep(snap, a.download)
          : a.profile==='practice'?this.practiceStep(snap):localPilotStep(t.goal,snap)
        : ((await this.request(s, r, input)) as Step);
      this.live(s, r);
      if (d.kind === 'need_more_controls') {
        if (n === bounds.lookups) throw Error('Bounded lookup exhausted. Inspect or take over.');
        terms = d.terms;
        continue;
      }
      if (d.kind === 'completion_candidate') {
        if (a.profile !== 'experimental')
          throw Error('The requested document and visible section have not been verified.');
        t.state = 'awaiting_confirmation';
        a.authorized = false;
        a.status = 'Confirm that this is the requested destination.';
        await this.publish(s);
        return;
      }
      if (d.kind === 'clarify' || d.kind === 'cannot_continue')
        throw Error(
          d.kind === 'clarify' ? d.question : 'Needs your action: ' + d.reason.replaceAll('_', ' '),
        );
      const target = [...snap.headings, ...snap.controls].find((c) => c.ref === d.ref);
      if (!target || target.action !== d.action) throw Error('Unknown target. Inspect again.');
      if(a.profile==='catalog' || a.profile==='storefront' || wikiCitationSubject(t.goal) || wikiCurrentSection(t.goal) || wikiExportGoal(t.goal) ||
         (a.profile==='publisher' && !a.download && publisherBrowseGoal(t.goal))) {
        const allowed=pilotCandidates(t.goal,snap);
        if(allowed && !allowed.some(c=>c.ref===target.ref))
          throw Error('That control does not match the current site, goal and constraints. Take over or clarify.');
      }
      if (
        a.download &&
        target.path &&
        !publisherInformationTarget(new URL(target.path, a.origin), a.download)
      )
        throw Error('This target is outside the requested publisher information route.');
      if (
        target.action === 'submit_public_search' &&
        (!a.searchQuery || a.searchQuery !== (a.profile==='catalog'?catalogGoal(t.goal).query:publicSearchQuery(t.goal)))
      )
        throw Error('Confirm a short, public search query before proceeding.');
      const named = /\bArray(?:\.prototype)?\.(map|filter)\b/i.exec(
        t.goal.split(/\b(?:not|without|except)\b/i)[0]!,
      );
      const method = target.path && /\/Global_Objects\/Array\/([a-z_]+)(?:#|$)/i.exec(target.path);
      if (
        a.profile === 'mdn' &&
        named &&
        method &&
        named[1]!.toLowerCase() !== method[1]!.toLowerCase()
      )
        throw Error('The suggested method differs from the requested subject.');
      const words = (target.label + ' ' + (target.path ?? '')).toLowerCase().split(/[^a-z0-9]+/);
      if (
        a.intent.excluded.some((x) =>
          x.text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .some((word) => word.length >= 3 && words.includes(word)),
        )
      )
        throw Error('Suggested target conflicts with an exclusion in your goal.');
      if (
        a.journal?.state === 'uncertain' &&
        a.journal.from === snap.path &&
        a.journal.to === (target.path ?? snap.path) &&
        a.authorized
      )
        throw Error('The prior action is uncertain. Take over before another activation.');
      r.selected = target;
      r.from = snap.path;
      r.expected = target.path ?? snap.path;
      await this.checkDestination(s,r,target);
      const visit = JSON.stringify([snap.path, target.action, target.label, target.path, target.expanded]);
      if (r.visited.has(visit))
        throw Error('This same step was already verified on this page. Take over or choose a different goal.');
      try {
        await this.send(r.b!, { op: 'cue', ref: target.ref, action: target.action, scroll: false });
      } catch (e) {
        // A rejected cue cannot have activated anything. Never retry a claimed
        // activation. A fresh inspection can propose an entirely new control.
        await this.confirmSnapshot(s,r);
        if (await this.reinspectTarget(s,r)) return;
        throw e;
      }
      this.live(s, r);
      a.status = (
        target.action === 'submit_public_search'
          ? 'Search '+(a.profile==='catalog'?'the marketplace':'Wikipedia')+' for “' + a.searchQuery + '” using its public search field.'
          : target.action==='identify_article_export'
            ? 'Wikipedia’s PDF export control for this article is outlined. You choose whether to open it.'
          : target.action==='handoff_storefront'
            ? 'Open the outlined listing on '+new URL(target.targetOrigin!).hostname+' yourself. Click SafeStep there to grant access, then check this seller or compare this offer.'
          : target.action==='handoff_catalog'
            ? 'The outlined Shop link goes to the public marketplace on resell.store. Choose it yourself and grant access on arrival.'
          : target.role === 'heading'
            ? 'Reveal the observed section: ' + target.label
            : target.label +
              ' is a current ' +
              target.role +
              (target.path ? ' to ' + target.path : '.')
      ).slice(0, 180);
      t.state = 'showing_step';
      if(target.action==='handoff_storefront'||target.action==='handoff_catalog'||target.action==='identify_article_export'){
        a.authorized=false;t.mode='guide';
        if(target.action==='handoff_catalog'){
          const trail=this.trails.get(t.tabId);
          const tab=await this.active(s,r);
          if(trail && trail.expires>Date.now() && trail.tenant===tab.url) a.returnUrl=trail.catalog;
          else if(/prior|earlier|previous|filtered/i.test(t.goal))
            a.status='This Shop link returns to the unfiltered marketplace. No earlier verified results are bound to this tab; use Chrome Back if you want them.';
        }
      }
      await this.publish(s);
      if (a.authorized) await this.dispatch(s, r);
      return;
    }
  }
  private async checkDestination(s:RecordState,r:Run,target:PublicRef){
    if(!this.destinationPreflight)return;
    const a=s.cp.task!.adaptive!, b=r.b!;
    let url:URL|null=null;
    if(target.path)url=new URL(target.path,target.targetOrigin??a.origin);
    else if(target.action==='submit_public_search' && a.profile==='wikipedia' && a.searchQuery){
      url=new URL('/w/index.php',a.origin);url.searchParams.set('search',a.searchQuery);url.searchParams.set('title','Special:Search');
    }
    if(!url)return;
    const tab=await this.active(s,r);
    const verdict=await this.destinationPreflight(s,tab,{kind:target.action==='handoff_storefront'?'offer':target.action==='identify_article_export'?'download':'navigation',
      url:url.href,documentId:b.documentId},r.abort.signal);
    await this.confirmSnapshot(s,r);
    if(!verdict.allow)throw Error(verdict.reason??'This destination needs your attention before navigation.');
  }
  private async reinspectTarget(s: RecordState, r: Run) {
    const a=s.cp.task!.adaptive!;
    if (r.recoveredTarget || r.waiting || (a.journal && a.journal.state !== 'verified')) return false;
    const fresh=this.createRun(s);
    fresh.recoveredTarget=true;
    fresh.history=r.history.slice();
    fresh.visited=new Set(r.visited);
    fresh.arrived=r.arrived ?? r.snap?.path;
    fresh.arrivalDocument=r.b?.documentId;
    fresh.searchDocument=r.searchDocument;
    fresh.inspectArrival=true;
    a.status='The page controls changed. Reading them again for your original goal…';
    await this.publish(s);
    this.launch(s,fresh,()=>this.plan(s,fresh));
    return true;
  }
  private markVerified(r: Run, target: PublicRef) {
    r.visited.add(JSON.stringify([r.from,target.action,target.label,target.path,target.expanded]));
    r.history.push(target.label);
    r.recoveredTarget=false;
    r.userSelection=undefined;
    clearTimeout(r.normalizationTimer);
    r.normalizationTimer=undefined;
  }
  private async dispatch(s: RecordState, r: Run) {
    const t = s.cp.task!,
      a = t.adaptive!,
      b = r.b!,
      target = r.selected!;
    if (!a.authorized || r.waiting)
      throw Error('Automatic navigation needs explicit permission for this task.');
    await this.confirmSnapshot(s,r);
    await this.checkDestination(s,r,target);
    const id = crypto.randomUUID();
    a.journal = {
      id,
      documentId: b.documentId,
      revision: b.revision,
      action: target.action,
      from: r.from!,
      to: r.expected ?? null,
      state: 'claimed',
    };
    if (target.role === 'heading') r.reveal = { path: r.from!.split('#')[0]!, doc: b.documentId };
    r.waiting = true;
    t.state = 'executing';
    a.status = 'Navigating · ' + target.label;
    await this.publish(s);
    this.live(s, r);
    r.timer = setTimeout(() => {
      if (this.runs.get(t.tabId) === r && r.waiting)
        void this.pause(s, 'No verified progress. Take over and use the control manually.');
    }, 6500);
    try {
      await this.send(b, { op: 'act', ref: target.ref, action: target.action, actionId: id });
    } catch (e) {
      if(await this.fallbackSearchTransition(s,r,target,true))return;
      if (!r.transition && this.runs.get(t.tabId) === r) throw e;
      return;
    }
    if (this.runs.get(t.tabId) !== r || r.b !== b) return;
    if (a.journal?.id === id && a.journal.state === 'claimed') {
      a.journal.state = 'dispatched';
      await this.publish(s);
    }
    if (!['activate_readonly_link', 'submit_public_search','apply_catalog_filter'].includes(target.action))
      await this.verifyLocal(s, r);
  }
  private async verifyLocal(s: RecordState, r: Run) {
    if (r.verifyingLocal) return;
    r.verifyingLocal=true;
    const selected=r.selected;
    try { await this.observeLocalProgress(s,r); } catch(e) {
      if(!selected || !await this.fallbackSearchTransition(s,r,selected,true))throw e;
    } finally { r.verifyingLocal=false; }
  }
  private async fallbackSearchTransition(s:RecordState,r:Run,candidate:PublicRef,wait=false){
    if(candidate.label!=='Open Wikipedia search' || candidate.action!=='toggle_known_navigation' ||
      candidate.path!=='/wiki/Special:Search' || s.cp.task?.adaptive?.profile!=='wikipedia')return false;
    const deadline=Date.now()+(wait?850:0);
    do{
      this.live(s,r);
      if(r.arrived===candidate.path && r.from!==r.arrived)return true;
      const tab=await chrome.tabs.get(s.cp.tabId);
      this.live(s,r);
      if(!tab.active || !tab.url || new URL(tab.url).origin!=='https://en.wikipedia.org')return false;
      if(tab.url==='https://en.wikipedia.org/wiki/Special:Search'){
        await this.navigation(s,{url:tab.url,status:tab.status},tab);
        return true;
      }
      if(!wait)return false;
      await nextObservation(r.abort.signal,80);
    }while(Date.now()<deadline);
    return false;
  }
  private async observeLocalProgress(s: RecordState, r: Run) {
    const before = r.snap!,
      old = r.selected!,
      t = s.cp.task!,
      a = t.adaptive!;
    const deadline=Date.now()+2500;
    const doc=r.b!.documentId;
    let observedDisclosure=false;
    do {
      if(await this.fallbackSearchTransition(s,r,old))return;
      const next = await this.inspect(s, r);
      if (r.b?.documentId !== doc) throw Error('The document was replaced during this step. Take over.');
      if(old.action==='inspect_catalog_filter' && next.catalogNotice){
        clearTimeout(r.timer);r.waiting=false;t.steps++;
        if(a.journal)a.journal.state='verified';
        await this.pause(s,'Resell reports: '+next.catalogNotice+' No filter was applied. Close the site notice to continue.');
        return;
      }
      if(old.action==='load_catalog_results' && next.path===before.path &&
        before.catalogItems!==undefined && next.catalogItems!==undefined && next.catalogItems>before.catalogItems){
        clearTimeout(r.timer);r.waiting=false;t.steps++;if(a.journal)a.journal.state='verified';
        await this.pause(s,'Verified '+(next.catalogItems-before.catalogItems)+' additional public listings on the same catalog page.','completed');
        return;
      }
      const sameControl=next.controls.find(c=>c.action===old.action && c.label===old.label && c.path===old.path);
      // A disclosure can announce "expanded" before rendering its items.
      // Replanning on the bit alone can ask the model about an empty menu.
      const newlyAvailable = next.controls.some(candidate => !before.controls.some(previous =>
        candidate.action === previous.action && candidate.label === previous.label &&
        candidate.path === previous.path && candidate.context === previous.context));
      const disclosureReady = (sameControl?.expanded === true && old.expanded !== true && newlyAvailable) ||
        (sameControl?.expanded === false && old.expanded === true);
      const progress = !!next.complete || (old.action === 'toggle_known_navigation' &&
        (disclosureReady ||
          next.controls.some(c => c.action === 'submit_public_search') &&
          !before.controls.some(c => c.action === 'submit_public_search')));
      if (!progress) {
        await nextObservation(r.abort.signal,100);
        continue;
      }
      let settled: AssistSnapshot | undefined;
      if (old.action==='toggle_known_navigation' && !next.complete) {
        observedDisclosure=true;
        // Hydration can replace a newly shown search widget after expansion.
        // Keep the original inspection alive through the observer's debounce,
        // then confirm those exact elements before spending a planning request.
        const binding = r.b!;
        const quiet = 2 * bounds.changeDebounceMs;
        if (Date.now() + quiet > deadline) break;
        await nextObservation(r.abort.signal,quiet);
        await this.confirmSnapshot(s,r);
        const observed = await this.send(binding,{op:'verify_snapshot'}).catch(()=>null);
        this.live(s,r);
        if (!observed || r.b !== binding || facts(observed) !== facts(next)) continue;
        settled = observed;
        r.snap = observed;
      }
      clearTimeout(r.timer);
      r.waiting = false;
      t.steps++;
      a.noProgress = 0;
      if (a.journal) a.journal.state = 'verified';
      this.markVerified(r,old);
      r.verifyingLocal=false;
      await this.plan(s, r,settled);
      return;
    } while(Date.now() < deadline);
    a.noProgress++;
    await this.pause(s, observedDisclosure
      ? 'The disclosure changed, but its controls did not settle. Resume for a fresh inspection or take over.'
      : 'No observed progress. Take over and activate the control yourself.');
  }
  async control(s: RecordState, tab: chrome.tabs.Tab, action: string) {
    const t = s.cp.task,
      a = t?.adaptive;
    if (!t || !a) throw new Fault('blocked_by_policy');
    if (action === 'edit') {
      if (a.status === 'Goal edited. Submit the updated goal to continue.') return;
      a.version++;
      a.intent = null;
      return this.pause(s, 'Goal edited. Submit the updated goal to continue.');
    }
    if (action === 'stop' || action === 'pause')
      return this.pause(
        s,
        action === 'stop' ? 'Stopped by you.' : 'Paused by you.',
        action === 'stop' ? 'cancelled' : 'paused',
      );
    if (action === 'takeover') {
      t.mode = 'guide';
      return this.pause(s, 'You have control. Continue in guide mode.');
    }
    if (t.cancelled || t.state === 'completed') throw new Fault('blocked_by_policy');
    if(action==='returnCatalog'){
      const r=this.runs.get(t.tabId),trail=this.trails.get(t.tabId);
      if(!r?.b || t.state!=='showing_step' || r.selected?.action!=='handoff_catalog' || !trail ||
        trail.expires<=Date.now() || trail.tenant!==tab.url || a.returnUrl!==trail.catalog ||
        !publicCatalogPath(new URL(trail.catalog)))throw new Fault('stale_document');
      // This is a deliberate manual panel activation, bound to the exact
      // public results that led to this same tenant, in this same tab/run.
      await this.confirmSnapshot(s,r);
      const ok=await this.destinationPreflight?.(s,tab,{kind:'navigation',url:trail.catalog,documentId:r.b.documentId},r.abort.signal);
      await this.confirmSnapshot(s,r);
      if(ok&&!ok.allow)return this.pause(s,ok.reason??'Review the website warning before returning.');
      if(this.trails.get(t.tabId)!==trail)throw new Fault('stale_document');
      this.trails.delete(t.tabId);delete a.returnUrl;
      await this.send(r.b,{op:'cue',ref:r.selected.ref,action:r.selected.action,scroll:false});
      await this.confirmSnapshot(s,r);
      await chrome.tabs.update(t.tabId,{url:trail.catalog});
      if(this.runs.get(t.tabId)===r)await this.pause(s,'You chose the earlier results. Grant access on the marketplace to inspect the current page.');
      return;
    }
    if (action === 'localDownload') {
      if (!a.download || t.state !== 'paused' || a.status.startsWith('Goal edited.')) throw new Fault('blocked_by_policy');
      return this.begin(s,tab,t.goal,a.download,true);
    }
    if (action === 'confirm') {
      if (
        a.profile !== 'experimental' ||
        a.status !== 'Confirm that this is the requested destination.'
      )
        throw new Fault('blocked_by_policy');
      return this.pause(s, 'Destination confirmed by you.', 'completed');
    }
    if (action === 'reveal') {
      const r = this.runs.get(t.tabId);
      if (!r?.selected || !r.b) throw new Fault('stale_document');
      this.launch(s, r, async () => {
        await this.active(s, r);
        if (r.selected!.role === 'heading')
          r.reveal = { path: r.from!.split('#')[0]!, doc: r.b!.documentId };
        await this.send(r.b!, {
          op: 'cue',
          ref: r.selected!.ref,
          action: r.selected!.action,
          scroll: true,
        });
        if (r.selected!.role === 'heading') await this.verifyLocal(s, r);
      });
      return;
    }
    if (!['paused', 'showing_step', 'awaiting_confirmation'].includes(t.state) || a.authorized)
      throw new Fault('blocked_by_policy');
    if (!a.intent) {
      if (action === 'automatic' || a.status.startsWith('Goal edited.'))
        throw new Fault('blocked_by_policy');
      return this.begin(s, tab, t.goal, a.download);
    }
    if (['clarify', 'unsupported'].includes(a.intent.action)) throw new Fault('blocked_by_policy');
    a.authorized = action === 'automatic';
    t.mode = a.authorized ? 'automatic' : 'guide';
    const r = this.createRun(s);
    r.arrived = tab.url ? (publicPath(new URL(tab.url), a.profile) ?? undefined) : undefined;
    this.launch(s, r, () => this.plan(s, r));
  }
  private async readyDocument(s: RecordState, r: Run, path: string, onSearch: boolean) {
    const a=s.cp.task!.adaptive!, deadline=Date.now()+3000;
    do {
      const tab=await this.active(s,r);
      const url=tab.url && new URL(tab.url);
      if (!url || publicPath(url,a.profile)!==path ||
        (onSearch && (!a.searchQuery || !wikipediaSearchUrl(url,a.searchQuery))))
        throw Error('The destination changed during verification. Inspect the current page again.');
      // tabs.get and the frame execute at different times. Require the actual
      // main document to report the exact checked address and usable DOM.
      const [top]=await chrome.scripting.executeScript({
        target:{tabId:s.cp.tabId,frameIds:[0]}, injectImmediately:true,
        func:(expected:string)=>({matches:location.href===expected,
          ready:document.readyState!=='loading' && !!document.body}),
        args:[url.href],
      }).catch(()=>[]);
      this.live(s,r);
      if (top?.frameId===0 && top.documentId && top.result?.matches && top.result.ready)
        return top.documentId;
      await nextObservation(r.abort.signal,80);
    } while(Date.now()<deadline);
    throw Error('The expected public document did not become ready. Resume or take over.');
  }
  async navigation(s: RecordState, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) {
    const task = s.cp.task!,
      a = task.adaptive!,
      r = this.runs.get(s.cp.tabId);
    if (!change.url && !change.status) return;
    // Chrome may deliver loading, URL and completion notifications while earlier
    // document cleanup is still resolving. Read the tab again before counting a step.
    t = await chrome.tabs.get(t.id!);
    const u = t.url ? new URL(t.url) : null,
      path = u && publicPath(u, a.profile);
    if (u && u.origin !== a.origin && s.cp.invokedOrigin && s.cp.invokedOrigin!==u.origin) {
      s.cp.invokedOrigin = null;
      await this.store.save(s);
    }
    if (
      !r ||
      this.runs.get(s.cp.tabId) !== r ||
      ['paused', 'completed', 'cancelled'].includes(task.state)
    )
      return;
    if (u && path === null && t.active && t.windowId === s.windowId &&
        a.profile === 'wikipedia' && a.searchQuery && !a.authorized &&
        r.from === '/wiki/Special:Search' && r.searchDocument === r.b?.documentId &&
        r.b && r.selected?.action === 'activate_readonly_link' && r.selected.path &&
        r.selected.ref === r.userSelection &&
        pendingWikipediaArticle(u,r.selected.path,a.searchQuery,wikipediaArticleProvenance)) {
      // The user's exact search result may briefly pass through the site's
      // rewriting addresses. Keep all operations suspended until the clean,
      // selected article commits. A changed field or another title fails closed.
      if (!r.normalizationTimer) r.normalizationTimer=setTimeout(()=>{
        if (this.runs.get(s.cp.tabId)===r) void this.pause(s,
          'The selected article did not reach its clean public address. Resume or take over.');
      },3000);
      return;
    }
    if (!u || u.origin !== a.origin || !t.active || path === null) {
      // This notification belongs to the old task. Never erase a subsequent
      // explicit toolbar grant for the actual new tenant while fencing it.
      if (s.cp.invokedOrigin===a.origin || (u && s.cp.invokedOrigin!==u.origin)) s.cp.invokedOrigin = null;
      if(r.selected?.action==='handoff_storefront' && r.userSelection===r.selected.ref && u &&
        u.origin===r.selected.targetOrigin && u.pathname===r.selected.path && !u.search && !u.hash){
        await this.pause(s,'You opened the selected listing on '+u.hostname+'. Grant SafeStep access on this storefront, then ask to check this seller or compare this listing.');
        return;
      }
      const reason = !t.active ? 'This tab is no longer active.' :
        !u ? 'The current tab address could not be verified.' :
        u.origin !== a.origin ? 'The website changed.' : 'This page address is outside the approved public route.';
      await this.pause(s, reason + ' Start a fresh inspection.');
      return;
    }
    const onSearch = a.profile === 'wikipedia' && u.pathname === '/w/index.php' && !wikiCitationPage(u);
    if (onSearch && (r.searchDocument || r.selected?.action === 'submit_public_search')) {
      if (!a.searchQuery || !wikipediaSearchUrl(u, a.searchQuery)) {
        await this.pause(s, 'The public search changed. Inspect the current page again.');
        return;
      }
      if (r.searchDocument) {
        // Wikipedia may replace its history entry to add ns0=1. A verified
        // normalization in the same document is neither a new step nor a new
        // destination. A reload of the results is a different document.
        const doc = await probe(t.id!, a.origin).catch(() => null);
        if (this.runs.get(s.cp.tabId) === r && doc !== r.searchDocument) {
          const current = await chrome.tabs.get(t.id!);
          if (this.runs.get(s.cp.tabId) === r && current.url && current.status === 'complete' &&
              wikipediaSearchUrl(new URL(current.url), a.searchQuery))
            await this.pause(s, 'The search results document was replaced. Inspect fresh controls.');
        }
        return;
      }
    }
    if (
      r.reveal &&
      path?.split('#')[0] === r.reveal.path &&
      (await probe(t.id!, a.origin).catch(() => null)) === r.reveal.doc
    )
      return;
    if (r.settling) return;
    const searchTransition =
      r.selected?.action === 'submit_public_search' &&
      a.profile === 'wikipedia' &&
      (u.pathname === '/w/index.php'
        ? !!a.searchQuery && wikipediaSearchUrl(u, a.searchQuery)
        : path !== r.from && articleMatchesQuery(path, a.searchQuery ?? ''));
    if ((!searchTransition && path !== r.expected) || !r.selected) {
      if (path === r.from || path === r.arrived || path === r.snap?.path) {
        if (
          t.status === 'complete' &&
          r.b &&
          path === r.snap?.path &&
          (await probe(t.id!, a.origin).catch(() => null)) !== r.b.documentId &&
          this.runs.get(t.id!) === r
        )
          await this.pause(s, 'The document was replaced. Inspect fresh controls.');
        return;
      }
      await this.pause(s, 'Unexpected navigation. Reinspect before continuing.');
      return;
    }
    if (path === r.from && !(onSearch && searchTransition)) return;
    if (t.status === 'loading') {
      if (!r.transition) {
        r.transition = true;
        task.state = 'verifying';
        a.status = 'Checking the resulting page…';
        await this.publish(s);
      }
      return;
    }
    r.settling = true;
    r.transition = true;
    const target = r.selected;
    try {
      const doc = await this.readyDocument(s,r,path!,onSearch);
      this.live(s, r);
      const now = await chrome.tabs.get(t.id!);
      if (!now.url || publicPath(new URL(now.url), a.profile) !== path || r.selected !== target)
        return;
      if (onSearch && (!a.searchQuery || !wikipediaSearchUrl(new URL(now.url), a.searchQuery))) {
        await this.pause(s, 'The public search changed during verification. Inspect the current page again.');
        return;
      }
      this.live(s, r);
      r.searchDocument = onSearch ? doc : undefined;
      r.transition = false;
      clearTimeout(r.timer);
      r.waiting = false;
      r.arrived = path;
      r.arrivalDocument=doc;
      r.inspectArrival=true;
      r.b=undefined;
      r.snap=undefined;
      if (a.journal) a.journal.state = 'verified';
      task.steps++;
      this.markVerified(r,target);
      a.noProgress = 0;
      this.launch(s, r, () => this.plan(s, r));
    } catch (error) {
      if (this.runs.get(s.cp.tabId) === r)
        await this.pause(s,error instanceof Error ? error.message : 'The resulting document could not be verified.');
    } finally {
      r.settling = false;
    }
  }
  async notice(raw: unknown, sender: chrome.runtime.MessageSender) {
    const m = parseWire(AssistNotice, raw);
    if (
      !m ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.documentId !== m.binding.documentId ||
      sender.tab?.id !== m.binding.tabId
    )
      return;
    const s = this.store.tabs.get(m.binding.tabId),
      r = this.runs.get(m.binding.tabId);
    if (
      !s ||
      !r?.b ||
      !sameBinding(r.b, m.binding) ||
      r.b.goalVersion !== m.binding.goalVersion ||
      r.b.windowId !== m.binding.windowId
    )
      return;
    if (m.event === 'changed') {
      if (r.transition || r.inspectArrival || r.verifyingLocal) return;
      const t = s.cp.task!,
        a = t.adaptive!;
      if (a.intent && (t.state==='planning' || t.state==='showing_step') &&
          await this.reinspectTarget(s,r)) return;
      await this.pause(s, 'The suggested control changed. Reinspect.');
      return;
    }
    if (!r.selected) return;
    if (m.event === 'user_target' && !s.cp.task?.adaptive?.authorized) {
      if (['toggle_known_navigation','load_catalog_results','inspect_catalog_filter'].includes(r.selected.action)) {
        this.launch(s,r,()=>this.verifyLocal(s,r));
      } else if (['activate_readonly_link','submit_public_search','apply_catalog_filter','handoff_storefront','handoff_catalog'].includes(r.selected.action)) {
        // The bridge observed the user's selected control. Keep checking the
        // expected destination; never dispatch anything on the user's behalf.
        r.userSelection=r.selected.ref;
        if(r.selected.action==='handoff_storefront' && r.selected.targetOrigin && r.selected.path && r.snap){
          const catalog=new URL(r.snap.path,r.b.origin);
          if(publicCatalogPath(catalog)){
            if(this.trails.size>=32)this.trails.delete(this.trails.keys().next().value!);
            this.trails.set(s.cp.tabId,{catalog:catalog.href,tenant:new URL(r.selected.path,r.selected.targetOrigin).href,expires:Date.now()+300000});
          }
        }
        if (!r.waiting) {
          r.waiting=true;
          r.transition=true;
          r.timer=setTimeout(()=>{
            if (this.runs.get(s.cp.tabId)===r && r.waiting)
              void this.pause(s,'No verified navigation followed your selection. Resume or take over.');
          },6500);
        }
      }
    }
  }
  async recover(s: RecordState, t: chrome.tabs.Tab) {
    await this.pause(s, 'Recovered and paused. Continue to inspect fresh controls.');
    if (
      !t.active ||
      !s.cp.task?.adaptive ||
      !t.url ||
      new URL(t.url).origin !== s.cp.task.adaptive.origin
    )
      return;
    const r = this.createRun(s);
    try {
      await this.inspect(s, r);
      s.cp.task.adaptive.status = 'Recovered and reinspected. Navigation is paused.';
    } catch {
      /* Fresh access may be required. */
    } finally {
      this.retire(s);
      await this.publish(s);
    }
  }
}
