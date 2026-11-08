import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChatConversation, validatedChatRoute, type ChatRouteInput, type PanelRequest, type SourceCoverage } from '@safestep/contracts';
import { observeAddress } from '../apps/extension/sites/address';
import { Store } from '../apps/extension/core/store';
import { Chat } from '../apps/extension/core/chat';
import {
  emptyConversation,
  makeTurn,
  routedHistory,
  trimConversation,
} from '../apps/extension/core/conversation';

function fixture(t: TestContext, url = 'https://en.wikipedia.org/wiki/Phishing') {
  const tab = { id: 7, windowId: 3, url, active: true } as chrome.tabs.Tab;
  const page = { doc: 'original-document', scope: 'a'.repeat(64) };
  const memory: Record<string, unknown> = {};
  const fake = {
    tabs: { get: async () => tab },
    windows: { get: async () => ({ focused: true }) },
    permissions: { contains: async () => false },
    runtime: { sendMessage: async () => {} },
    scripting: {
      executeScript: async (args: { target: { documentIds?: string[] } }) => [
        {
          frameId: 0,
          documentId: page.doc,
          result: args.target.documentIds ? page.scope : new URL(tab.url!).origin,
        },
      ],
    },
    storage: {
      session: {
        get: async (k: string) => ({ [k]: memory[k] }),
        set: async (values: Record<string, unknown>) => Object.assign(memory, values),
      },
    },
  };
  const old = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { value: fake, configurable: true });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'chrome', old);
    else Reflect.deleteProperty(globalThis, 'chrome');
  });
  const store = new Store(),
    s = store.get(tab.id!),
    sent: PanelRequest['command'][] = [];
  let effect: (command: PanelRequest['command']) => void = () => {};
  s.cp.invokedOrigin = new URL(tab.url!).origin;
  const chat = new Chat(store, async (_s, _t, cmd) => {
    sent.push(cmd);
    effect(cmd);
  });
  const current = () => s.cp.chat!.turns.find((x) => x.id === s.cp.chat!.activeTurnId)!;
  return {
    s,
    tab,
    chat,
    sent,
    page,
    memory,
    current,
    setEffect: (f: typeof effect) => {
      effect = f;
    },
  };
}

test('a late document probe for the paused catalog guide cannot retire the new storefront seller turn', async t => {
  const { s,tab,page,chat,current,sent }=fixture(t,'https://nibdrawer.resell.store/lamy-2000-makrolon');
  s.cp.epoch=2;
  const c=s.cp.chat=emptyConversation();
  const old=makeTurn('assistant','Open the outlined listing.','https://resell.store',1,'prior-catalog-document');
  old.feature='visual_guidance';old.taskId=crypto.randomUUID();old.state='paused';
  c.turns.push(old);c.activeTurnId=old.id;
  s.cp.task={id:old.taskId,tabId:tab.id!,goal:'Open a fountain pen',mode:'guide',state:'paused',epoch:2,documentId:null,revision:null,lastVerified:null,steps:2,cancelled:false};
  const began=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  let first=true;
  const execute=chrome.scripting.executeScript;
  t.mock.method(chrome.scripting,'executeScript',async(args:Parameters<typeof execute>[0])=>{
    if(first){first=false;began.resolve();await finish.promise;}
    return execute(args);
  });
  const checkingPreviousDocument=chat.refresh(s,tab);
  await began.promise;
  await chat.operate(s,tab,{op:'shortcut',feature:'seller_assessment',text:'Check this seller.'});
  const next=current();
  assert.equal(next.feature,'seller_assessment');assert.equal(next.documentId,page.doc);
  assert(sent.some(x=>x.kind==='shop'));
  finish.resolve();await checkingPreviousDocument;
  assert.equal(c.activeTurnId,next.id);assert.equal(next.historical,false);
});
test('an unchanged paused guide still retires when its own recorded document has been replaced', async t=>{
  const {s,tab,chat}=fixture(t,'https://resell.store/discover');
  s.cp.epoch=2;
  const c=s.cp.chat=emptyConversation();
  const old=makeTurn('assistant','Use the highlighted result.','https://resell.store',1,'replaced-document');
  old.feature='visual_guidance';old.taskId=crypto.randomUUID();old.state='paused';
  c.turns.push(old);c.activeTurnId=old.id;
  s.cp.task={id:old.taskId,tabId:tab.id!,goal:'Open a listing',mode:'guide',state:'paused',epoch:2,documentId:null,revision:null,lastVerified:null,steps:2,cancelled:false};
  await chat.refresh(s,tab);assert.equal(c.activeTurnId,null);assert.equal(old.historical,true);
});
for(const [action,verified,preserve] of [['reveal',true,true],['reveal',false,false],['guide',true,false]] as const){
  test('a pending '+action+' at Wikipedia article handoff (verified='+verified+')',async t=>{
    const url='https://en.wikipedia.org/w/index.php?title=Special:Search&search=Phishing';
    const {s,tab,chat,page,sent}=fixture(t,url),c=s.cp.chat=emptyConversation();
    const goal='Find the Phishing article and its APA citation.';
    const turn=makeTurn('assistant','Open Phishing','https://en.wikipedia.org',s.cp.epoch,page.doc);
    Object.assign(turn,{feature:'visual_guidance',taskId:crypto.randomUUID(),state:'awaiting_user',scope:page.scope,version:1});
    c.turns.push(turn);c.activeTurnId=turn.id;
    s.cp.task={id:turn.taskId!,tabId:tab.id!,goal,mode:'guide',state:'showing_step',epoch:s.cp.epoch,
      documentId:page.doc,revision:crypto.randomUUID(),lastVerified:'inspected',steps:1,cancelled:false};
    const began=Promise.withResolvers<void>(),done=Promise.withResolvers<void>(),execute=chrome.scripting.executeScript;
    t.mock.method(chrome.scripting,'executeScript',async(args:Parameters<typeof execute>[0])=>{
      began.resolve();await done.promise;return execute(args);
    });
    const pending=chat.operate(s,tab,{op:'act',conversationId:c.id,turnId:turn.id,action});
    await began.promise;
    tab.url='https://en.wikipedia.org/wiki/Phishing?wprov=srpw1_0';
    await chat.changed(s,true,verified);
    done.resolve();await assert.rejects(pending);
    assert.equal(c.activeTurnId,preserve?turn.id:null);assert.equal(turn.historical,!preserve);
    assert.equal(turn.documentId,page.doc);assert.equal(sent.length,0);
  });
}

