import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiService,newPairToken } from '../apps/api/src/gemini';
import {
  articleMatchesQuery,
  chatRouteSite,
  checkedIntent,
  checkedStep,
  IntentInput,
  profileForPage,
  publicPath,
  publicSearchQuery,
  StepInput,
  validAssistInput,
  wikipediaSearchUrl,
} from '@safestep/contracts';

test('Confirmed download retains the original package modifier while the model must preserve product constraints', async (t) => {
  const goal='Help me find the right Windows x64 download.';
  const request=(text:string, confirmed=true)=>{
    const op=crypto.randomUUID(), revision=crypto.randomUUID();
    return IntentInput.parse({kind:'intent',goal:text,profile:'publisher',...(confirmed?{download:'seven_zip_windows_x64_exe'}:{}),operationId:op,bindingToken:revision,binding:{operationId:op,revision,taskId:crypto.randomUUID(),goalVersion:1,tabId:2,windowId:1,epoch:1,generation:1,documentId:'a'.repeat(32),origin:'https://www.7-zip.org'}});
  };
  const client=new GeminiService({GEMINI_API_KEY:'test-only-fixture',GEMINI_MODEL:'gemini-fixture-only'},newPairToken());
  let omitted='', inverted=false;
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    const b=JSON.parse(String(init.body));const p=JSON.parse(b.contents[0].parts[0].text);
    const id=(word:string)=>p.sourceWords.find((x:{text:string})=>x.text===word).id;
    const answer={action:'find_document',subjects:[id('find'),id('download')],constraints:['Windows','x64'].filter(w=>w!==omitted).map(id),excluded:inverted?[id('x64')]:[],question:'',choices:[]};
    return Response.json({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:JSON.stringify(answer)}]}}]});
  });
  const go=(g:string, confirmed=true)=>client.assist(request(g,confirmed),new AbortController().signal);
  const answer=await go(goal);
  assert.equal(answer.status,'available');assert(answer.explanation && 'constraints' in answer.explanation);
  assert.deepEqual(answer.explanation.constraints.map(x=>x.text),['right Windows x64']);
  assert.equal((await go(goal,false)).status,'invalid_response');
  omitted='x64';assert.equal((await go(goal)).status,'invalid_response');
  omitted='';inverted=true;assert.equal((await go(goal)).status,'invalid_response');
  inverted=false;assert.equal((await go('Help me find the signed Windows x64 download.')).status,'invalid_response');
  assert.equal((await go('Help me find the right Windows x64 download, not beta.')).status,'invalid_response');
});

test('Explicit Wikipedia article keeps its named site, requested topic and exclusions in a validated intent', async (t) => {
  const client = new GeminiService({GEMINI_API_KEY:'test-transport-only',GEMINI_MODEL:'gemini-fixture-only'},newPairToken());
  const controller = new AbortController();
  let omit = '', exclude = true;
  t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit) => {
    const body = JSON.parse(String(init.body));
    const source = JSON.parse(body.contents[0].parts[0].text).sourceWords as {id:string;text:string;explicitlyExcluded:boolean}[];
    const picked = source.filter(w => ['atmosphere','Earth','Venus'].includes(w.text) && w.text !== omit && !w.explicitlyExcluded);
    const reply = {action:'find_document',subjects:picked.map(w=>w.id),constraints:[],
      excluded:exclude ? source.filter(w=>w.explicitlyExcluded).map(w=>w.id) : [],question:'',choices:[]};
    return Response.json({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:JSON.stringify(reply)}]}}]});
  });
  const go = (goal:string) => {
    const operationId=crypto.randomUUID(),revision=crypto.randomUUID();
    return client.assist(IntentInput.parse({kind:'intent',goal,profile:'wikipedia',operationId,bindingToken:revision,
      binding:{operationId,revision,taskId:crypto.randomUUID(),documentId:'a'.repeat(32),tabId:1,windowId:1,
        goalVersion:1,epoch:1,generation:1,origin:'https://en.wikipedia.org'}}),controller.signal);
  };
  const exact = 'Show me how to find the Wikipedia article about the atmosphere of Earth.';
  const first = await go(exact);
  const intent = checkedIntent(first.explanation,exact);
  assert.equal(first.status,'available'); assert(intent);
  assert.deepEqual(intent.constraints.map(p=>p.text),['Wikipedia article']);
  assert.equal(publicSearchQuery(exact),'the atmosphere of Earth');
  assert(articleMatchesQuery('/wiki/Atmosphere_of_Earth',publicSearchQuery(exact)!));
  assert(!articleMatchesQuery('/wiki/Atmosphere_of_Mars',publicSearchQuery(exact)!));
  const variant = 'Take me to the Wikipedia article about the atmosphere of Venus, not Mars.';
  assert.equal((await go(variant)).status,'available');
  assert.equal(publicSearchQuery(variant),'the atmosphere of Venus');
  omit='Earth'; assert.equal((await go(exact)).status,'invalid_response');
  omit=''; exclude=false; assert.equal((await go(variant)).status,'invalid_response');
  assert.equal((await go('Find the newspaper article about the atmosphere of Earth.')).status,'invalid_response');
  assert.equal(publicSearchQuery('Wikipedia article about the atmosphere of Earth'),'Wikipedia article about the atmosphere of Earth');
  assert.equal(publicSearchQuery('Find the Wikipedia article about person@example.org.'),null);
});

