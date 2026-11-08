import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Lookup,
  ShopAIInput,
  shoppingChoices,
  validatedShoppingExplanation,
  shoppingThemes,
  publicExcerpt,
  ShoppingData,
  shoppingInput,
  ShopAIReply,
  type ShoppingKind,
  type ShopAIInput as Input,
} from '@safestep/contracts';
import {
  shoppingRoute,
  blankShop,
  shopRecord,
  conclude,
  readMozilla,
  readResell,
} from '../apps/extension/sites/shopping';
import { makeApi } from '../apps/api/src/app';
import { pageSignature, readShopping } from '../apps/extension/page/shop-reader';
import { GeminiService, newPairToken } from '../apps/api/src/gemini';

const env = { GEMINI_API_KEY: 'MOCK_ONLY', GEMINI_MODEL: 'gemini-fixture-only' },
  bound = {
    operationId: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    tabId: 2,
    taskId: null,
    epoch: 1,
    generation: 1,
    origin: 'http://localhost:4174',
    documentId: 'a'.repeat(32),
  };
test('An unsupported eBay route stops before reading a document or requesting a source', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('https://www.ebay.com/itm/276589323151'),
  });
  try {
    assert.equal(pageSignature('seller'), 'unsupported');
    for (const k of ['seller', 'product'] as const) {
      const d = await readShopping(
        { ...bound, origin: 'https://www.ebay.com' },
        k,
        new AbortController().signal,
      );
      assert.equal(d.status, 'unsupported');
      assert.equal(d.records.length, 0);
      assert.equal(d.source, null);
    }
  } finally {
    if (prior) Object.defineProperty(globalThis, 'location', prior);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
test('Public storefront repaint keeps the same subject, while a new listing and review filter invalidate it', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const select = (url: string) =>
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(url) });
  try {
    select('https://foxedandfound.resell.store/first-book');
    const first = pageSignature('seller');
    select('https://foxedandfound.resell.store/first-book?tracking=opaque');
    assert.equal(pageSignature('seller'), first);
    select('https://foxedandfound.resell.store/another-book');
    assert.notEqual(pageSignature('seller'), first);
    select('https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/reviews/?score=5');
    const five = pageSignature('product');
    select('https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/reviews/?score=1');
    assert.notEqual(pageSignature('product'), five);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'location', prior);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