test('Conversation history is bounded per tab and only same-document, same-subject, relevant text can be sent', () => {
  const c = emptyConversation();
  for (let i = 0; i < 72; i++) {
    const t = makeTurn('user', 'example words '.repeat(16), 'https://example.org', 1, 'doc');
    t.scope = 'a';
    c.turns.push(t);
  }
  c.activeTurnId = c.turns.at(-1)!.id;
  trimConversation(c);
  assert(ChatConversation.safeParse(c).success);
  assert(c.turns.length <= 50);
  assert(c.turns.some((t) => t.id === c.activeTurnId));
  const h = routedHistory(c, 'https://example.org', 'doc', 'a', 'none');
  assert.equal(h.length, 6);
  assert(h.reduce((n, t) => n + t.text.length, 0) <= 1600);
  assert.deepEqual(routedHistory(c, 'https://other.example', 'doc', 'a', 'none'), []);
  assert.deepEqual(routedHistory(c, 'https://example.org', 'doc', 'b', 'none'), []);
});

test('SS8-01 neutral article and path names never imply an Amazon expectation; explicit requests and hostname policy remain active', async (t) => {
  const {chat, s, tab, sent, current} = fixture(t, 'https://www.wayfair.com/');
  for (const [text, finding] of [
    ['https://example.org/amazon', /^Actual hostname: example\.org\./],
    ['https://example.org/river', /^Actual hostname: example\.org\./],
    ['Check this address: https://en.wikipedia.org/wiki/Amazon', /^Actual hostname: en\.wikipedia\.org\./],
    ['Check this expected Amazon address: https://example.org/amazon', /example\.org does not match the expected Amazon/],
    ['Check this expected Amazon address: https://www.amazon.com/', /www\.amazon\.com matches the expected Amazon/],
    ['https://www.amazon.com/', /www\.amazon\.com matches the expected Amazon/],
    ['https://amazon.com.example.org/', /actual host is amazon\.com\.example\.org/],
    ['Check this address, not Amazon: https://example.org/amazon', /^Actual hostname: example\.org\./],
  ] as const) {
    await chat.operate(s, tab, {op:'submit',text});
    assert.equal(current().state,'completed',text);
    assert.equal(current().feature,'url_identity',text);
    assert.match(current().text,finding,text);
  }
  assert.deepEqual(sent,[]);
  assert.equal(tab.url,'https://www.wayfair.com/');
  const proposal = {kind:'routed',feature:'url_identity',reason:'Compare the address.',slots:{expected:'amazon.com'}};
  const context: ChatRouteInput = {
    version:1,operationId:crypto.randomUUID(),bindingToken:crypto.randomUUID(),conversationId:crypto.randomUUID(),turnId:crypto.randomUUID(),contextKey:crypto.randomUUID(),
    text:'Check this address: https://en.wikipedia.org/wiki/Amazon',history:[],site:{origin:'https://www.wayfair.com',path:null},subjects:[],available:['url_identity'],mode:null,
  };
  assert.equal(validatedChatRoute(proposal,context),null);
  assert.equal(validatedChatRoute(proposal,{...context,text:'Check this address',history:[{role:'user',text:'Check this address: https://en.wikipedia.org/wiki/Amazon'}]}),null);
  assert.deepEqual(validatedChatRoute(proposal,{...context,text:'Does this link match Amazon?'}),proposal);
});