test('Stage 7 public guidance admits ordinary content and confines private, opaque or transactional destinations', () => {
  for (const path of [
    '/settings-lab',
    '/settings-lab/account',
    '/settings-lab/username',
    '/assist-lab/docs#examples',
  ])
    assert.equal(publicPath(new URL(path, 'http://localhost:4174'), 'practice'), path);
  for (const raw of [
    'http://localhost:4174/settings-lab/account?token=x',
    'http://localhost:4174/settings-lab/account/save',
    'https://public.example.org/settings-lab/username',
  ])
    assert.equal(publicPath(new URL(raw), profileForPage(new URL(raw))), null);
  for (const path of [
    '/',
    '/articles/meteorology',
    '/library/reading#Schedule',
    '/news/observing-mars.html',
  ])
    assert.equal(publicPath(new URL(path, 'https://www.example.org'), 'experimental'), path);
  for (const raw of [
    'https://127.0.0.1/news',
    'https://device.local/news',
    'http://library.example.org/news',
    'https://u:s@library.example.org/a',
    'https://library.example.org/articles?token=x',
    'https://library.example.org/users/profile',
    'https://library.example.org/payments/checkout',
    'https://library.example.org/book.exe',
    'https://library.example.org/api/action',
    'https://library.example.org/articles/abcdefghijklmnopqrstuvwxyz1234567890',
  ])
    assert.equal(publicPath(new URL(raw), 'experimental'), null, raw);
  for (const raw of [
    'https://www.videolan.org/',
    'https://www.videolan.org/vlc/download-windows.html',
    'https://www.7-zip.org/download.html',
  ]) {
    const url = new URL(raw);
    assert.equal(profileForPage(url), 'publisher');
    assert.equal(publicPath(url, 'publisher'), url.pathname);
  }
  for (const raw of [
    'https://get.videolan.org/vlc/3.0.24/win64/vlc.exe',
    'https://www.7-zip.org/download.html?auth=x',
    'https://www.videolan.org/account',
  ])
    assert.equal(publicPath(new URL(raw), 'publisher'), null, raw);
});