function sample(k: ShoppingKind = 'seller') {
  const d = blankShop(bound, k, 'practice');
  d.context.seller = 'second.sale';
  d.context.catalog = 'epid_2282222';
  d.scope = 'Received as seller';
  d.records = Array.from({ length: 4 }, (_, i) => ({
    ...shopRecord(d, i),
    platformId: 'id' + i,
    text:
      k === 'seller'
        ? [
            'Poor packaging.',
            'poor PACKAGING!',
            'Poor packaging and loose packing.',
            'Poor packaging from automation.',
          ][i]!
        : ['Easy to read.', 'Not easy to read.', 'Poor quality packaging.', 'Clear prose.'][i]!,
    automated: i === 3,
  }));
  return conclude(d);
}
test('Scoped public identifiers, canonical source routes and review channels stay separate', () => {
  const look = (market: string, publicId: string) =>
    Lookup.safeParse({
      provider: 'seller_feedback',
      subject: { kind: 'seller_reputation', market, publicId },
    }).success;
  assert(look('ebay.com', 'second.sale'));
  assert(look('ebay.com', 'second_sale'));
  for (const id of ['a..b', 'https://x', 'x/y', 'a%2fb', '.', '../a'])
    assert(!look('ebay.com', id));
  assert(!look('localhost', 'seller'));
  assert(!look('unrelated.org', 'second.sale'));
  for (const u of [
    'http://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
    'https://www.ebay.com/itm/276589323151',
    'https://addons.mozilla.org.evil.test/en-US/firefox/addon/a/',
    'https://a:b@shop.resell.store/',
    'https://docs.resell.store/',
    'https://api.resell.store/v1/market/stores/../../etc',
    'http://host.test/shopping-lab/listing',
  ])
    assert.equal(shoppingRoute(new URL(u)), null);
  const s = sample();
  assert(ShoppingData.safeParse(s).success);
  assert(!ShoppingData.safeParse({ ...s, kind: 'product' }).success);
  assert(
    !ShoppingData.safeParse({ ...s, binding: { ...s.binding, origin: 'https://www.ebay.com' } })
      .success,
  );
  assert(
    !ShoppingData.safeParse({
      ...s,
      metrics: [
        {
          label: 'feedback',
          value: 101,
          scale: 100,
          unit: 'percent',
          period: 'one year',
          approximate: false,
        },
      ],
    }).success,
  );
  assert(
    !ShoppingData.safeParse({
      ...s,
      source: 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
    }).success,
  );
});
test('Distinct group support, automation, dated scope and guarded excerpts', () => {
  const d = sample(),
    t = shoppingThemes('seller', d.records);
  assert.deepEqual(t.find((x) => x.label === 'packaging')?.ids, ['r1', 'r3']);
  d.records[2]!.platformId = d.records[0]!.platformId;
  conclude(d);
  assert.equal(shoppingThemes('seller', d.records)[0]?.ids.length, 1);
  assert.deepEqual(
    shoppingThemes('product', sample('product').records).map((t) => t.label),
    ['usability'],
  );
  for (const x of [
    'contact a@host.com',
    'https://example.com/?private=1',
    'Deliver to 922 Main Street',
    'PRIVATE_SHOP_ADDRESS',
    '<img src=x>',
    '@reviewer',
  ])
    assert.equal(publicExcerpt(x), '');
  const request = shoppingInput(sample());
  assert(!/packaging from|second.sale|PRIVATE|buyer|epid/.test(JSON.stringify(request)));
  assert(ShopAIInput.safeParse(request).success);
  const choices = shoppingChoices(request);
  assert(validatedShoppingExplanation(choices, request));
  for (const bad of [
    { ...choices, summary: 'This shop is 99% safe.' },
    { ...choices, concerns: [{ theme: 'packaging', ids: ['r20'] }] },
    { ...choices, strengths: choices.concerns },
    { ...choices, limit: 'Buy now.' },
  ])
    assert.equal(validatedShoppingExplanation(bad, request), null);
  assert(!ShopAIInput.safeParse({ ...request, kind: 'product' }).success);
  assert(!ShopAIInput.safeParse({ ...request, text: 'send arbitrary review' }).success);
});
test('Public adapters stop on wrong identity, invalid rating and excessive or ambiguous results', async (t) => {
  const d = blankShop(bound, 'seller', 'resell'),
    url = new URL('https://foxedandfound.resell.store/');
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ object: 'store', slug: 'other', name: 'Other', listings: [] }),
  );
  assert.equal(
    (await readResell(d, 'foxedandfound', url, new AbortController().signal)).status,
    'identity_uncertain',
  );
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      id: 123,
      slug: 'other',
      name: 'Other',
      ratings: { average: 3, count: 2, text_count: 1 },
      current_version: { version: '1' },
    }),
  );
  assert.equal(
    (
      await readMozilla(
        blankShop(bound, 'product', 'mozilla'),
        'a',
        new AbortController().signal,
        new URL('https://addons.mozilla.org/en-US/firefox/addon/a/'),
      )
    ).status,
    'identity_uncertain',
  );
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      id: 1,
      slug: 'a',
      name: 'A',
      ratings: { average: 6, count: -2, text_count: 1 },
      current_version: { version: '1' },
    }),
  );
  await assert.rejects(
    readMozilla(
      blankShop(bound, 'product', 'mozilla'),
      'a',
      new AbortController().signal,
      new URL('https://addons.mozilla.org/en-US/firefox/addon/a/'),
    ),
  );
});
test('Protected shopping route shares pairing, bounded JSON and validated citations; old route rejects shopping evidence', async () => {
  const token = newPairToken(),
    origin = 'chrome-extension://' + 'a'.repeat(32),
    input = shoppingInput(sample());
  const svc = new GeminiService(
    env,
    token,
    async () => ({ text: '', tokens: 0 }),
    500,
    async (i) => ({ text: JSON.stringify(shoppingChoices(i)), tokens: 8 }),
  );
  const server = makeApi(undefined, svc);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (path: string, r: unknown, auth = token) =>
    fetch('http://127.0.0.1:' + address.port + path, {
      method: 'POST',
      headers: { origin, authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    });
  try {
    assert.equal((await send('/v1/shopping/explain', input)).status, 403);
    assert.equal((await send('/v1/explain/connect', {})).status, 200);
    assert.equal((await send('/v1/explain', input)).status, 400);
    assert.equal((await send('/v1/shopping/explain', { ...input, private: 'x' })).status, 400);
    assert.equal((await send('/v1/shopping/explain', { text: 'x'.repeat(8300) })).status, 413);
    const answer = ShopAIReply.parse(await (await send('/v1/shopping/explain', input)).json());
    assert.equal(answer.status, 'available');
    assert(validatedShoppingExplanation(answer.explanation, input));
  } finally {
    server.close();
    await once(server, 'close');
  }
});
test('Official Gemini SDK sends only the structured shopping evidence to its fixed endpoint (mock transport)', async (t) => {
  const client = new GeminiService(env, newPairToken());
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (raw: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(raw instanceof Request ? raw.url : String(raw));
    assert.equal(u.origin, 'https://generativelanguage.googleapis.com');
    assert(u.pathname.endsWith('/models/gemini-fixture-only:generateContent'));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.maxOutputTokens, 600);
    assert(body.generationConfig.responseJsonSchema);
    assert.equal(body.tools, undefined);
    const prompt = JSON.parse(body.contents[0].parts[0].text);
    assert.deepEqual(Object.keys(prompt).sort(), ['choices', 'coverage', 'evidence', 'sampleScope', 'subject']);
    assert.deepEqual(Object.keys(prompt.sampleScope).sort(),['captured','channel','dateUnknown','datedOlder','datedRecent','market','versionMatch']);
    assert(!/Poor packaging|second.sale|MOCK_ONLY|https:\/\//.test(JSON.stringify(prompt)));
    count++;
    const c = prompt.choices;
    const reply = { ...c, strengths: c.strengths.slice(0, 3), concerns: c.concerns.slice(0, 3) };
    return Response.json({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: JSON.stringify(reply) }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { totalTokenCount: 25 },
    });
  });
  for (const k of ['seller', 'product'] as const) {
    const input = shoppingInput(sample(k));
    const r = await client.shopping(input, new AbortController().signal);
    assert.equal(r.status, 'available');
    assert(validatedShoppingExplanation(r.explanation, input));
  }
  assert.equal(count, 2);
});
test('Shopping generation handles no key, invalid replies, timeout, refusal, quota and late cancellation', async () => {
  const input = shoppingInput(sample('product')),
    s = new AbortController(),
    generate = async () => ({ text: '', tokens: null });
  assert.equal(
    (await new GeminiService({}, newPairToken()).shopping(input, s.signal)).status,
    'not_configured',
  );
  const use = (
    fn: (i: Input, signal: AbortSignal) => Promise<{ text: string; tokens: number | null }>,
    ms = 8000,
  ) => new GeminiService(env, newPairToken(), generate, ms, fn);
  for (const text of [
    '',
    '<b>safe</b>',
    JSON.stringify({ ...shoppingChoices(input), summary: 'Install now' }),
    JSON.stringify({ ...shoppingChoices(input), strengths: [{ theme: 'delivery', ids: ['r1'] }] }),
  ])
    assert.equal(
      (await use(async () => ({ text, tokens: null })).shopping(input, s.signal)).status,
      'invalid_response',
    );
  const slow = use(async () => {
    await delay(80);
    return { text: JSON.stringify(shoppingChoices(input)), tokens: null };
  }, 15);
  assert.equal((await slow.shopping(input, s.signal)).status, 'timeout');
  const abort = new AbortController(),
    pending = slow.shopping({ ...input, operationId: crypto.randomUUID() }, abort.signal);
  abort.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(
    (
      await use(async () => {
        throw { status: 429 };
      }).shopping(input, s.signal)
    ).status,
    'rate_limited',
  );
  const quota = use(async (i) => ({ text: JSON.stringify(shoppingChoices(i)), tokens: null }));
  for (let i = 0; i < 6; i++)
    assert.equal(
      (await quota.shopping({ ...input, operationId: crypto.randomUUID() }, s.signal)).status,
      'available',
    );
  assert.equal((await quota.shopping(input, s.signal)).status, 'rate_limited');
});
