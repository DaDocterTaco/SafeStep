// Separate from fixture verification. The operator opens the guarded listener; this driver never opens a funding window.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ChatRouteReply, validatedChatRoute, ShopAIReply, validatedShoppingExplanation,
  CompareAIReply, validatedComparisonAI, CleanAdviceReply, checkedCleanAdvice,
} from '@safestep/contracts';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';

const listing='https://nibdrawer.resell.store/lamy-2000-makrolon';
const plans={
  seller:{goal:'What feedback did buyers leave about the shop selling this exact pen?',feature:'seller_assessment',calls:['chat_route','seller_explain']},
  product:{goal:'Can reviews for this exact pen tell me about its durability?',feature:'product_assessment',calls:['chat_route']},
  comparison:{goal:'Find similar pens. They must have an ultraviolet coating. Exclude broad nibs.',feature:'shopping_alternatives',calls:['chat_route','compare_intent']},
  cleanup:{goal:'Hide ads on this listing, but keep promotions and seller feedback.',feature:'page_cleanup',calls:['chat_route']},
  'cleanup-fixture':{goal:'Preview hiding ads. Keep promotions and warnings visible.',feature:'page_cleanup',calls:['chat_route','cleanup_classify']},
};
const [phase,name,widthArg]=process.argv.slice(2);
if(phase==='--dry') {
  console.log(JSON.stringify({status:'dry preparation only; no ledger, browser or provider access',navigation:'tests/chrome-functional-navigation.mjs wiki-guide | vlc-auto',cases:plans,maximumSharedBuilderAdmissions:22,ownerReserve:8},null,2));
  process.exit(0);
}
assert.equal(phase,'--run');
assert.equal(process.env.SAFESTEP_NAV_MODE,'live');
const build=process.env.SAFESTEP_NAV_BUILD,expectedSession=Number(process.env.SAFESTEP_BUILDER_SESSION),width=Number(widthArg);
assert.match(build,/^stage-8-[a-f0-9]{12}$/); assert([1366,1440].includes(width)); assert(Number.isInteger(expectedSession)&&expectedSession>0);
const plan=plans[name];assert(plan,'Unknown trial');
const bundle=resolve('artifacts',build,'chrome-mv3'),{sha256}=await fingerprint(bundle);
assert.equal(build,'stage-8-'+sha256.slice(0,12));
const pointer=JSON.parse(await readFile('docs/evidence/'+build+'/current-reference.json','utf8'));
const ref=JSON.parse(await readFile(pointer.path,'utf8'));assert.equal(ref.extensionSHA256,sha256);
for(const group of [ref.api,ref.compiledContracts])for(const [file,hash] of Object.entries(group.files))
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash,'Release inputs changed');
const ledger=new DatabaseSync(resolve('.test-artifacts/stage8-paid-budget/ledger.sqlite'),{readOnly:true});
const receipts=()=>ledger.prepare('SELECT id,session,at,ended,model,http,state,category,total,operation,COALESCE(charged,reserved) AS exposure FROM attempts WHERE session=? ORDER BY id').all(expectedSession);
function headroom(remaining) {
  const w=ledger.prepare('SELECT id,expires FROM sessions ORDER BY id DESC LIMIT 1').get();
  assert.equal(w?.id,expectedSession);assert(w.expires>Date.now()+30000,'Too close to natural expiry');
  const entries=receipts();assert(entries.length+remaining<=22,'Would consume owner reserve');
  assert(entries.filter(x=>x.at>Date.now()-60000).length+remaining<=6,'Wait for the ordinary per-minute window');
  return entries.length;
}
const starts=headroom(plan.calls.length), model='gemini-3.5-flash-lite';
const runtimeFolder=resolve('docs/evidence/functional-navigation/live',build,'session-'+expectedSession);
const runtimeFiles=(await readdir(runtimeFolder)).filter(f=>/^runtime-\d+\.json$/.test(f));
const runtimes=await Promise.all(runtimeFiles.map(async file=>JSON.parse(await readFile(join(runtimeFolder,file),'utf8'))));
const runtime=runtimes.filter(r=>r.callerRole==='builder'&&r.ownerReserve===8&&r.host==='127.0.0.7:4317'&&r.ledgerSession===expectedSession&&r.extensionSHA256===sha256&&r.apiSHA256===ref.api.sha256&&r.model===model&&Date.parse(r.expires)>Date.now());
assert(runtime.some(r=>{try{process.kill(r.pid,0);return true;}catch{return false;}}),'No matching live private runtime with reserved owner headroom');
const out=resolve('docs/evidence',build,'three-site-live',new Date().toISOString().replace(/[:.]/g,'-')+'-'+name+'-'+width);
await mkdir(out,{recursive:true});
const row={role:'builder',name,width,build,sha256,api:ref.api.sha256,source:ref.source.sha256,model,session:expectedSession,goal:plan.goal,started:new Date().toISOString(),status:'incomplete',connector:[],fileRequests:0,downloads:0,sourceType:name==='cleanup-fixture'?'labelled harmless fixture, genuine provider requested':'public Resell.store page and read-only published source, genuine provider requested'};
row.interpretation='A settled provider receipt credits only that request. Local routing validation, exact subject checks, locked requirement reinsertion, numeric comparison, and protected cleanup filtering are performed by SafeStep. Source facts come from their own connectors.';
const button=(panel,label)=>panel.locator('::-p-aria('+label+'[role="button"])').setTimeout(7500);
async function wait(check,label){const end=Date.now()+20000;while(Date.now()<end){const value=await check();if(value)return value;await delay(140);}throw Error(label);}
const state=async s=>(await view(s.panel)).v;
const operations={
  '/v1/chat/route':{op:'chat_route',schema:ChatRouteReply,validate:(reply,input)=>validatedChatRoute(reply.decision,input)},
  '/v1/shopping/explain':{op:'seller_explain',schema:ShopAIReply,validate:(reply,input)=>validatedShoppingExplanation(reply.explanation,input)},
  '/v1/compare/intent':{op:'compare_intent',schema:CompareAIReply,validate:(reply,input)=>validatedComparisonAI(reply.explanation,input)},
  '/v1/cleanup/classify':{op:'cleanup_classify',schema:CleanAdviceReply,validate:(reply,input)=>checkedCleanAdvice(reply.explanation,input)},
};
async function observe(target){
  const session=await target.createCDPSession(), inflight=new Map(), pending=new Set();
  session.on('Network.requestWillBeSent', e=>{
    const u=new URL(e.request.url),spec=operations[u.pathname];
    if(!spec||u.origin!=='http://127.0.0.1:4317'||e.request.method!=='POST')return;
    const ob={op:spec.op,at:e.wallTime*1000,status:'pending'};
    row.connector.push(ob);
    try{inflight.set(e.requestId,{spec,ob,input:JSON.parse(e.request.postData)});}catch{ob.status='unobserved_request';}
  });
  session.on('Network.loadingFailed', e=>{const x=inflight.get(e.requestId);if(x)x.ob.status='transport_error';});
  session.on('Network.loadingFinished',e=>{
    const x=inflight.get(e.requestId);if(!x)return;
    const work=(async()=>{try{
      const p=await session.send('Network.getResponseBody',{requestId:e.requestId});
      const reply=x.spec.schema.parse(JSON.parse(p.base64Encoded?Buffer.from(p.body,'base64').toString('utf8'):p.body));
      x.ob.status=reply.status; x.ob.tokens=reply.tokens;
      x.ob.bound=reply.operationId===x.input.operationId&&reply.bindingToken===x.input.bindingToken;
      const decision=x.spec.validate(reply,x.input);x.ob.validated=!!decision;
      if(x.ob.op==='chat_route')x.ob.feature=decision?.feature??decision?.kind;
      if(x.ob.op==='cleanup_classify')x.ob.onlyRequestedAds=x.input.candidates.every(c=>c.reason==='advertisement');
      if(x.ob.op==='compare_intent'){
        x.ob.mandatoryRetained=!!decision?.rules?.some(r=>!r.exclude&&r.value==='ultraviolet coating')&&!!decision?.rules?.some(r=>r.exclude&&r.field==='nib'&&r.value==='broad');
        x.ob.history='Explicit original requirement anchors are locally reinserted; only the versioned intent request and provider receipt earn AI credit.';
      }
    }catch{x.ob.status='unobserved_response';}finally{inflight.delete(e.requestId);}})();pending.add(work);void work.finally(()=>pending.delete(work));
  });
  await session.send('Network.enable');return async()=>{await Promise.allSettled([...pending]);await session.detach().catch(()=>{});};
}
let s,fixture;const observers=[];
try {
  if(name==='cleanup-fixture')fixture=await startFixture(0);
  const url=fixture?fixture.origin+'/cleanup-lab':listing;
  s=await nativeSession(bundle,width,width===1440?900:768,url,{apiHost:'127.0.0.7',attachWorker:true,prepare:async(page)=>{
    await page.setRequestInterception(true);page.on('request',r=>{if(/\.(?:exe|dmg|msi|zip|7z)(?:$|[?#])/i.test(r.url())){row.fileRequests++;void r.abort().catch(()=>{});}else void r.continue().catch(()=>{});});
  }});
  row.dimensions=s.dimensions;row.chrome=await s.browser.version();
  const installed=(await s.root.send('Extensions.getExtensions')).extensions.find(x=>x.id===s.id);assert.equal(resolve(installed.path),bundle);
  await s.root.send('Browser.setDownloadBehavior',{behavior:'deny',eventsEnabled:true});s.root.on('Browser.downloadWillBegin',()=>row.downloads++);
  const worker=await s.browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().startsWith('chrome-extension://'+s.id+'/'));
  observers.push(await observe(worker),await observe(s.panel.target()));
  const token=(await readFile('.test-artifacts/functional-paid/.env.safestep-session','utf8')).trim();assert(/^ss3_[\w-]{43}$/.test(token));
  await button(s.panel,'Settings').click();await s.panel.locator('summary::-p-text(Connect local AI)').click();await s.panel.type('input[type=password]',token);
  await button(s.panel,'Connect').click();await s.panel.waitForFunction(m=>document.body.innerText.includes('Connected to Gemini · '+m),{},model);await button(s.panel,'Close Settings').click();
  headroom(plan.calls.length);
  await s.panel.type('#chat-composer',plan.goal);await s.panel.keyboard.press('Enter');
  const v=await wait(async()=>{const v=await state(s),t=v.chat?.turns.find(t=>t.id===v.chat.activeTurnId);
    if(t && ['unsupported','error','clarifying','awaiting_access','unavailable'].includes(t.state)) throw Error('Router returned '+t.state);
    if(t?.feature!==plan.feature||t.original!==plan.goal)return false;
    return (plan.feature==='page_cleanup'?v.cleanup:plan.feature==='shopping_alternatives'?v.comparison?.baseline:v.shopping?.[name]?.data?.status!=='loading'&&v.shopping?.[name]?.data)?v:false;
  },'Bound tool evidence unavailable');
  if(name==='seller'||name==='product'){
    const d=v.shopping[name].data;
    assert.equal(d.inspectedUrl,listing);assert.equal(d.context.seller,'nibdrawer');assert.match(d.context.variant??'',/extra fine/i);
    row.sourceEvidence={current:d.inspectedUrl,listing:d.context.listing,variant:d.context.variant,account:d.context.seller,source:d.source,records:d.records.length,status:d.status};
    if(name==='seller'){
      assert(d.records.every(r=>r.channel==='seller_received_feedback'&&r.subject===d.context.seller));
      headroom(1);await s.panel.locator('summary::-p-text(Gemini explanation)').click();await button(s.panel,'Explain this summary with Gemini').click();
    }else{assert.equal(d.records.length,0);assert.match(d.note,/independent product reviews/i);}
  }else if(name==='comparison'){
    assert.equal(v.comparison.baseline.url,listing);row.baseline=v.comparison.baseline.id;
    headroom(1);await button(s.panel,'Interpret goal with Gemini').click();
  }else{
    row.preview={eligible:v.cleanup.items.length,uncertain:v.cleanup.uncertain,hidden:v.cleanup.hidden};assert(!v.cleanup.enabled&&v.cleanup.hidden===0);
    if(name==='cleanup-fixture'){
      headroom(1);await button(s.panel,'Review these regions with Gemini').click();
    }
  }
  await wait(()=>plan.calls.every(op=>row.connector.some(x=>x.op===op&&x.status!=='pending')),'Insufficient genuine bound connector results');
  assert(row.connector.some(x=>x.op==='chat_route'&&x.feature===plan.feature));
  assert(row.connector.every(c=>c.status==='available'&&c.bound&&c.validated));
  if(name==='cleanup-fixture')assert(row.connector.some(c=>c.op==='cleanup_classify'&&c.onlyRequestedAds));
  if(name==='comparison')assert(row.connector.some(c=>c.op==='compare_intent'&&c.mandatoryRetained));
  assert.equal(row.fileRequests,0);assert.equal(row.downloads,0);row.status='pass';
}catch(e){row.status='failed_or_blocked';row.reason=String(e.message).replace(/ss3_[\w-]+|AIza[\w-]+/g,'[redacted]').slice(0,260);}
finally{
  if(s)await s.panel.screenshot({path:join(out,'panel.png')}).catch(()=>{});
  await Promise.allSettled(observers.map(stop=>stop()));if(s)await s.browser.close();
  if(fixture){fixture.server.closeAllConnections();await new Promise(ok=>fixture.server.close(ok));}
  row.ended=new Date().toISOString();row.attempts=receipts().slice(starts).map(x=>({...x,accountedUSD:x.exposure/2000000}));
  const bound=new Set();
  for(const c of row.connector){const matches=row.attempts.filter(x=>!bound.has(x.id)&&x.operation===c.op&&x.model===model&&x.state==='settled'&&x.http===200&&x.total===c.tokens&&x.at>=c.at-300&&x.at<=c.at+2000);
    if(matches.length===1){c.receipt=matches[0].id;bound.add(c.receipt);}}
  if(row.status==='pass'&&(!plan.calls.every(op=>row.connector.some(c=>c.op===op&&c.receipt))||row.attempts.length!==plan.calls.length)){
    row.status='partial';row.reason='Connector outcome lacks unique settled upstream receipts, or extra generation was observed.';
  }
  ledger.close();await writeFile(join(out,'result.json'),JSON.stringify(row,null,2)+'\n',{flag:'wx'});console.log(name,width,row.status,row.reason??'');
}
if(row.status!=='pass')process.exitCode=1;