test('SS8-02 a new website check supersedes package clarification; old choices cannot execute and a displayed package answer preserves the original request', async t => {
  const {chat,s,tab,page,sent,current,setEffect}=fixture(t,'https://www.videolan.org/');
  setEffect(cmd=>{
    if(cmd.kind!=='review')return;
    const at=new Date().toISOString(), host=new URL(tab.url!).hostname;
    const unavailable=(kind:SourceCoverage['kind']):SourceCoverage=>({kind,source:'unavailable',state:'unavailable',subject:host,observedAt:at,expiresAt:null});
    s.review={binding:{operationId:crypto.randomUUID(),taskId:null,tabId:tab.id!,documentId:page.doc,epoch:s.cp.epoch,revision:crypto.randomUUID(),generation:1,origin:new URL(tab.url!).origin},
      selection:cmd.selection,at,fixture:true,address:observeAddress(tab.url!,tab.url!,null),limited:true,frames:false,observations:[],
      sources:[unavailable('business_reviews'),unavailable('homepage_threat')],status:'limited_information',fileState:null,candidates:[],selected:null,placement:null};
  });
  const open=()=>chat.operate(s,tab,{op:'shortcut',feature:'download_guidance',text:'Find a download'});
  await open(); const original=current(), conversationId=s.cp.chat!.id;
  assert(original.choices?.includes('VLC · Windows x64 EXE'));
  await chat.operate(s,tab,{op:'submit',text:'Check this website',replyTo:original.id,conversationId});
  assert.equal(current().feature,'site_trust');
  assert.equal(current().state,'completed');
  assert.equal(current().original,'Check this website');
  assert.equal(sent.at(-1)?.kind,'review');
  assert.equal(original.historical,true);
  const count=sent.length;
  await assert.rejects(chat.operate(s,tab,{op:'submit',text:original.choices![0]!,replyTo:original.id,conversationId}));
  await assert.rejects(chat.operate(s,tab,{op:'act',action:'guide',turnId:original.id,conversationId}));
  assert.equal(sent.length,count);
  await chat.operate(s,tab,{op:'clear',conversationId});
  await chat.operate(s,tab,{op:'submit',text:'Check this website'});
  assert.equal(current().feature,'site_trust'); assert.equal(current().state,'completed');
  await open(); const next=current();
  await chat.operate(s,tab,{op:'submit',text:next.choices![0]!,replyTo:next.id,conversationId:s.cp.chat!.id});
  assert.deepEqual(sent.at(-1),{kind:'assistGoal',goal:'Find a download',download:'vlc_windows_x64',localPublisher:true});
  await open(); const last=current(),calls=sent.length;
  await chat.operate(s,tab,{op:'submit',text:'Not VLC or Windows.',replyTo:last.id,conversationId:s.cp.chat!.id});
  assert.equal(current().original,'Find a download — Not VLC or Windows.');
  assert.equal(sent.length,calls);
});

