import {
  ChatRouteInput,
  ChatRouteReply,
  Features,
  generationLimitMessage,
  Fault,
  chatExpectsAmazon,
  chatRouteSite,
  safeChatText,
  messages,
  permittedOrigin,
  privateText,
  validatedChatRoute,
  profileForPage,
  wikiCitationSubject,
  publisherBrowseGoal,
  type ChatAction,
  type ChatConversation,
  type ChatRouteDecision,
  type ChatTurn,
  type FeatureId,
  type FileProfile,
  type PanelRequest,
} from '@safestep/contracts';
import { requestsPrivateAccountChange, resolveGoal, workflows } from '../sites/profiles';
import { protectionAddress } from '../sites/protection';
import { expectedAddress, explainExpectedAddress } from '../sites/expected-address';
import { publisherChoice } from '../sites/publisher-goal';
import { localSiteGoal } from './adaptive';
import { products, packageLabel } from '../sites/downloads';
import { comparisonRoute } from '../sites/comparison';
import { shoppingRoute } from '../sites/shopping';
import { chatScopeSignature } from '../page/chat-scope';
import { access, probe } from './access';
import { settingsGoal } from './adaptive';
import { boundedResponseText } from './bounded-response';
import {
  emptyConversation,
  makeTurn,
  retireTurns,
  routedHistory,
  trimConversation,
} from './conversation';
import type { Store } from './store';
import type { RecordState } from './state';

type PageCommand = Exclude<PanelRequest['command'], { kind: 'chat' }>;
class RouteUnavailable extends Error {}
type Send = (s: RecordState, t: chrome.tabs.Tab, command: PageCommand) => Promise<unknown>;
type Owner = {
  conversation: ChatConversation;
  turn: ChatTurn;
  abort: AbortController;
  tab: chrome.tabs.Tab;
  reveal?: boolean;
};
type Routed = Extract<ChatRouteDecision, { kind: 'routed' }>;
const navigation = (f: FeatureId | undefined) =>
  f === 'visual_guidance' || f === 'automatic_navigation' || f === 'download_guidance';
const fixed: Record<string, FeatureId> = {
  'check this website': 'site_trust',
  'check this address': 'url_identity',
  'check this seller': 'seller_assessment',
  'check this product': 'product_assessment',
  'compare alternatives': 'shopping_alternatives',
  'find alternatives': 'shopping_alternatives',
  'preview cleanup': 'page_cleanup',
  'clean up this page': 'page_cleanup',
  'find a download': 'download_guidance',
  'help me get somewhere': 'visual_guidance',
  'guide me on this page': 'visual_guidance',
  'guide an automatic task': 'automatic_navigation',
};
const localSuggestions: FeatureId[] = ['site_trust', 'visual_guidance', 'download_guidance'];
const label = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '');
const chooseProfile = (text: string) =>
  (Object.keys(products) as FileProfile[]).find(
    (id) => label(text) === label(packageLabel(id)),
  );
