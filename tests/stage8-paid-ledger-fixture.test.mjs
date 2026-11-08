// Every transport in this file is a local function. These synthetic receipts
// exercise accounting only and never contact a model, merchant or browser.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { budgetedFetch, PaidLedger } from '../scripts/stage8-paid-ledger.mjs';

const url =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
const moduleURL = new URL('../scripts/stage8-paid-ledger.mjs', import.meta.url).href;
test('bounded WinSCP grant retains the reservation floor, absolute expiry, restricted operations and single-use grant',t=>{
  const realNow=Date.now; let now=Date.parse('2026-11-08T12:30:00Z');
  Date.now=()=>now;t.after(()=>{Date.now=realNow;});
  const dir=mkdtempSync(path.join(os.tmpdir(),'safestep-winscp-ledger-'));
  const l=new PaidLedger(dir,true);t.after(()=>{l.close();rmSync(dir,{recursive:true,force:true});});
  now=Date.parse('2026-11-08T13:55:00Z');
  l.newWinSCPSession();
  assert.throws(()=>l.reserve('chat_route',200000));
  const one=l.reserve('assist_intent',200000);
  assert.throws(()=>l.reserve('assist_step',200000));
  l.finish(one,200,{total:125,prompt:100,output:25,thoughts:0},'ok');
  assert.throws(()=>l.reserve('assist_step',200000));
  assert.equal(l.status().sessions.at(-1).expires,Date.parse('2026-11-08T14:10:00Z'));
  now=Date.parse('2026-11-08T14:10:01Z');assert.throws(()=>l.reserve('assist_intent',200000));
  assert.throws(()=>l.newWinSCPSession());
});
function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safestep-paid-fixture-'));
  const ledger = new PaidLedger(dir, true);
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true });
  });
  return { dir, ledger };
}
function options(mutator = () => {}) {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: JSON.stringify({ request: 'PRIVATE_PROMPT_MARKER', available: [], recent: [] }) },
        ],
      },
    ],
    systemInstruction: { role: 'user', parts: [{ text: 'PRIVATE_INSTRUCTION_MARKER' }] },
    generationConfig: {
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    },
  };
  mutator(body);
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'PRIVATE_KEY_MARKER' },
    body: JSON.stringify(body),
  };
}
const json = (body, status = 200) => Response.json(body, { status });
test('cleanup classification charges only bounded anonymous candidate signals; free text or another source is rejected',async t=>{
  const {ledger}=setup(t);let calls=0;
  const transport=budgetedFetch(ledger,async()=>{calls++;return json({usageMetadata:{totalTokenCount:4}});});
  const row={id:crypto.randomUUID(),reason:'advertisement',signal:'labelled_advertisement'};
  const request=candidates=>options(body=>{body.contents[0].parts[0].text=JSON.stringify({operation:'classify_cleanup',candidates});});
  await transport(url,request([row]));
  assert.equal(ledger.report().attempts[0].operation,'cleanup_classify');
  for(const bad of [[row,row],[{...row,signal:'private user label'}],[{...row,reason:'address'}],[{...row,text:'private form'}],Array.from({length:31},()=>({...row,id:crypto.randomUUID()}))])
    await assert.rejects(transport(url,request(bad)));
  assert.equal(calls,1);assert.equal(ledger.status().sessions[0].attempts,1);
});
test('SDK payload stays identical, redirects disabled, output+thoughts charged from validated total only', async (t) => {
  const { ledger } = setup(t);
  const supplied = options();
  const fetch = budgetedFetch(ledger, async (u, i) => {
    assert.equal(u, url);
    assert.equal(i.redirect, 'error');
    assert.equal(i.headers.get('x-goog-api-key'), 'PRIVATE_KEY_MARKER');
    assert.equal(Buffer.from(i.body).toString(), supplied.body);
    return json({
      usageMetadata: {
        totalTokenCount: 70,
        promptTokenCount: 50,
        candidatesTokenCount: 15,
        thoughtsTokenCount: 5,
      },
      result: 'PRIVATE_RESPONSE_MARKER',
    });
  });
  assert.equal((await (await fetch(url, supplied)).json()).result, 'PRIVATE_RESPONSE_MARKER');
  const r = ledger.report();
  assert.equal(r.exposureUSD, 0.000175);
  assert.equal(r.attempts[0].operation, 'chat_route');
  assert.equal(r.attempts[0].category, 'settled');
  assert.equal(r.attempts[0].thoughts, 5);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_/);
});
test('only approved text generation reaches mocked transport; disallowed routes, tools, streaming, and speculative budgets fail closed', async (t) => {
  const { ledger } = setup(t);
  let upstream = 0;
  const fetch = budgetedFetch(ledger, async () => {
    upstream++;
    return json({});
  });
  for (const target of [
    url + '?key=PRIVATE_KEY_MARKER',
    url.replace('3.5', '3.8'),
    url.replace('generateContent', 'streamGenerateContent'),
    'https://example.org',
    'https://us-central1-aiplatform.googleapis.com/vertex',
  ])
    await assert.rejects(fetch(target, options()));
  for (const change of [
    (b) => {
      b.tools = [{ googleSearch: {} }];
    },
    (b) => {
      b.contents[0].parts = [{ inlineData: { data: 'Zg==' } }];
    },
    (b) => {
      b.generationConfig.candidateCount = 2;
    },
    (b) => {
      b.generationConfig.maxOutputTokens = 1001;
    },
    (b) => {
      b.generationConfig.thinkingConfig = { thinkingBudget: -1 };
    },
    (b) => {
      b.contents[0].parts[0].text = '{"unknown":1}';
    },
  ])
    await assert.rejects(fetch(url, options(change)));
  assert.equal(upstream, 0);
  assert.equal(ledger.report().attempts.length, 0);
});
test('HTTP failures, aborts, malformed usage and unexpected response formats retain full reservations and disclose no diagnostics', async (t) => {
  const { ledger } = setup(t);
  const responses = [
    () => json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'PRIVATE_VENDOR_MESSAGE' } }, 429),
    () => {
      throw Error('PRIVATE_NETWORK_MESSAGE');
    },
    () => json({}),
    () => json({ usageMetadata: { totalTokenCount: 0 } }),
    () => new Response('PRIVATE_SSE', { headers: { 'content-type': 'text/event-stream' } }),
  ];
  const fetch = budgetedFetch(ledger, () => responses.shift()());
  for (let i = 0; i < 5; i++) {
    try {
      await fetch(url, options());
    } catch {
      /* expected for failed transport or unexpected format */
    }
  }
  const ctrl = new AbortController();
  await assert.rejects(
    budgetedFetch(ledger, () => {
      ctrl.abort();
      throw Error('PRIVATE_ABORT');
    })(url, { ...options(), signal: ctrl.signal }),
  );
  const r = ledger.report();
  assert.equal(r.exposureUSD, 0.6);
  assert.deepEqual(
    r.attempts.map((row) => row.category),
    [
      'RESOURCE_EXHAUSTED',
      'transport_error',
      'invalid_or_missing_usage',
      'invalid_or_missing_usage',
      'unsupported_response_format',
      'aborted',
    ],
  );
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_/);
});
test('SQLite serializes independent processes before each network request', async (t) => {
  const { dir, ledger } = setup(t);
  const src = `import { PaidLedger } from ${JSON.stringify(moduleURL)};const l=new PaidLedger(process.argv[1]);try{l.reserve('chat_route',200000);}catch{process.exitCode=1;}finally{l.close();}`;
  const attempt = () =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', src, dir], {
        stdio: 'ignore',
        windowsHide: true,
      });
      p.once('error', reject);
      p.once('exit', resolve);
    });
  const codes = await Promise.all(Array.from({ length: 10 }, attempt));
  assert.equal(codes.filter((c) => c === 0).length, 6);
  assert.equal(ledger.status().exposureUSD, 0.6);
  assert.equal(ledger.status().sessions[0].attempts, 6);
});
test('two competing builder processes can use only the last builder slot; the manual operator retains the final eight',async(t)=>{
  const realNow=Date.now();let clock=realNow-600000;
  t.mock.method(Date,'now',()=>clock);
  const {dir,ledger}=setup(t);
  assert.equal(ledger.status().effectiveSessionLimit,30);
  for(let i=0;i<21;i++){
    if(i&&i%6===0)clock+=60001;
    ledger.reserve('chat_route',200000);
  }
  const child=`import {PaidLedger} from ${JSON.stringify(moduleURL)};const l=new PaidLedger(process.argv[1],false,'builder');try{l.reserve('chat_route',200000)}catch{process.exitCode=1}finally{l.close()}`;
  const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',child,dir],{stdio:'ignore',windowsHide:true});
    p.once('error',reject);p.once('exit',resolve);});
  assert.deepEqual((await Promise.all([run(),run()])).sort(),[0,1]);
  assert.equal(ledger.status().sessions[0].attempts,22);
  clock=realNow+120001;
  const builder=new PaidLedger(dir,false,'builder');
  try{assert.equal(builder.status().effectiveSessionLimit,22);assert.throws(()=>builder.reserve('chat_route',200000),/limit/);}
  finally{builder.close();}
  for(let i=0;i<8;i++){if(i===6)clock+=60001;ledger.reserve('chat_route',200000);}
  assert.equal(ledger.status().sessions[0].attempts,30);assert.throws(()=>ledger.reserve('chat_route',200000),/limit/);
  assert.throws(()=>new PaidLedger(dir,false,'typo'),/role/);
});
test('restart and renewed pairing retain spend; 30 attempts in one period and six per minute across processes', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { dir, ledger } = setup(t);
  const restarted = new PaidLedger(dir);
  try {
    for (let i = 0; i < 30; i++) {
      if (i && i % 6 === 0) now += 60001;
      ledger.reserve('chat_route', 200000);
    }
    now += 60001;
    assert.throws(() => restarted.reserve('chat_route', 200000), /limit/);
    assert.throws(() => restarted.newSession(), /expired/);
    now += 30 * 60000;
    assert.equal(restarted.newSession(), 2);
    assert.throws(() => ledger.reserve('chat_route', 200000), /replaced/);
    for (let i = 0; i < 10; i++) {
      if (i === 6) now += 60001;
      restarted.reserve('chat_route', 200000);
    }
    assert.equal(restarted.status().exposureUSD, 4);
    assert.equal(restarted.status().remainingUSD, 0);
    assert.throws(() => restarted.reserve('chat_route', 200000), /budget/);
    assert.deepEqual(
      restarted.status().sessions.map((r) => r.attempts),
      [30, 10],
    );
  } finally {
    restarted.close();
  }
});
test('large text-only calls reserve stronger bounds and an internally inconsistent excess freezes further attempts', async (t) => {
  const { ledger } = setup(t);
  const fetch = budgetedFetch(ledger, () => json({}));
  await fetch(
    url,
    options((b) => {
      b.systemInstruction.parts[0].text = 'a'.repeat(50000);
    }),
  );
  assert(ledger.status().exposureUSD > 0.1);
  const id = ledger.reserve('chat_route', 200000);
  ledger.finish(id, 200, { total: 41001, prompt: null, output: null, thoughts: null });
  assert.equal(ledger.report().attempts.at(-1).category, 'above_reserved_bound');
  assert.throws(() => ledger.reserve('chat_route', 200000), /budget/);
});
test('normal preload cannot initialize an absent ledger or discard receipts', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safestep-unfunded-fixture-'));
  t.after(() => rmSync(dir, { recursive: true }));
  assert.throws(() => new PaidLedger(dir), /missing/);
});