test('Unsupported keyless free text is preserved, secret input is omitted, and clearing chat preserves existing page ownership', async (t) => {
  const { chat, s, tab, sent, current, memory } = fixture(t);
  const original = 'Find the history of knitting without buying anything.';
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('Unexpected network call');
  });
  await chat.operate(s, tab, { op: 'submit', text: original });
  assert.equal(current().state, 'unavailable');
  assert.equal(current().original, original);
  assert.equal(sent.length, 0);
  await chat.operate(s, tab, { op: 'submit', text: 'Change my password.' });
  assert.equal(current().state, 'unsupported');
  assert.equal(current().original, 'Change my password.');
  assert.equal(sent.length, 0);
  await chat.operate(s, tab, { op: 'submit', text: 'My password is password: secret-pass' });
  assert(!JSON.stringify(s.cp.chat).includes('secret-pass'));
  assert.equal(current().state, 'clarifying');
  await chat.operate(s, tab, { op: 'submit', text: 'Cookies: demo=private_marker' });
  assert(!JSON.stringify(s.cp.chat).includes('private_marker'));
  const oldChat = s.cp.chat!.id;
  s.cp.cleanup = {
    operationId: crypto.randomUUID(),
    taskId: null,
    tabId: 7,
    epoch: 0,
    generation: 1,
    documentId: 'original-document',
    origin: 'https://en.wikipedia.org',
    revision: crypto.randomUUID(),
  };
  memory.budget = 14;
  const restoreOwner = s.cp.cleanup.operationId;
  await chat.operate(s, tab, { op: 'clear', conversationId: oldChat });
  assert.notEqual(s.cp.chat!.id, oldChat);
  assert.equal(memory.budget, 14);
  assert.equal(s.cp.cleanup.operationId, restoreOwner);
  assert.equal(s.cp.invokedOrigin, 'https://en.wikipedia.org');
  assert.equal(s.cp.chat!.turns.length, 0);
});

for (const transition of ['same page', 'clear', 'other site', 'replacement document'] as const) {
  test('Routing goal ownership after ' + transition, async (t) => {
    const { s, tab, page, memory, chat, current, setEffect } = fixture(t);
    const goal = 'Find the APA citation';
    setEffect((cmd) => {
      if (cmd.kind !== 'guide') return;
      s.cp.task = {
        id: crypto.randomUUID(),
        tabId: tab.id!,
        goal: cmd.goal!,
        mode: 'guide',
        state: 'showing_step',
        epoch: s.cp.epoch,
        documentId: page.doc,
        revision: null,
        lastVerified: 'inspected',
        steps: 0,
        cancelled: false,
      };
    });
    await chat.operate(s, tab, { op: 'submit', text: goal });
    await chat.operate(s, tab, {
      op: 'act',
      conversationId: s.cp.chat!.id,
      turnId: current().id,
      action: 'guide',
    });
    assert.equal(current().taskId, s.cp.task!.id);
    if (transition === 'clear') {
      await chat.operate(s, tab, { op: 'clear', conversationId: s.cp.chat!.id });
    } else if (transition !== 'same page') {
      if (transition === 'other site') tab.url = 'https://second.example.org/public';
      page.doc = 'replacement-document';
      page.scope = 'b'.repeat(64);
      s.cp.epoch++;
      s.cp.invokedOrigin = new URL(tab.url!).origin;
      await chat.changed(s, true);
    }
    memory['local-ai-session'] = 'ss3_' + 'a'.repeat(43);
    let captures = 0;
    let payload: { subjects: { kind: string; label: string }[]; history: unknown[] } | undefined;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      captures++;
      const body = JSON.parse(String(init?.body));
      payload = body;
      return Response.json({
        operationId: body.operationId,
        bindingToken: body.bindingToken,
        status: 'available',
        decision: { kind: 'unsupported', reason: 'No supported choice.', suggestions: [] },
        elapsedMs: 1,
        tokens: 0,
      });
    });
    await chat.operate(s, tab, {
      op: 'submit',
      text: 'Tell me what visitors reported about this site.',
    });
    assert.equal(captures, 1);
    assert.equal(s.cp.task?.goal, goal);
    const routedGoals = payload!.subjects.filter((x) => x.kind === 'goal').map((x) => x.label);
    if (transition === 'same page') {
      assert.deepEqual(routedGoals, [goal]);
    } else {
      assert.deepEqual(payload!.history, []);
      assert.deepEqual(routedGoals, [], 'an earlier chat or page cannot supply the current goal');
    }
  });
}

test('An invalid route cannot trigger even an otherwise recognized local shortcut', async (t) => {
  const { chat, s, tab, sent, memory, current } = fixture(t);
  memory['local-ai-session'] = 'ss3_' + 'b'.repeat(43);
  let mode = 'unregistered';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const i = JSON.parse(String(init?.body));
    return Response.json({
      operationId: i.operationId,
      bindingToken: i.bindingToken,
      status: mode === 'unregistered' ? 'available' : 'invalid_response',
      decision:
        mode === 'unregistered'
          ? { kind: 'routed', feature: 'execute_script', reason: 'arbitrary', slots: {} }
          : null,
      elapsedMs: 1,
      tokens: 5,
    });
  });
  for (const trial of ['unregistered', 'invalid_response']) {
    mode = trial;
    await chat.operate(s, tab, { op: 'submit', text: 'Check this website' });
    assert.equal(current().state, 'error');
    assert.equal(sent.length, 0);
  }
});

