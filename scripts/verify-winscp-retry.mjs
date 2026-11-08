// One paired, server-side intent check. The browser and its pairing are never touched.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssistReply, IntentInput, checkedIntent,validAssistInput } from '@safestep/contracts';
import { GeminiService,newPairToken } from '../apps/api/dist/gemini.js';
import { PaidLedger } from './stage8-paid-ledger.mjs';
const build='stage-8-2aeb36f98542',dir='docs/evidence/'+build,ledger=new PaidLedger(resolve('.test-artifacts/stage8-paid-budget'),false,'builder');
try {
  assert(process.execArgv.includes('--import') && process.execArgv.includes('./scripts/stage8-paid-ledger.mjs'));
  assert.equal(ledger.bounded()?.grant_id,'winscp-text-retry-1');
  const previous=ledger.report().attempts.filter(x=>x.session===ledger.session);
  assert.equal(previous.length,0);
  const ref=JSON.parse(await readFile(dir+'/reference-043c9e75b49f584c.json','utf8'));
  for(const [path,sha] of Object.entries(ref.api.files))
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),sha);
  const source=dir+'/winscp/2026-11-08T14-02-43-381Z/results.json';
  const native=JSON.parse(await readFile(source,'utf8')).results.find(x=>x.name==='guide' && x.width===1440);
  const operationId=randomUUID(),bindingToken=randomUUID();
  const input=IntentInput.parse({kind:'intent',goal:native.goal,profile:'publisher',download:native.intent.profile,
    operationId,bindingToken,binding:{operationId,taskId:randomUUID(),tabId:1,windowId:1,documentId:randomUUID(),
      origin:'https://winscp.net',epoch:1,generation:1,goalVersion:1,revision:bindingToken}});
  assert(validAssistInput(input));
  const token=newPairToken(),service=new GeminiService(process.env,token);
  assert(service.pair('chrome-extension://'+'a'.repeat(32),'Bearer '+token,true));
  const response=AssistReply.parse(await service.assist(input,AbortSignal.timeout(14000)));
  const valid=response.status==='available' && response.operationId===operationId && response.bindingToken===bindingToken &&
    !!response.explanation && !!checkedIntent(response.explanation,input.goal);
  const result={build,scope:'isolated backend only, synthetic task binding; public goal/profile from identified installed receipt',source,
    compiled_api_sha256:ref.api.sha256,model:ledger.status().model,session:ledger.session,response,valid,
    provider_receipts:ledger.report().attempts.filter(x=>x.session===ledger.session),
    cumulative_exposure_usd:ledger.status().exposureUSD,finished:new Date().toISOString()};
  await writeFile(dir+'/winscp-retry-backend.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:response.status,valid,attempts:result.provider_receipts.length,tokens:response.tokens}));
  if(!valid)process.exitCode=1;
} finally {ledger.close();}