const selectedLabel = packageLabel;
const restoreRequest = (text: string) => /^(?:please\s+)?restore (?:the |this )?page[.!?]?$/i.test(text.trim());
const adPreviewRequest = (text: string) => /^(?:please\s+)?(?:hide|remove|preview)\s+(?:the\s+)?(?:ads|advertisements)\b/i.test(text.trim());
function localFeature(text: string, url: string): FeatureId | null {
  const predefined = fixed[label(text)];
  if (predefined) return predefined;
  if (adPreviewRequest(text) || restoreRequest(text)) return 'page_cleanup';
  if (['videolan_windows_page', 'wikipedia_cite_apa'].includes(resolveGoal(text)))
    return 'visual_guidance';
  const u = new URL(url);
  if(localSiteGoal(profileForPage(u),text))return 'visual_guidance';
  if (
    settingsGoal(text) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
    u.pathname.startsWith('/settings-lab')
  )
    return 'visual_guidance';
  return publisherChoice(text, u.origin).kind !== 'unrelated' ? 'download_guidance' : null;
}
function subjectContext(
  s: RecordState,
  turn: ChatTurn,
  priorGoal: ChatTurn | undefined,
): { values: ChatRouteInput['subjects']; key: string; offered: Map<string, string> } {
  const values: ChatRouteInput['subjects'] = [],
    identities: string[] = [];
  const offered = new Map<string, string>();
  const recorded = (operation: string) =>
    s.cp.chat?.turns.some(
      (t) =>
        t.role === 'assistant' &&
        t.operationId === operation &&
        t.origin === turn.origin &&
        t.documentId === turn.documentId &&
        t.scope === turn.scope &&
        t.state !== 'stale',
    );
  function add(
    kind: ChatRouteInput['subjects'][number]['kind'],
    raw: string | undefined | null,
    id: string,
  ) {
    if (!raw || values.length >= 8) return;
    const name = raw.slice(0, 100);
    if (!safeChatText(name)) return;
    const ref = 's' + (values.length + 1);
    values.push({ kind, ref, label: name });
    identities.push(id);
    return ref;
  }
  const current = (kind: 'seller' | 'product') => {
    const data = s.shopping?.[kind]?.data;
    if (
      !data ||
      !recorded(data.binding.operationId) ||
      data.binding.epoch !== s.cp.epoch ||
      Date.parse(data.captured) + 300000 <= Date.now()
    )
      return;
    add(
      kind,
      kind === 'seller' ? data.context.seller : data.context.title,
      JSON.stringify([
        data.binding.operationId,
        data.context.seller,
        data.context.catalog,
        data.context.listing,
        data.context.variant,
        data.context.condition,
      ]),
    );
  };
  current('seller');
  current('product');
  const c = s.comparison;
  if (c?.baseline && recorded(c.id) && !['paused', 'stale', 'cancelled'].includes(c.status)) {
    add('comparison', c.baseline.title, c.id + ':' + c.version);
    for (const offer of [c.baseline, ...c.candidates.slice(0, 3).map((x) => x.offer)]) {
      const ref = add('offer', offer.title, c.id + ':' + c.version + ':' + offer.id);
      if (ref) offered.set(ref, offer.id);
    }
  }
  const task = s.cp.task;
  if (
    task &&
    priorGoal &&
    s.cp.chat?.turns.includes(priorGoal) &&
    task.tabId === s.cp.tabId &&
    priorGoal.taskId === task.id &&
    priorGoal.original === task.goal &&
    priorGoal.epoch === turn.epoch &&
    priorGoal.origin === turn.origin &&
    turn.documentId &&
    priorGoal.documentId === turn.documentId &&
    turn.scope &&
    priorGoal.scope === turn.scope &&
    (!task.adaptive ||
      (priorGoal.version === task.adaptive.version && task.adaptive.origin === turn.origin))
  )
    add('goal', priorGoal.original, task.id + ':' + (task.adaptive?.version ?? 0));
  return { values, key: JSON.stringify(identities), offered };
}
function available(url: string): FeatureId[] {
  const u = new URL(url),
    shopping = shoppingRoute(u),
    comparison = comparisonRoute(u);
  return Features.filter((f) =>
    f === 'seller_assessment'
      ? !!shopping || protectionAddress(url).identity === 'amazon_us'
      : f === 'product_assessment'
        ? !!shopping
        : f === 'shopping_alternatives'
          ? !!comparison
          : true,
  );
}
async function pageScope(tabId: number, doc: string) {
  const [read] = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [doc] },
    func: chatScopeSignature,
  });
  if (
    read?.documentId !== doc ||
    typeof read.result !== 'string' ||
    !/^[a-f0-9]{64}$/.test(read.result)
  )
    throw new Fault('stale_document');
  return read.result;
}
function safeRequest(text: string) {
  return safeChatText(text);
}
function pastedAddress(text: string) {
  if (privateText(text)) return false;
  const urls = text.match(/https?:\/\/[^\s<>]+/gi);
  if (urls?.length !== 1 || !URL.canParse(urls[0]!)) return false;
  const u = new URL(urls[0]!);
  return (
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    (text.trim() === urls[0] || /\b(?:address|url|host|domain|link|amazon)\b/i.test(text)) &&
    (text.trim() === urls[0] || safeRequest(text.replace(urls[0]!, '')))
  );
}

function addressReply(raw: string, expectAmazon: boolean, goal='') {
  const expected=expectedAddress(goal);
  if(expected && expected!=='amazon.com')return explainExpectedAddress(raw,expected);
  const observation = protectionAddress(raw, expectAmazon);
  return observation.identity === 'observed'
    ? 'Actual hostname: ' + new URL(raw).hostname + '. Identity does not establish reputation.'
    : observation.address;
}

export class Chat {
  private current = new Map<number, Owner>();
  constructor(
    private store: Store,
    private send: Send,
  ) {}

