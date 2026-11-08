import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  CleanAdviceInput,
  checkedCleanAdvice,
  cleanupDescriptions,
  cleanupScope,
  comparisonFromWords,
  comparisonQuestion,
  defaultCompareSettings,
  validatedComparisonAI,
  shoppingInsights,
  shoppingInput,
  ShoppingData,
} from '@safestep/contracts';
import { GeminiService, newPairToken } from '../apps/api/src/gemini';
import { makeApi } from '../apps/api/src/app';
import { blankShop, shopRecord } from '../apps/extension/sites/shopping';

const makeID = () => crypto.randomUUID();
test('cleanup keeps explicit user exceptions ahead of local and model suggestions',()=>{
  assert.deepEqual(cleanupScope('Clean up this page. Hide ads but keep promotions.').allowed,['advertisement']);
  assert.deepEqual(cleanupScope("Don't hide the ads; hide promotional banners.").allowed,['promotion','promo_pair']);
  assert.deepEqual(cleanupScope('Hide ads, but keep ads.').allowed,[]);
  assert.deepEqual(cleanupScope('Please do not hide anything.').allowed,[]);
  assert.deepEqual(cleanupScope('Clean up this page except the blue thing.').allowed,[]);
  assert.deepEqual(cleanupScope('Keep the ads.').allowed,[]);
  assert.deepEqual(cleanupScope('Clean up this page; keep warnings.').allowed,['advertisement','promotion','promo_pair']);
  assert.equal(cleanupScope('Preview cleanup on this page.').restricted,false);
});
const b = {
  operationId: makeID(),
  revision: makeID(),
  taskId: null,
  tabId: 42,
  documentId: 'f'.repeat(32),
  origin: 'https://nibdrawer.resell.store',
  generation: 1,
  epoch: 0,
};
test('repeated, old and conflicting seller comments retain their account, channel and distinct record IDs', () => {
  const d = blankShop(b, 'seller', 'resell');
  d.context.seller = 'nibdrawer';
  d.context.listing = 'pen01';
  d.captured = '2026-11-08T00:00:00.000Z';
  d.source = 'https://api.resell.store/v1/stores/nibdrawer/reviews';
  d.inspectedUrl = 'https://nibdrawer.resell.store/pen';
  d.records = [
    'Arrived in excellent condition.',
    'Arrived in excellent condition.',
    'Arrived damaged.',
    'Arrived damaged.',
  ].map((text, i) => ({
    ...shopRecord(d, i),
    text,
    soldBy: 'nibdrawer',
    published: i === 0 ? '2026-11-01' : i === 2 ? '2025-10-20' : null,
    precision: i === 0 || i === 2 ? 'date' : 'unknown',
    automated: i === 3,
  }));
  const valid = ShoppingData.parse(d),
    insights = shoppingInsights(valid);
  assert.deepEqual(insights.mixed, ['item condition']);
  assert.equal(insights.repeated, 1);
  assert.deepEqual(
    insights.themes.map((t) => t.ids),
    [['r1'], ['r3']],
  );
  assert.deepEqual(insights.recent, ['r1']);
  assert.deepEqual(insights.older, ['r3']);
  const local = shoppingInput(valid);
  assert.equal(local.scope?.channel, 'seller_account');
  assert.equal(local.scope?.dateUnknown, 2);
  assert(!JSON.stringify(local).includes('Arrived damaged'));
  assert(
    !ShoppingData.safeParse({ ...d, records: [{ ...d.records[0], soldBy: 'secondshop' }] }).success,
  );
  assert(
    !ShoppingData.safeParse({ ...d, inspectedUrl: 'https://secondshop.resell.store/pen' }).success,
  );
  const second = {
    ...d,
    binding: { ...b, origin: 'https://secondshop.resell.store' },
    context: { ...d.context, seller: 'secondshop' },
    source: 'https://api.resell.store/v1/stores/secondshop/reviews',
    inspectedUrl: 'https://secondshop.resell.store/pen',
    records: [
      {
        ...d.records[0]!,
        id: 'r1',
        subject: 'secondshop',
        soldBy: 'secondshop',
        text: 'Refund refused.',
      },
    ],
  };
  assert.deepEqual(
    shoppingInsights(ShoppingData.parse(second)).themes.map((t) => [t.label, t.tone]),
    [['returns', 'concern']],
  );
});
test('exact Mozilla format can answer Firefox compatibility while evidence for a particular version or physical item remains bounded', () => {
  const d = blankShop({ ...b, origin: 'https://addons.mozilla.org' }, 'product', 'mozilla');
  d.context.catalog = 'amo_607454';
  d.context.variant = '2';
  d.context.format = 'Firefox add-on';
  d.source = 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/reviews/';
  d.records = ['Works well on Firefox.', 'Incompatible with Android.', 'Fast shipping.'].map(
    (text, i) => ({ ...shopRecord(d, i), text, version: i === 0 ? '2' : i === 1 ? '1' : null }),
  );
  const x = shoppingInsights(ShoppingData.parse(d), 'Does this work for Firefox?');
  assert.deepEqual(x.versions, { same: ['r1'], other: ['r2'], unstated: ['r3'] });
  assert.match(x.requirement!, /specific|particular Firefox release/);
  assert.deepEqual(
    x.themes.filter((t) => t.label === 'compatibility').map((t) => t.ids),
    [['r1'], ['r2']],
  );
  const listing = blankShop(b, 'product', 'resell');
  listing.context.listing = 'pen01';
  assert.match(
    shoppingInsights(listing, 'Is it compatible with this device?').requirement!,
    /does not establish/,
  );
  assert.deepEqual(shoppingInsights(listing).themes, []);
  d.records[0]!.text = 'Long-lasting and still works after six months.';
  d.records[1]!.text = 'Broke after two weeks.';
  const wanted = shoppingInsights(
    ShoppingData.parse(d),
    'How is durability in the current version?',
  ).requested[0]!;
  assert.deepEqual(wanted.strengths, ['r1']);
  assert.deepEqual(wanted.concerns, []);
});
test('ordinary comparison keeps cheaper priority, optional colour/platform, hard edition and explicit budget basis separate', () => {
  const s = defaultCompareSettings(),
    g =
      'Find a cheaper pen, must have first edition. Prefer Firefox, exclude Chrome. Budget of USD 30 item price.';
  const x = comparisonFromWords(s, g);
  assert.deepEqual(
    x.hard,
    [
      { field: 'edition', value: 'first edition', exclude: false },
      { field: 'platform', value: 'Chrome', exclude: true },
    ].sort((a, b) => (a.field === 'platform' ? -1 : 1)),
  );
  assert.deepEqual(x.preferred, [{ field: 'platform', value: 'Firefox' }]);
  assert.equal(x.priorities[0], 'cost');
  assert.deepEqual(x.budget, { amount: '30', currency: 'USD', basis: 'item' });
  assert.match(
    comparisonQuestion({ ...s, goal: 'Find something cheaper with the same required features.' })!,
    /Which features/,
  );
  assert.match(comparisonQuestion({ ...s, goal: 'Find a pen under $30.' })!, /currency/);
  const proposed = {
    mode: s.mode,
    rules: [...x.hard, { field: 'platform', value: 'Firefox', exclude: false }],
    allowed: [],
    priorities: s.priorities,
    question: '',
  };
  const input = {
    session: makeID(),
    operationId: makeID(),
    bindingToken: makeID(),
    version: 1,
    kind: 'intent' as const,
    settings: x,
    goal: g,
  };
  assert.equal(
    validatedComparisonAI(proposed, input),
    null,
    'A preference cannot become a hard requirement.',
  );
});
test('unfamiliar mandatory product features survive routing and require explicit source evidence', () => {
  const goal='Find similar pens. They must have an extra fine nib and an “ultraviolet coating”. Exclude mirror finishes. Prefer blue.';
  const settings=comparisonFromWords(defaultCompareSettings(),goal);
  assert.equal(settings.goal,goal);
  assert.deepEqual(settings.hard,[
    {field:'nib',value:'extra fine',exclude:false},
    {field:'feature',value:'ultraviolet coating',exclude:false},
    {field:'feature',value:'mirror finishes',exclude:true},
  ]);
  assert.match(comparisonQuestion({...settings,hard:settings.hard.filter(r=>r.value!=='ultraviolet coating')})!,/ultraviolet coating/);
  const request={session:makeID(),operationId:makeID(),bindingToken:makeID(),version:1,kind:'intent' as const,goal,settings};
  const proposal={mode:'similar_products',rules:settings.hard,allowed:['model'],priorities:['feature'],question:''};
  assert(validatedComparisonAI(proposal,request));
  assert.equal(validatedComparisonAI({...proposal,rules:proposal.rules.filter(r=>r.value!=='ultraviolet coating')},request),null);
  assert.equal(validatedComparisonAI({...proposal,rules:[...proposal.rules,{field:'feature',value:'titanium',exclude:false}]},request),null);
  assert.deepEqual(comparisonFromWords(defaultCompareSettings(),'Find pens. They must not have an ultraviolet coating.').hard,[{field:'feature',value:'ultraviolet coating',exclude:true}]);
  assert.deepEqual(comparisonFromWords(defaultCompareSettings(),"Find pens. I don't require an ultraviolet coating.").hard,[]);
  assert.match(comparisonQuestion(comparisonFromWords(defaultCompareSettings(),'Find a pen. It must have blue or green ink.'))!,/separate comparisons/);
  const mixed='It must have a sleeve, a converter, and a clip, but not a mirror finish or a broad nib. Prefer blue.';
  assert.deepEqual(comparisonFromWords(defaultCompareSettings(),mixed).hard.map(h=>[h.value,h.exclude]),[['sleeve',false],['converter',false],['clip',false],['mirror finish',true],['broad',true]]);
});
test('paired cleanup advisor returns exactly the supplied eligible IDs or fails closed; fixture transport only', async () => {
  const a = makeID(),
    b = makeID(),
    token = newPairToken(),
    origin = 'chrome-extension://' + 'a'.repeat(32);
  const input = CleanAdviceInput.parse({
    operationId: makeID(),
    bindingToken: makeID(),
    candidates: [
      { id: a, reason: 'advertisement', signal: 'labelled_sponsored' },
      { id: b, reason: 'promotion', signal: 'recognized_banner' },
    ],
  });
  assert(
    !CleanAdviceInput.safeParse({
      ...input,
      candidates: [{ ...input.candidates[0], text: 'private form' }],
    }).success,
  );
  assert(
    !CleanAdviceInput.safeParse({
      ...input,
      candidates: [{ ...input.candidates[0], signal: 'recognized_banner' }],
    }).success,
  );
  const good = {
    regions: [
      { id: a, choice: 'offer_hide' },
      { id: b, choice: 'keep_visible' },
    ],
  };
  for (const invalid of [
    { regions: [good.regions[0]] },
    { regions: [good.regions[0], good.regions[0]] },
    { regions: [{ id: makeID(), choice: 'offer_hide' }, good.regions[1]] },
    { ...good, selector: 'body' },
  ])
    assert.equal(checkedCleanAdvice(invalid, input), null);
  assert.match(cleanupDescriptions.labelled_sponsored, /sponsored/);
  const service = new GeminiService(
    { GEMINI_API_KEY: 'fixture', GEMINI_MODEL: 'gemini-fixture-only' },
    token,
    async () => ({ text: '{}', tokens: 0 }),
    1000,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({ text: JSON.stringify(good), tokens: 0 }),
  );
  const api = makeApi(undefined, service);
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const addr = api.address();
  assert(addr && typeof addr === 'object');
  const post = (route: string, body: unknown) =>
    fetch('http://127.0.0.1:' + addr.port + route, {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/v1/cleanup/classify', input)).status, 403);
    assert.equal((await post('/v1/explain/connect', {})).status, 200);
    const msg = await (await post('/v1/cleanup/classify', input)).json();
    assert.equal(msg.status, 'available');
    assert.deepEqual(msg.explanation, good);
    assert.equal((await (await post('/v1/cleanup/classify', input)).json()).status, 'rate_limited');
  } finally {
    api.closeAllConnections();
    await new Promise<void>((ok) => api.close(() => ok()));
  }
});