test('Cleanup uses the existing preview and its exact binding, while stale preview actions cannot apply changes', async (t) => {
  const { chat, s, tab, sent, current, setEffect } = fixture(t);
  setEffect((c) => {
    if (c.kind !== 'clean' || c.action !== 'preview') return;
    const binding = {
      operationId: crypto.randomUUID(),
      taskId: null,
      tabId: 7,
      epoch: 0,
      generation: 1,
      documentId: 'original-document',
      origin: 'https://en.wikipedia.org',
      revision: crypto.randomUUID(),
    };
    s.cp.cleanup = binding;
    s.cleanup = { binding, items: [], hidden: 0, uncertain: false, limited: false, enabled: false };
  });
  await chat.operate(s, tab, { op: 'shortcut', feature: 'page_cleanup', text: 'Preview cleanup' });
  const c = s.cp.chat!,
    first = current();
  assert.equal(first.state, 'preview_ready');
  assert.deepEqual(sent, [{ kind: 'clean', action: 'preview' }]);
  s.cleanup!.binding.operationId = crypto.randomUUID();
  await assert.rejects(
    chat.operate(s, tab, { op: 'act', conversationId: c.id, turnId: first.id, action: 'apply' }),
  );
  assert.equal(sent.length, 1);
  await chat.operate(s, tab, { op: 'shortcut', feature: 'page_cleanup', text: 'Preview cleanup' });
  await chat.operate(s, tab, {
    op: 'act',
    conversationId: c.id,
    turnId: current().id,
    action: 'apply',
  });
  assert.equal(current().state, 'completed');
  assert.equal(sent.at(-1)?.kind, 'clean');
});

test('Clarifying and following a reply preserves the exact original negation, and another tab cannot act on the old conversation', async (t) => {
  const { chat, s, tab, memory, current, sent } = fixture(t);
  memory['local-ai-session'] = 'ss3_' + 'c'.repeat(43);
  const inputs: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const i = JSON.parse(String(init?.body));
    inputs.push(i.text);
    return Response.json({
      operationId: i.operationId,
      bindingToken: i.bindingToken,
      status: 'available',
      elapsedMs: 1,
      tokens: 4,
      decision: {
        kind: 'clarify',
        question: 'Which comparison do you want?',
        choices: ['Same product', 'Similar products'],
      },
    });
  });
  const first = 'Check the other one, without paid add-ons.';
  await chat.operate(s, tab, { op: 'submit', text: first });
  const old = current();
  assert.equal(old.state, 'clarifying');
  await chat.operate(s, tab, {
    op: 'submit',
    text: 'Same product',
    replyTo: old.id,
    conversationId: s.cp.chat!.id,
  });
  assert.equal(inputs.at(-1), first + ' — Same product');
  await chat.changed(s);
  assert.equal(s.cp.chat!.activeTurnId, null);
  await assert.rejects(
    chat.operate(s, tab, {
      op: 'act',
      conversationId: s.cp.chat!.id,
      turnId: old.id,
      action: 'retry',
    }),
  );
  assert.equal(sent.length, 0);
});

test('Local citation and VideoLAN information aliases prepare a guide and require a current explicit activation', async (t) => {
  const { chat, s, tab, page, sent, current } = fixture(t);
  await chat.operate(s, tab, { op: 'submit', text: 'Find the APA citation' });
  const initial = current(),
    c = s.cp.chat!;
  assert.equal(initial.feature, 'visual_guidance');
  assert.equal(initial.state, 'awaiting_user');
  assert.equal(sent.length, 0);
  page.scope = 'b'.repeat(64);
  await assert.rejects(
    chat.operate(s, tab, { op: 'act', conversationId: c.id, turnId: initial.id, action: 'guide' }),
  );
  assert.equal(sent.length, 0);
  await chat.operate(s, tab, { op: 'submit', text: 'Where is the Windows download page?' });
  assert.equal(current().feature, 'visual_guidance');
  await chat.operate(s, tab, {
    op: 'act',
    conversationId: c.id,
    turnId: current().id,
    action: 'guide',
  });
  assert.deepEqual(sent, [
    {
      kind: 'guide',
      goal: 'Where is the Windows download page?',
      workflow: 'videolan_windows_page',
    },
  ]);
  await assert.rejects(
    chat.operate(s, tab, {
      op: 'act',
      conversationId: c.id,
      turnId: initial.id,
      action: 'automatic',
    }),
  );
  await chat.recover(s);
  assert.equal(c.activeTurnId, null);
  assert.equal(sent.length, 1);
});