  private async publish(s: RecordState) {
    if (s.cp.chat) trimConversation(s.cp.chat);
    await this.store.save(s);
    await chrome.runtime.sendMessage({ channel: 'cue-updated', tabId: s.cp.tabId }).catch(() => {});
  }
  private owns(s: RecordState, o: Owner) {
    return (
      !o.abort.signal.aborted &&
      this.current.get(s.cp.tabId) === o &&
      s.cp.chat === o.conversation &&
      s.cp.chat.activeTurnId === o.turn.id
    );
  }
  private async currentPage(s: RecordState, o: Owner) {
    if (!this.owns(s, o) || s.cp.epoch !== o.turn.epoch) throw new Fault('stale_document');
    const tab = await chrome.tabs.get(s.cp.tabId);
    if (
      !tab.active ||
      tab.windowId !== o.tab.windowId ||
      !(await chrome.windows.get(tab.windowId)).focused ||
      permittedOrigin(tab.url) !== o.turn.origin
    )
      throw new Fault('stale_document');
    const permission = await access(s, this.store.prefs, tab);
    const doc = await probe(s.cp.tabId, permission.site);
    const scope = await pageScope(s.cp.tabId, doc);
    if (
      !this.owns(s, o) ||
      s.cp.epoch !== o.turn.epoch ||
      (o.turn.documentId !== null && (o.turn.documentId !== doc || o.turn.scope !== scope))
    )
      throw new Fault('stale_document');
    o.turn.documentId = doc;
    o.turn.scope = scope;
    return tab;
  }
  private finish(o: Owner, state: ChatTurn['state'], text: string) {
    o.turn.state = state;
    o.turn.text = text;
  }
  private abort(s: RecordState) {
    const pending = this.current.get(s.cp.tabId);
    if (pending) {
      pending.abort.abort();
      this.current.delete(s.cp.tabId);
    }
    delete s.abortChat;
    return pending;
  }
  recover(s: RecordState) {
    if (s.cp.chat) {
      retireTurns(s.cp.chat, 'paused');
      return this.store.save(s);
    }
  }
  async changed(s: RecordState, navigationOccurred = false, selectedWikiHandoff = false) {
    const c = s.cp.chat;
    if (!c) return;
    const active = c.turns.find((t) => t.id === c.activeTurnId);
    const pending = this.abort(s);
    // Expected navigation must still be verified by the existing task engine.
    if (
      (!pending || (selectedWikiHandoff && pending.reveal && pending.turn===active &&
        pending.conversation===c && pending.tab.id===s.cp.tabId)) &&
      navigationOccurred &&
      active?.taskId &&
      navigation(active.feature) &&
      active.taskId === s.cp.task?.id &&
      !['cancelled', 'completed', 'failed'].includes(s.cp.task.state)
    )
      return;
    s.chatRevision = (s.chatRevision ?? 0) + 1;
    retireTurns(c);
    const divider = 'Page changed. Earlier results belong to the previous page.';
    if (navigationOccurred && c.turns.length && c.turns.at(-1)?.text !== divider) {
      const note = makeTurn('assistant', divider, null, s.cp.epoch, null);
      note.state = 'stale';
      note.historical = true;
      c.turns.push(note);
    }
    await this.publish(s);
  }
  private async stopOwned(s: RecordState, t: chrome.tabs.Tab, c: ChatConversation, pause: boolean) {
    const active = c.turns.find((x) => x.id === c.activeTurnId),
      owner = this.abort(s);
    if (!active) return;
    if (
      active.taskId &&
      active.taskId === s.cp.task?.id &&
      !['completed', 'cancelled', 'failed'].includes(s.cp.task.state)
    )
      await this.send(
        s,
        t,
        s.cp.task.adaptive
          ? { kind: 'assistControl', action: pause ? 'pause' : 'stop' }
          : { kind: pause ? 'pause' : 'cancel' },
      );
    else if (
      active.feature === 'shopping_alternatives' &&
      s.comparison?.id === active.operationId &&
      s.comparison &&
      ['needs_baseline', 'searching', 'checking_candidates', 'comparing'].includes(
        s.comparison.status,
      )
    )
      await this.send(s, t, {
        kind: 'compare',
        action: { op: 'cancel', session: s.comparison.id, version: s.comparison.version },
      });
    else if (
      owner &&
      (active.feature === 'seller_assessment' || active.feature === 'product_assessment')
    )
      s.cancelShopping?.();
    else if (owner && active.feature === 'site_trust') s.cancelReview?.();
  }
  async operate(s: RecordState, t: chrome.tabs.Tab, a: ChatAction): Promise<void> {
    const c = (s.cp.chat ??= emptyConversation());
    if (a.conversationId && a.conversationId !== c.id) throw new Fault('stale_document');
    if (a.op === 'act') return this.act(s, t, c, a);
    const revision = (s.chatRevision = (s.chatRevision ?? 0) + 1);
    if (a.op === 'clear' || a.op === 'cancel') {
      await this.stopOwned(s, t, c, false);
      if (s.cp.chat !== c || s.chatRevision !== revision) throw new Fault('stale_document');
      if (a.op === 'clear') s.cp.chat = emptyConversation();
      else {
        const active = c.turns.find((x) => x.id === c.activeTurnId);
        if (active) {
          active.state = 'paused';
          active.text = 'Stopped by you.';
        }
      }
      return this.publish(s);
    }
    if (a.op !== 'submit' && a.op !== 'shortcut') throw new Fault('invalid_message');
    const prior = c.turns.find((x) => x.id === c.activeTurnId);
    const priorGoal =
      prior && !prior.historical && navigation(prior.feature) && prior.taskId ? prior : undefined;
    const reply =
      a.op === 'submit' && a.replyTo
        ? c.turns.find((x) => x.id === a.replyTo && !x.historical && x === prior)
        : a.op === 'submit' && prior?.state === 'clarifying' && !prior.historical
          ? prior
          : undefined;
    if (
      a.op === 'submit' &&
      a.replyTo &&
      (!reply || reply.origin !== permittedOrigin(t.url) || reply.epoch !== s.cp.epoch)
    )
      throw new Fault('stale_document');
    const text = a.text.trim(),
      address = pastedAddress(text),
      safe = safeRequest(text) || address;
    // The composer also binds free text to the active question. Keep exact
    // offered answers attached, and let a new explicit local request stand alone.
    const startsNew = reply?.state === 'clarifying' && !reply.choices?.includes(text) &&
      (address || Object.hasOwn(fixed, label(text)));
    const parent = startsNew ? undefined : reply;
    const inherited = parent?.state === 'clarifying' && parent.original;
    const selection =
      inherited && parent?.feature === 'download_guidance' && safe
        ? chooseProfile(text)
        : undefined;
    const selectedLocalGuide =
      (parent?.feature === 'visual_guidance' || parent?.feature === 'automatic_navigation') &&
      parent.choices?.includes(text) &&
      !!inherited &&
      fixed[label(inherited)] === parent.feature;
    const goal = inherited
      ? selection
        ? inherited
        : selectedLocalGuide
          ? text
          : inherited + ' — ' + text
      : text;
    await this.stopOwned(s, t, c, true);
    if (s.cp.task?.adaptive?.authorized)
      await this.send(s, t, { kind: 'assistControl', action: 'pause' });
    if (c !== s.cp.chat || s.chatRevision !== revision) throw new Fault('stale_document');
    retireTurns(c);
    const origin = permittedOrigin(t.url);
    const user = makeTurn(
      'user',
      safe ? text : 'Private request omitted.',
      origin,
      s.cp.epoch,
      null,
    );
    const turn = makeTurn('assistant', 'Checking your request…', origin, s.cp.epoch, null);
    c.turns.push(user, turn);
    c.activeTurnId = turn.id;
    const o: Owner = { conversation: c, turn, tab: t, abort: new AbortController() };
    this.current.set(s.cp.tabId, o);
    s.abortChat = () => {
      this.abort(s);
    };
    try {
      await this.publish(s);
      if (!safe || goal.length > 240) {
        this.finish(
          o,
          'clarifying',
          safe
            ? 'Restate the full goal and its constraints in 240 characters or fewer.'
            : 'Remove private details such as passwords, tokens or account URLs and try again.',
        );
        return;
      }
      turn.original = goal;
      if (requestsPrivateAccountChange(goal)) {
        this.finish(
          o,
          'unsupported',
          'You control changes to passwords and payment details. Choose a supported read-only task.',
        );
        return;
      }
      if (inherited && parent) {
        if ((parent.clarifications ?? 0) >= 2) {
          this.finish(
            o,
            'unsupported',
            'This goal still needs clarification. Start a new request or choose a local action.',
          );
          turn.suggestions = localSuggestions;
          return;
        }
        turn.clarifications = (parent.clarifications ?? 0) + 1;
      }
      if (address) {
        const raw = text.match(/https?:\/\/[^\s<>]+/i)![0];
        turn.feature = 'url_identity';
        this.finish(o, 'completed', addressReply(raw, chatExpectsAmazon(text),text));
        return;
      }
      if (!origin) {
        this.finish(
          o,
          'awaiting_access',
          'Open an ordinary website, then click the SafeStep toolbar button.',
        );
        return;
      }
      const tab = await this.currentPage(s, o);
      user.documentId = turn.documentId;
      user.scope = turn.scope;
      if (reply?.scope && reply.scope !== turn.scope) {
        this.finish(o, 'stale', 'The page or selected item changed. Start a new request.');
        return;
      }
      const fallback = localFeature(goal, tab.url!);
      const shortcut =
        a.op === 'shortcut'
          ? a.feature
          : address
            ? 'url_identity'
            : selection
              ? 'download_guidance'
              : selectedLocalGuide
                ? parent!.feature
                : null;
      if (!shortcut && (restoreRequest(goal) || adPreviewRequest(goal))) {
        turn.feature = 'page_cleanup';
        await this.dispatch(s,o,'page_cleanup',true);
      } else if (!shortcut && tab.url && new URL(tab.url).origin === 'https://winscp.net' &&
          publisherChoice(goal, 'https://winscp.net').kind === 'ready') {
        // The local tool is known; paired intent/step generation still uses
        // the ordinary adaptive engine and its subject/constraint validation.
        turn.feature = 'download_guidance';
        await this.dispatch(s,o,'download_guidance',false);
      } else if (shortcut) {
        turn.feature = shortcut;
        if (selection) turn.profile = selection;
        await this.dispatch(s, o, shortcut, true);
      } else {
        const site = chatRouteSite(tab.url!);
        if (!site) {
          if (fallback) {
            turn.feature = fallback;
            await this.dispatch(s, o, fallback, true);
          } else {
            this.finish(
              o,
              'unavailable',
              'This page cannot be sent to AI. Choose an eligible local action.',
            );
            turn.suggestions = localSuggestions;
          }
          return;
        }
        const subjects = subjectContext(s, turn, priorGoal);
        const input = ChatRouteInput.safeParse({
          version: 1,
          operationId: crypto.randomUUID(),
          bindingToken: crypto.randomUUID(),
          contextKey: crypto.randomUUID(),
          conversationId: c.id,
          turnId: turn.id,
          text: goal,
          history: routedHistory(c, origin, turn.documentId!, turn.scope!, user.id).filter(
            (h) => h.text.length <= 240 && safeRequest(h.text),
          ),
          site,
          subjects: subjects.values,
          available: available(tab.url!),
          mode: null,
        });
        if (!input.success) {
          this.finish(
            o,
            'clarifying',
            'Please restate a short public goal without private information.',
          );
          return;
        }
        let decision: ChatRouteDecision;
        try {
          decision = await this.route(input.data, o.abort.signal);
        } catch (e) {
          if (
            !fallback ||
            e instanceof Fault ||
            (e instanceof Error && e.message === 'invalid reply')
          )
            throw e;
          await this.currentPage(s, o);
          turn.feature = fallback;
          await this.dispatch(s, o, fallback, true);
          return;
        }
        const now = await this.currentPage(s, o);
        if (
          subjectContext(s, turn, priorGoal).key !== subjects.key ||
          chatRouteSite(now.url!)?.path !== site.path
        )
          throw new Fault('stale_document');
        if (decision.kind === 'clarify') {
          this.finish(o, 'clarifying', decision.question);
          turn.choices = decision.choices;
        } else if (decision.kind === 'unsupported') {
          this.finish(o, 'unsupported', decision.reason);
          turn.suggestions = decision.suggestions;
        } else {
          turn.feature = decision.feature;
          const ref = 'subjectRef' in decision.slots ? decision.slots.subjectRef : null;
          const linked = ref ? subjects.offered.get(ref) : null;
          if (linked && linked !== s.comparison?.baseline?.id) {
            this.finish(
              o,
              'clarifying',
              'That option belongs to a different listing. Open it from the comparison to check its exact seller or product, or specify the current listing.',
            );
            return;
          }
          if (!ref && /\b(?:that|other|previous)\s+(?:seller|product|item|option)\b/i.test(goal)) {
            this.finish(
              o,
              'clarifying',
              'Which seller, product or option do you mean? Identify the current listing so its evidence stays separate.',
            );
            return;
          }
          if (decision.feature === 'download_guidance' && decision.slots.profile)
            turn.profile = decision.slots.profile;
          if (decision.feature === 'shopping_alternatives' && decision.slots.mode)
            turn.comparisonMode = decision.slots.mode;
          if (decision.feature === 'automatic_navigation') turn.mode = 'automatic';
          await this.dispatch(s, o, decision.feature, false, decision);
        }
      }
    } catch (e) {
      if (this.owns(s, o)) {
        const code = e instanceof Fault ? e.code : null;
        this.finish(
          o,
          code === 'stale_document'
            ? 'stale'
            : code?.startsWith('permission_')
              ? 'awaiting_access'
              : code === 'invalid_message'
                ? 'error'
                : code === 'cancelled'
                  ? 'paused'
                  : 'unavailable',
          code
            ? messages[code]
            : e instanceof RouteUnavailable ? e.message
            : 'The local AI service could not route this request. Your goal is saved here. Choose a local action or try again.',
        );
        if (!code) turn.suggestions = localSuggestions;
      }
    } finally {
      if (this.current.get(s.cp.tabId) === o) {
        this.current.delete(s.cp.tabId);
        delete s.abortChat;
      }
      if (s.cp.chat === c) await this.publish(s);
    }
  }
  private async route(input: ChatRouteInput, signal: AbortSignal): Promise<ChatRouteDecision> {
    const token = (await chrome.storage.session.get('local-ai-session'))['local-ai-session'];
    if (typeof token !== 'string' || !/^ss3_[A-Za-z0-9_-]{43}$/.test(token))
      throw Error('unpaired');
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).length > 8192) throw new Fault('invalid_message');
    const response = await fetch('http://127.0.0.1:4317/v1/chat/route', {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 413) throw new Fault('invalid_message');
      if (response.status === 403) throw new RouteUnavailable('Local pairing expired or was refused. Reconnect in Settings, or choose a local action.');
      if (response.status === 429) throw new RouteUnavailable('Too many requests to the local service. Wait one minute before trying again.');
      throw Error('unavailable');
    }
    const raw = await boundedResponseText(response, 8192, 'invalid reply');
    let reply: ChatRouteReply;
    try {
      reply = ChatRouteReply.parse(JSON.parse(raw));
    } catch {
      throw new Fault('invalid_message');
    }
    if (reply.operationId !== input.operationId || reply.bindingToken !== input.bindingToken)
      throw new Fault('stale_document');
    if ((await chrome.storage.session.get('local-ai-session'))['local-ai-session'] !== token)
      throw new Fault('stale_document');
    if (reply.status === 'invalid_response') throw new Fault('invalid_message');
    if (reply.status === 'cancelled') throw new Fault('cancelled');
    if (reply.status === 'rate_limited' && reply.limitReason)
      throw new RouteUnavailable(generationLimitMessage(reply.limitReason));
    if (reply.status !== 'available') throw Error('unavailable');
    const decision = validatedChatRoute(reply.decision, input);
    if (!decision) throw new Fault('invalid_message');
    return decision;
  }
  private async dispatch(
    s: RecordState,
    o: Owner,
    feature: FeatureId,
    local: boolean,
    decision?: Routed,
  ) {
    const tab = await this.currentPage(s, o),
      turn = o.turn,
      goal = turn.original!;
    const url = new URL(tab.url!);
    if (feature === 'url_identity') {
      if (/\b(?:link|button|destination)\b/i.test(goal) && !/https?:\/\//i.test(goal)) {
        const link =
          s.snapshot?.context.documentId === turn.documentId ? s.snapshot.guide?.link : null;
        if (!link) {
          this.finish(
            o,
            'clarifying',
            'Which link do you want to check? Paste its public address without private query parameters.',
          );
        } else
          this.finish(
            o,
            'completed',
            link.host
              ? 'This observed link points to ' + link.host + '.'
              : 'The selected control has no inspectable link destination.',
          );
        return;
      }
      const pasted = goal.match(/https?:\/\/[^\s<>]+/i)?.[0];
      if (pasted && !URL.canParse(pasted)) {
        this.finish(o, 'unsupported', 'Enter a complete HTTP or HTTPS address.');
        return;
      }
      const raw = pasted ?? url.href;
      const expect =
        (decision?.feature === 'url_identity' && decision.slots.expected === 'amazon.com') ||
        chatExpectsAmazon(goal);
      if(!expect && !expectedAddress(goal) && /\b(?:the official (?:website|site)|site i (?:meant|expected))\b/i.test(goal)){
        this.finish(o,'clarifying','Which publisher or domain did you expect?');
        return;
      }
      this.finish(o, 'completed', addressReply(raw, expect,goal));
      return;
    }
    if(feature==='download_guidance' && url.origin==='https://www.videolan.org' && publisherBrowseGoal(goal)==='formats'){
      await this.send(s,tab,{kind:'assistGoal',goal});
      if(this.owns(s,o) && s.cp.task?.goal===goal){
        turn.taskId=s.cp.task.id;turn.epoch=s.cp.epoch;
        this.finish(o,'awaiting_user','Choose how to inspect the publisher’s current Windows package formats.');
      }
      return;
    }
    if (feature === 'download_guidance') {
      const choice = publisherChoice(goal, url.origin, turn.profile);
      if (choice.kind !== 'ready') {
        const options = choice.kind === 'unrelated' ? [] : choice.choices.map(selectedLabel);
        if (choice.kind === 'unsupported') {
          this.finish(o, 'unsupported', choice.message);
          return;
        }
        this.finish(
          o,
          'clarifying',
          choice.kind === 'unrelated'
            ? 'Which application and Windows package do you want to find?'
            : choice.message,
        );
        turn.choices = options;
        return;
      }
      turn.profile = choice.profile;
      await this.send(s, tab, {
        kind: 'assistGoal',
        goal,
        download: choice.profile,
        ...(local ? { localPublisher: true } : {}),
      });
      if (this.owns(s, o) && s.cp.task?.goal === goal) {
        turn.taskId = s.cp.task.id;
        turn.epoch = s.cp.epoch;
        this.finish(o, 'awaiting_user', 'Choose how to find the verified publisher download.');
      }
      return;
    }
    if (feature === 'visual_guidance' || feature === 'automatic_navigation') {
      const workflow = resolveGoal(goal);
      if ((workflow === 'wikipedia_cite_apa' && (!wikiCitationSubject(goal) || url.pathname==='/wiki/Phishing')) || workflow === 'videolan_windows_page') {
        // The existing guide starts as a separate explicit user action.
        this.finish(
          o,
          'awaiting_user',
          'Ready to show you the first step.',
        );
        return;
      }
      if (local && !settingsGoal(goal) && !localSiteGoal(profileForPage(url),goal)) {
        this.finish(
          o,
          'clarifying',
          'What do you want to find? Choose a local guide or describe a public goal.',
        );
        turn.choices = [
          'Find the APA citation',
          'Where is the Windows download page?',
          'Find my username settings',
        ];
        return;
      }
      await this.send(s, tab, { kind: 'assistGoal', goal });
      if (this.owns(s, o) && s.cp.task?.goal === goal) {
        turn.taskId = s.cp.task.id;
        turn.epoch = s.cp.epoch;
        this.finish(o, 'awaiting_user', 'Choose Show me or review automatic navigation.');
      }
      return;
    }
    turn.state = 'working';
    await this.publish(s);
    if (feature === 'site_trust') {
      await this.send(s, tab, { kind: 'review', selection: { kind: 'website' } });
      if (!this.owns(s, o)) return;
      if (!s.review || s.review.binding.documentId !== turn.documentId)
        throw new Fault('stale_document');
      turn.operationId = s.review.binding.operationId;
      this.finish(o, 'completed', 'Website check for ' + url.hostname + '.');
      return;
    }
    if (feature === 'page_cleanup') {
      if (restoreRequest(goal)) {
        if (!s.cleanup || s.cleanup.binding.documentId !== turn.documentId || !s.cleanup.hidden) {
          this.finish(o,'completed','There are no hidden SafeStep regions on this document.');
          return;
        }
        await this.send(s,tab,{kind:'clean',action:'restore'});
        if (!this.owns(s,o)) return;
        if (s.cleanup?.hidden) throw new Fault('stale_document');
        this.finish(o,'completed','Restored the page regions hidden by SafeStep.');
        return;
      }
      await this.send(s, tab, { kind: 'clean', action: 'preview' });
      if (!this.owns(s, o)) return;
      if (!s.cleanup || s.cleanup.binding.documentId !== turn.documentId)
        throw new Fault('stale_document');
      turn.operationId = s.cleanup.binding.operationId;
      this.finish(
        o,
        'preview_ready',
        'Cleanup preview is ready. Review the candidates before applying.',
      );
      return;
    }
    if (feature === 'shopping_alternatives') {
      if (!comparisonRoute(url)) {
        this.finish(
          o,
          'unsupported',
          'Open a supported offer on Resell.store or Mozilla Add-ons to compare alternatives.',
        );
        return;
      }
      const v = s.comparison,
        refer = decision?.feature === 'shopping_alternatives' && decision.slots.subjectRef;
      const prior =
        v &&
        o.conversation.turns.findLast(
          (x) =>
            x !== turn &&
            x.feature === 'shopping_alternatives' &&
            x.operationId === v.id &&
            x.scope === turn.scope &&
            x.documentId === turn.documentId &&
            x.original,
        );
      if (
        refer &&
        v &&
        prior &&
        v.baseline &&
        !['stale', 'paused', 'cancelled'].includes(v.status)
      ) {
        const original = v.settings.goal || prior.original!;
        const combined = original === goal ? goal : original + ' — ' + goal;
        if (combined.length > 240) {
          this.finish(
            o,
            'clarifying',
            'Restate the complete comparison in 240 characters or fewer. The current requirements are preserved.',
          );
          return;
        }
        turn.original = combined;
        await this.send(s, tab, {
          kind: 'compare',
          action: {
            op: 'edit',
            session: v.id,
            version: v.version,
            settings: {
              ...v.settings,
              mode: turn.comparisonMode ?? v.settings.mode,
              goal: combined,
            },
          },
        });
      } else await this.send(s, tab, { kind: 'compare', action: { op: 'prepare' } });
      if (!this.owns(s, o)) return;
      if (!s.comparison) throw new Fault('stale_document');
      turn.operationId = s.comparison.id;
      turn.version = s.comparison.version;
      this.finish(
        o,
        'awaiting_user',
        'Review the original item and confirm your comparison requirements.',
      );
      return;
    }
    const how = feature === 'seller_assessment' ? 'seller' : 'product';
    if (!shoppingRoute(url)) {
      this.finish(
        o,
        'unavailable',
        how === 'seller' && protectionAddress(tab.url!).identity === 'amazon_us'
          ? 'Exact Amazon seller-service feedback is unavailable. Marketplace identity does not establish seller service.'
          : 'No supported ' +
              how +
              ' source was identified here. Use the public Resell.store or Mozilla coverage in Help.',
      );
      return;
    }
    if (
      /\b(?:that|previous|other)\s+(?:seller|product|item|option)\b/i.test(goal) &&
      !s.shopping?.[how]
    ) {
      this.finish(
        o,
        'clarifying',
        'Which current ' + how + ' do you mean? Check the current item first.',
      );
      return;
    }
    await this.send(s, tab, { kind: 'shop', subject: how });
    if (!this.owns(s, o)) return;
    const result = s.shopping?.[how]?.data;
    if (!result || result.binding.documentId !== turn.documentId) throw new Fault('stale_document');
    turn.operationId = result.binding.operationId;
    const unavailable = [
      'source_unavailable',
      'identity_uncertain',
      'unsupported',
      'session_limit',
    ].includes(result.status);
    this.finish(
      o,
      unavailable ? 'unavailable' : result.status === 'loading' ? 'awaiting_user' : 'completed',
      unavailable
        ? 'The source could not establish this ' + how + ' assessment. Review its coverage.'
        : how === 'seller'
          ? 'Seller service findings from the inspected source.'
          : 'Product findings from the inspected source.',
    );
  }

  private async act(
    s: RecordState,
    t: chrome.tabs.Tab,
    c: ChatConversation,
    action: Extract<ChatAction, { op: 'act' }>,
  ): Promise<void> {
    const turn = c.turns.find((x) => x.id === action.turnId);
    if (!turn || c.activeTurnId !== turn.id || turn.historical || turn.role !== 'assistant')
      throw new Fault('stale_document');
    const o: Owner = { conversation: c, turn, tab: t, abort: new AbortController(), reveal: action.action==='reveal' };
    this.abort(s);
    this.current.set(s.cp.tabId, o);
    s.abortChat = () => {
      this.abort(s);
    };
    try {
      const tab = await this.currentPage(s, o);
      const task = s.cp.task;
      if (action.action === 'retry') {
        if (
          !turn.original ||
          !['unavailable', 'awaiting_access', 'error', 'unsupported', 'paused'].includes(turn.state)
        )
          throw new Fault('blocked_by_policy');
        return this.operate(s, tab, { op: 'submit', conversationId: c.id, text: turn.original });
      }
      if (action.action === 'restore') {
        await this.send(s, tab, { kind: 'restore' });
        return;
      }
      if (action.action === 'refreshEvidence' || action.action === 'dismissEvidence') {
        const shop =
          turn.feature === 'seller_assessment'
            ? 'seller'
            : turn.feature === 'product_assessment'
              ? 'product'
              : null;
        const review = turn.feature === 'site_trust' || turn.feature === 'download_guidance';
        const before = shop
          ? s.shopping?.[shop]?.data.binding
          : review
            ? s.review?.binding
            : undefined;
        if (
          !turn.operationId ||
          before?.operationId !== turn.operationId ||
          before.documentId !== turn.documentId
        )
          throw new Fault('stale_document');
        if (action.action === 'dismissEvidence') {
          await this.send(
            s,
            tab,
            shop ? { kind: 'shopDismiss', subject: shop } : { kind: 'reviewDismiss' },
          );
          turn.historical = true;
          c.activeTurnId = null;
          return;
        }
        const selection = s.review?.selection;
        if (!shop && !selection) throw new Fault('stale_document');
        await this.send(
          s,
          tab,
          shop ? { kind: 'shop', subject: shop } : { kind: 'review', selection: selection! },
        );
        if (!this.owns(s, o)) return;
        const updated = shop ? s.shopping?.[shop]?.data.binding : s.review?.binding;
        if (!updated || updated.documentId !== turn.documentId) throw new Fault('stale_document');
        turn.operationId = updated.operationId;
        return;
      }
      if (action.action === 'apply') {
        if (
          turn.feature !== 'page_cleanup' ||
          turn.state !== 'preview_ready' ||
          s.cleanup?.binding.operationId !== turn.operationId
        )
          throw new Fault('stale_document');
        await this.send(s, tab, { kind: 'clean', action: 'apply' });
        if (this.owns(s, o)) {
          turn.epoch = s.cp.epoch;
          this.finish(o, 'completed', 'Cleanup applied. Restore remains available.');
        }
        return;
      }
      if (!navigation(turn.feature)) throw new Fault('blocked_by_policy');
      const fixedGoal = resolveGoal(turn.original ?? '');
      if (
        action.action === 'guide' &&
        !turn.taskId &&
        (fixedGoal === 'wikipedia_cite_apa' || fixedGoal === 'videolan_windows_page')
      ) {
        await this.send(s, tab, { kind: 'guide', workflow: fixedGoal, goal: turn.original });
        if (this.owns(s, o) && s.cp.task?.goal === turn.original) {
          turn.taskId = s.cp.task!.id;
          turn.epoch = s.cp.epoch;
          turn.state = 'working';
        }
        return;
      }
      if (
        !turn.taskId ||
        task?.id !== turn.taskId ||
        task.cancelled ||
        (task.adaptive && turn.version !== undefined && turn.version !== task.adaptive.version)
      )
        throw new Fault('stale_document');
      if (task.adaptive) {
        await this.send(s, tab, {
          kind: 'assistControl',
          action: action.action === 'guide' ? 'next' : action.action,
        });
        const fresh = s.cp.task;
        if (
          action.action === 'localDownload' &&
          turn.feature === 'download_guidance' &&
          this.owns(s, o) &&
          fresh?.adaptive &&
          fresh.goal === turn.original &&
          fresh.adaptive.download === turn.profile
        ) {
          turn.taskId = fresh.id;
          turn.version = fresh.adaptive.version;
        }
      } else if (action.action === 'reveal') {
        const ref = s.snapshot?.guide?.ref;
        if (!ref) throw new Fault('element_missing');
        await this.send(s, tab, { kind: 'reveal', ref });
      } else if (['pause', 'resume', 'stop', 'takeover'].includes(action.action)) {
        await this.send(s, tab, {
          kind:
            action.action === 'stop' ? 'cancel' : action.action === 'resume' ? 'resume' : 'pause',
        });
      } else throw new Fault('blocked_by_policy');
      if (this.owns(s, o)) turn.epoch = s.cp.epoch;
    } finally {
      if (this.current.get(s.cp.tabId) === o) {
        this.current.delete(s.cp.tabId);
        delete s.abortChat;
      }
      if (s.cp.chat === c) await this.publish(s);
    }
  }
  async refresh(s: RecordState, t: chrome.tabs.Tab) {
    const before = JSON.stringify(s.cp.chat);
    await this.sync(s, t);
    if (s.cp.chat && before !== JSON.stringify(s.cp.chat)) {
      trimConversation(s.cp.chat);
      await this.store.save(s);
    }
  }
  private async sync(s: RecordState, t: chrome.tabs.Tab) {
    const c = s.cp.chat,
      turn = c?.turns.find((x) => x.id === c.activeTurnId);
    if (!c || !turn || turn.historical || this.current.has(s.cp.tabId)) return;
    if (navigation(turn.feature) && turn.taskId) {
      const task = s.cp.task;
      if (!task || turn.taskId !== task.id) {
        retireTurns(c);
        return;
      }
      if (task.adaptive && turn.version !== undefined && task.adaptive.version !== turn.version) {
        retireTurns(c);
        return;
      }
      if (
        (task.state === 'paused' || task.state === 'cancelled' || task.state === 'failed') &&
        turn.epoch !== s.cp.epoch &&
        turn.documentId &&
        turn.origin
      ) {
        const epoch = s.cp.epoch, revision = s.chatRevision, state = task.state;
        const current = await probe(t.id!, turn.origin).catch(() => null);
        // A completed older refresh has no authority over a replacement turn or task.
        if (s.cp.chat !== c || c.activeTurnId !== turn.id || turn.historical || s.cp.task !== task ||
            task.state !== state || s.cp.epoch !== epoch || s.chatRevision !== revision || this.current.has(s.cp.tabId)) return;
        if (current !== turn.documentId || permittedOrigin(t.url) !== turn.origin) {
          retireTurns(c);
          return;
        }
      }
      const bound =
        task.adaptive && task.documentId ? task.documentId : s.snapshot?.context.documentId;
      if (
        turn.documentId !== bound &&
        bound &&
        t.url &&
        permittedOrigin(t.url) === turn.origin &&
        !['paused', 'cancelled', 'failed'].includes(task.state)
      ) {
        const originalState = task.state,
          scope = await pageScope(s.cp.tabId, bound).catch(() => null);
        if (
          !scope ||
          s.cp.task !== task ||
          task.state !== originalState ||
          c.activeTurnId !== turn.id
        )
          return;
        turn.documentId = bound;
        turn.scope = scope;
      }
      turn.epoch = s.cp.epoch;
      if (
        turn.feature === 'download_guidance' &&
        s.review?.binding.taskId === task.id &&
        s.review.selection.kind === 'download' &&
        s.review.selection.profile === turn.profile &&
        s.review.selected
      )
        turn.operationId = s.review.binding.operationId;
      if (task.adaptive) turn.version = task.adaptive.version;
      const guide = task.guide;
      if (task.adaptive?.status) {
        turn.text = task.adaptive.status.slice(0, 600);
      } else if (guide) {
        if (task.state === 'completed') turn.text = workflows[guide.workflow].done;
        else if (task.state === 'cancelled') turn.text = 'Stopped by you.';
        else if (task.state === 'paused' || task.state === 'failed')
          turn.text = s.cp.issue ? messages[s.cp.issue] : 'Guidance is paused.';
        else if (task.state === 'showing_step') turn.text = workflows[guide.workflow].steps[guide.step - 1]!;
      }
      turn.state =
        task.state === 'completed'
          ? 'completed'
          : ['paused', 'cancelled', 'failed'].includes(task.state)
            ? 'paused'
            : task.state === 'planning'
              ? 'working'
              : 'awaiting_user';
    } else if (turn.feature === 'shopping_alternatives' && turn.operationId) {
      if (
        s.comparison?.id !== turn.operationId ||
        ['stale', 'paused', 'cancelled'].includes(s.comparison.status)
      ) {
        retireTurns(c);
        return;
      }
      turn.version = s.comparison.version;
      turn.text = s.comparison.message;
    } else if (turn.operationId) {
      const valid =
        turn.feature === 'page_cleanup'
          ? s.cleanup?.binding.operationId
          : turn.feature === 'site_trust'
            ? s.review?.binding.operationId
            : s.shopping?.[turn.feature === 'seller_assessment' ? 'seller' : 'product']?.data
                .binding.operationId;
      if (valid !== turn.operationId) retireTurns(c);
    }
  }
}