test('Stage 7 Wikipedia public search binds an approved topic and allows only the verified read-only GET fields', () => {
  const topic = 'Find information about Earth’s atmosphere, not Mars.';
  assert.equal(publicSearchQuery(topic), 'Earth’s atmosphere');
  assert.equal(
    publicSearchQuery('Find information about the atmosphere of Mars.'),
    'the atmosphere of Mars',
  );
  assert(!publicSearchQuery('Find account for me@example.org'));
  const base = 'https://en.wikipedia.org';
  for (const path of [
    '/wiki/Main_Page',
    '/wiki/Earth%27s_atmosphere',
    '/wiki/Special:Search',
    '/wiki/Atmosphere_of_Mars#Composition',
  ])
    assert.equal(publicPath(new URL(base + path), 'wikipedia'), path);
  const u = new URL('/w/index.php?title=Special%3ASearch&search=Earth%27s+atmosphere', base);
  assert(wikipediaSearchUrl(u));
  assert.equal(publicPath(u, 'wikipedia'), '/wiki/Special:Search');
  assert(wikipediaSearchUrl(new URL(u + '&ns0=1')));
  assert(!wikipediaSearchUrl(new URL(u + '&ns0=2')));
  const hydrated = new URL('https://en.wikipedia.org/w/index.php?search=the+atmosphere+of+Earth&title=Special%3ASearch&wprov=acrw1_-1');
  assert(wikipediaSearchUrl(hydrated));
  assert(wikipediaSearchUrl(hydrated,'the atmosphere of Earth'));
  assert(!wikipediaSearchUrl(hydrated,'the atmosphere of Mars'));
  assert.equal(publicPath(hydrated,'wikipedia'),'/wiki/Special:Search');
  assert.deepEqual(chatRouteSite(hydrated.href),{origin:'https://en.wikipedia.org',path:'/wiki/Special:Search'});
  assert(wikipediaSearchUrl(new URL(hydrated + '&ns0=1')));
  assert(!wikipediaSearchUrl(new URL(hydrated + '&wprov=acrw1_0')));
  assert(!wikipediaSearchUrl(new URL(hydrated + '&token=secret')));
  assert(!wikipediaSearchUrl(new URL(hydrated + '&ns0=2')));
  for(const invalid of [
    hydrated + '&search=the+atmosphere+of+Mars',
    hydrated + '&title=Special%3ASearch',
    hydrated + '&ns0=1&ns0=1',
    hydrated + '&auth=private',
    hydrated + '#fragment',
    hydrated.href.replace('en.wikipedia.org','en.wikipedia.org.other.org'),
    hydrated.href.replace('en.wikipedia.org','user:private@en.wikipedia.org'),
    hydrated.href.replace('Special%3ASearch','Special%3AUserLogin'),
    hydrated.href.replace('/w/index.php','/w/wrong.php'),
  ]) assert(!wikipediaSearchUrl(new URL(invalid),'the atmosphere of Earth'));
  for(const bad of ['unexpected','acrw1_123','acrw1_-000','acrw1_0-private','#token']) {
    const invalid = new URL(hydrated);
    invalid.searchParams.set('wprov',bad);
    assert.equal(publicPath(invalid,'wikipedia'),null);
  }
  for (const raw of [
    u + '&token=abc',
    u + '&search=Mars',
    u + '#state',
    base + '/wiki/Special:UserLogin',
    base + '/wiki/User:Private',
    base + '/wiki/Earth?oldid=123',
  ])
    assert.equal(publicPath(new URL(raw), 'wikipedia'), null, raw);
  assert(articleMatchesQuery('/wiki/Earth%27s_atmosphere', 'Atmosphere of Earth'));
  assert(articleMatchesQuery('/wiki/Atmosphere_of_Mars', 'the atmosphere of Mars'));
  assert(!articleMatchesQuery('/wiki/Mars', 'Atmosphere of Earth'));
  assert(!articleMatchesQuery('/wiki/Earth', 'Atmosphere of Earth'));
});

test('Stage 7 planner accepts an observed Wikipedia search ref only in its bound profile', () => {
  const goal = "Find Earth's atmosphere",
    id = crypto.randomUUID(),
    token = crypto.randomUUID(),
    ref = crypto.randomUUID();
  const context = {
    operationId: id,
    bindingToken: token,
    goal,
    profile: 'wikipedia',
    binding: {
      taskId: crypto.randomUUID(),
      tabId: 2,
      windowId: 1,
      goalVersion: 1,
      epoch: 1,
      generation: 1,
      documentId: 'a'.repeat(32),
      revision: token,
      operationId: id,
      origin: 'https://en.wikipedia.org',
    },
  };
  assert(validAssistInput(IntentInput.parse({ ...context, kind: 'intent' })));
  const intent = {
    action: 'find_document',
    subjects: [{ text: "Earth's atmosphere", start: 5, end: 23 }],
    constraints: [],
    excluded: [],
    choices: [],
    question: '',
  };
  const search = {
    role: 'search',
    ref,
    label: 'Search Wikipedia',
    action: 'submit_public_search',
    visible: true,
    path: null,
  };
  const input = StepInput.parse({
    ...context,
    kind: 'step',
    intent,
    previous: [],
    snapshot: {
      profile: 'wikipedia',
      path: '/wiki/Main_Page',
      controls: [search],
      headings: [],
      limited: true,
      complete: null,
    },
  });
  assert(checkedIntent(intent, goal));
  assert(validAssistInput(input));
  const step = { kind: 'next_candidate', action: 'submit_public_search', ref, citations: [ref] };
  assert(checkedStep(step, input));
  assert(!checkedStep({ ...step, ref: crypto.randomUUID() }, input));
  assert(
    !validAssistInput({
      ...input,
      profile: 'experimental',
      binding: { ...input.binding, origin: 'https://www.example.org' },
      snapshot: { ...input.snapshot, profile: 'experimental', path: '/library' },
    }),
  );
});