test('Publisher clarification keeps the requested product and uses local existing steps with no installer action', async (t) => {
  const { chat, s, tab, sent, current } = fixture(t, 'https://www.videolan.org/');
  const goal = 'Help me find the Windows VLC download.';
  await chat.operate(s, tab, { op: 'submit', text: goal });
  const clarified = current();
  assert.equal(clarified.state, 'clarifying');
  assert.deepEqual(clarified.choices, ['VLC · Windows x64 EXE']);
  await chat.operate(s, tab, {
    op: 'submit',
    text: clarified.choices![0]!,
    replyTo: clarified.id,
    conversationId: s.cp.chat!.id,
  });
  assert.deepEqual(sent, [
    { kind: 'assistGoal', goal, download: 'vlc_windows_x64', localPublisher: true },
  ]);
  assert.equal(current().original, goal);
  await chat.operate(s, tab, { op: 'submit', text: 'Find the Firefox download for Windows.' });
  assert.equal(current().state, 'unsupported');
  assert.equal(sent.length, 1);
});

test('Help guidance choices select the named offline task and never start automatic navigation on selection', async (t) => {
  const { chat, s, tab, current, sent } = fixture(t, 'http://localhost:41994/settings-lab');
  for (const [feature, text] of [
    ['visual_guidance', 'Guide me on this page'],
    ['automatic_navigation', 'Guide an automatic task'],
  ] as const) {
    await chat.operate(s, tab, { op: 'shortcut', feature, text });
    const prompt = current();
    assert.equal(prompt.state, 'clarifying');
    await chat.operate(s, tab, {
      op: 'submit',
      text: 'Find my username settings',
      replyTo: prompt.id,
      conversationId: s.cp.chat!.id,
    });
    assert.equal(current().original, 'Find my username settings');
    assert.equal(current().feature, feature);
    assert.deepEqual(sent.at(-1), { kind: 'assistGoal', goal: 'Find my username settings' });
  }
  assert(!sent.some((c) => c.kind === 'assistControl' && c.action === 'automatic'));
});

test('A late labelled router response cannot invoke a newly selected Resell listing or a cleared conversation', async (t) => {
  const origin = 'https://foxedandfound.resell.store';
  const { chat, s, tab, sent, page, memory, current } = fixture(
    t,
    origin + '/mastering-art-french-cooking-1961',
  );
  memory['local-ai-session'] = 'ss3_' + 'a'.repeat(43);
  let release!: () => void, started!: () => void;
  let start = new Promise<void>((ok) => {
    started = ok;
  });
  const fn = t.mock.method(globalThis, 'fetch', async (_raw: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body));
    assert.deepEqual(req.site, { origin, path: null });
    assert(!String(init?.body).includes(new URL(tab.url!).pathname));
    started();
    await new Promise<void>((ok) => {
      release = ok;
    });
    return Response.json({
      operationId: req.operationId,
      bindingToken: req.bindingToken,
      status: 'available',
      decision: {
        kind: 'routed',
        feature: 'site_trust',
        reason: 'Inspect this site.',
        slots: {},
      },
      elapsedMs: 2,
      tokens: 8,
    });
  });
  let pending = chat.operate(s, tab, {
    op: 'submit',
    text: 'Tell me what evidence there is about this merchant.',
  });
  await start;
  tab.url = origin + '/mastering-art-french-cooking-1973';
  page.scope = 'b'.repeat(64);
  release();
  await pending;
  assert.equal(current().state, 'stale');
  assert.equal(sent.length, 0);
  start = new Promise<void>((ok) => {
    started = ok;
  });
  pending = chat.operate(s, tab, { op: 'submit', text: 'Tell me more about this website.' });
  await start;
  const old = s.cp.chat!.id;
  await chat.operate(s, tab, { op: 'clear', conversationId: old });
  release();
  await pending;
  assert.equal(fn.mock.callCount(), 2);
  assert.equal(sent.length, 0);
  assert.equal(s.cp.chat!.turns.length, 0);
});
