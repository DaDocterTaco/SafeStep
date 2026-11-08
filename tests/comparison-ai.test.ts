import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  CompareAIInput,
  CompareAIReply,
  applyComparisonIntent,
  CompareInterpretation,
  defaultCompareSettings,
  validatedComparisonAI,
  explicitCompareRules,
  CompareAction,
} from '@safestep/contracts';
import { GeminiService, newPairToken } from '../apps/api/src/gemini';
import { makeApi } from '../apps/api/src/app';
const goal = 'Find similar Firefox extensions under USD 30 item price, exclude trackers.';
function request(kind: 'intent' | 'explain') {
  const owner = {
    operationId: crypto.randomUUID(),
    bindingToken: crypto.randomUUID(),
    session: crypto.randomUUID(),
    version: 1,
  };
  return CompareAIInput.parse(
    kind === 'intent'
      ? { ...owner, kind, goal, settings: { ...defaultCompareSettings(), goal } }
      : {
          ...owner,
          kind,
          facts: [
            { id: 'f1', candidate: 'c1', text: 'Shipping is unknown.' },
            { id: 'f2', candidate: 'c0', text: 'Keep the original.' },
          ],
        },
  );
}
const valid = {
  mode: 'similar_products',
  rules: [
    { field: 'platform', value: 'Firefox', exclude: false },
    { field: 'feature', value: 'trackers', exclude: true },
  ],
  allowed: ['model'],
  priorities: ['feature'],
  question: '',
};

test('SS8-04 preserves the original comparison and deduplicates its signed rules through search', () => {
  const exact = 'Find similar ad blockers for Firefox. Firefox compatibility is required. Exclude Chrome.';
  const mixed = 'Find similar ad blockers for FIREFOX. firefox compatibility is required. Exclude chrome.';
  for (const original of [exact, mixed, 'Find similar ad blockers for Firefox. Exclude Chrome.']) {
    const anchors=explicitCompareRules(original);
    assert.equal(anchors.length,2);
    assert.deepEqual(anchors.map(r=>[r.value.toLowerCase(),r.exclude]),[['firefox',false],['chrome',true]]);
    assert.equal(anchors[0]!.value,original===mixed?'FIREFOX':'Firefox');
    const start={...defaultCompareSettings(),goal:original,
      hard:[anchors[0]!,{...anchors[0]!,value:'firefox'},anchors[1]!]};
    const proposed=CompareInterpretation.parse({...valid,rules:[...anchors,{...anchors[0]!,value:'Firefox'}]});
    const input=CompareAIInput.parse({...request('intent'),goal:original,settings:start});
    const accepted=validatedComparisonAI(proposed,input);
    assert(accepted && 'rules' in accepted);
    assert.deepEqual(accepted.rules,anchors);
    const after=applyComparisonIntent(start,accepted);
    const action=CompareAction.parse({op:'find',session:crypto.randomUUID(),version:2,
      settings:{...after,hard:[...after.hard,{...anchors[0]!,value:'firefox'}]}});
    assert(action.op==='find');
    assert.equal(action.settings.goal,original);
    assert.deepEqual(action.settings.hard,anchors);
  }
});

test('SS8-04 keeps distinct platforms, attributes and opposite signs, and rejects a dropped sign',()=>{
  const original='Find similar Firefox and Linux extensions. Exclude Firefox and Chrome.';
  const rules=explicitCompareRules(original);
  assert.deepEqual(rules.map(r=>[r.value,r.exclude]),[
    ['Firefox',false],['Linux',false],['Firefox',true],['Chrome',true],
  ]);
  const start={...defaultCompareSettings(),goal:original,hard:[{field:'feature',value:'Firefox',exclude:false}]};
  const input=CompareAIInput.parse({...request('intent'),goal:original,settings:start});
  const result={...valid,rules};
  assert(validatedComparisonAI(result,input));
  assert.equal(validatedComparisonAI({...result,rules:rules.slice(1)},input),null);
  assert.equal(applyComparisonIntent(start,CompareInterpretation.parse(result)).hard.length,5);
});
test('Comparison intent and explanation preserve hard constraints, budgets, reference ownership and local decisions', () => {
  const i = request('intent');
  assert(i.kind === 'intent');
  assert(validatedComparisonAI(valid, i));
  const settings = applyComparisonIntent(
    { ...i.settings, hard: [{ field: 'condition', value: 'new', exclude: false }] },
    CompareInterpretation.parse(valid),
  );
  assert.deepEqual(settings.budget, { amount: '30', currency: 'USD', basis: 'item' });
  assert.equal(settings.hard.length, 3);
  for (const bad of [
    { ...valid, rules: [] },
    { ...valid, rules: [valid.rules[0]] },
    { ...valid, mode: 'same_product_other_sellers' },
    { ...valid, rules: [{ field: 'platform', value: 'Windows', exclude: false }] },
    { ...valid, allowed: ['nib'] },
  ])
    assert.equal(validatedComparisonAI(bad, i), null);
  const x = request('explain');
  for (const raw of [
    { selected: [{ candidate: 'c1', fact: 'f2' }] },
    { selected: [{ candidate: 'c1', fact: 'f9' }] },
    { selected: [{ candidate: 'c1', fact: 'f1' }], price: '0.00' },
    {
      selected: [
        { candidate: 'c1', fact: 'f1' },
        { candidate: 'c1', fact: 'f1' },
      ],
    },
  ])
    assert.equal(validatedComparisonAI(raw, x), null);
  assert(validatedComparisonAI({ selected: [{ candidate: 'c1', fact: 'f1' }] }, x));
  assert(!CompareAIInput.safeParse({ ...i, goal: 'token: private_secret' }).success);
});
test('Protected comparison API is opt-in, paired, strict, replay fenced, and separate from legacy operations', async () => {
  const token = newPairToken(),
    server = makeApi(
      undefined,
      new GeminiService(
        { GEMINI_API_KEY: 'TEST-ONLY', GEMINI_MODEL: 'gemini-fixture-only' },
        token,
        async () => ({ text: '', tokens: null }),
        8000,
        undefined,
        undefined,
        async () => ({ text: JSON.stringify(valid), tokens: 11 }),
      ),
    );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  const post = (p: string, b: unknown, from = 'chrome-extension://' + 'a'.repeat(32)) =>
    fetch('http://127.0.0.1:' + addr.port + p, {
      method: 'POST',
      headers: {
        Origin: from,
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(b),
    });
  try {
    const i = request('intent');
    assert.equal((await post('/v1/compare/intent', i)).status, 403);
    assert.equal((await post('/v1/explain/connect', {})).status, 200);
    assert.equal((await post('/v1/compare/intent', i, 'https://foreign.test')).status, 403);
    assert.equal((await post('/v1/shopping/explain', i)).status, 400);
    assert.equal((await post('/v1/compare/explain', i)).status, 400);
    assert.equal((await post('/v1/compare/intent', { ...i, html: 'extra' })).status, 400);
    const r = CompareAIReply.parse(await (await post('/v1/compare/intent', i)).json());
    assert.equal(r.status, 'available');
    assert.equal(r.operationId, i.operationId);
    assert.equal(r.session, i.session);
    assert.equal((await (await post('/v1/compare/intent', i)).json()).status, 'invalid_response');
    assert.equal(
      (await new GeminiService({}, newPairToken()).compare(i, new AbortController().signal)).status,
      'not_configured',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
test('An interrupted model response cannot return explanation facts to an abandoned comparison', async () => {
  const ctrl = new AbortController(),
    svc = new GeminiService(
      { GEMINI_API_KEY: 'TEST-ONLY', GEMINI_MODEL: 'gemini-fixture-only' },
      newPairToken(),
      async () => ({ text: '', tokens: null }),
      8000,
      undefined,
      undefined,
      async () => new Promise(() => {}),
    );
  const x = request('explain'),
    reply = svc.compare(x, ctrl.signal);
  ctrl.abort();
  assert.equal((await reply).status, 'cancelled');
  assert.equal(svc.comparisonHealth().explain, false);
});
