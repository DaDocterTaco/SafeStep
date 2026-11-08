import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Protection } from '../apps/extension/core/protection';
import { Store } from '../apps/extension/core/store';
import { ProtectionView, type ThreatReply, type ThreatRequest } from '@safestep/contracts';

const origin='https://en.wikipedia.org';
const article=origin+'/wiki/Atmosphere_of_Earth';
const noop=async()=>{};
async function fixture(t:TestContext, outside=false) {
  const store=new Store();
  const worker=new Protection(store,noop);
  store.prefs.protection={scope:'selected',sites:[origin],threatRoot:true,outside,budget:8};
  const saved:Record<string,unknown>={'local-ai-session':'ss3_'+'t'.repeat(43)};
  const tab={id:15,url:article,doc:'doc-a',incognito:false} as chrome.tabs.Tab & {doc:string};
  const packets:{route:string;body:unknown}[]=[];
  const painted:ProtectionView[]=[];
  let now=Date.now(),paired=true;
  t.mock.method(Date,'now',()=>now);
  let reply:(q:ThreatRequest)=>Promise<Response>|Response=(q)=>Response.json(makeReply(q,'match'));
  function makeReply(q:ThreatRequest,status:ThreatReply['status']):ThreatReply {
    return {...q,source:'Google Web Risk Lookup',status,categories:status==='match'?['MALWARE']:[],
      checkedAt:new Date(now).toISOString(),expiresAt:status==='match'?new Date(now+120_000).toISOString():null,
      reason:status==='rate_limited'?'quota':status==='unavailable'?'source':null};
  }
  t.mock.method(globalThis,'fetch',async (input,opts)=>{
    const route=new URL(String(input)).pathname;
    const body=opts?.body?JSON.parse(String(opts.body)):null;
    packets.push({route,body});
    if(!paired) return Response.json({}, {status:403});
    if(route==='/v1/explain/connect') return Response.json({provider:'Gemini',model:null,
      credentialPresent:false,state:'not_configured',connected:true});
    if(route==='/v1/merchant/check') return Response.json({}, {status:503});
    assert.equal(route,'/v1/threat/check');
    assert.deepEqual(Object.keys(body).sort(),['scope','url']);
    return reply(body);
  });
  const previous=Object.getOwnPropertyDescriptor(globalThis,'chrome');
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{
    runtime:{id:'fixture-extension',sendMessage:noop},
    action:{setBadgeText:noop,setTitle:noop,setBadgeBackgroundColor:noop},
    tabs:{get:async()=>({...tab}),sendMessage:async(_id:number,m:{view?:ProtectionView})=>{
      if(m.view)painted.push(ProtectionView.parse(m.view));
    }},permissions:{contains:async()=>true},
    storage:{session:{
      get:async(keys:string[]|string|null)=>Object.fromEntries(Object.entries(saved).filter(([k])=>
        keys===null || (typeof keys==='string'?k===keys:keys.includes(k)))),
      set:async(o:Record<string,unknown>)=>Object.assign(saved,o),
      remove:async(k:string)=>{delete saved[k];},
    }},
    scripting:{executeScript:async (args:{target:{documentIds?:string[]}})=>[{
      frameId:0,documentId:tab.doc,result:args.target.documentIds?
        (tab.url===article?'a':'b').repeat(32):new URL(tab.url!).origin,
    }]},
  }});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'chrome',previous);else Reflect.deleteProperty(globalThis,'chrome');});
  const emit=async (w=worker,op='arrive')=>w.page({op,revision:store.get(tab.id!).protection?.revision},
    {id:'fixture-extension',frameId:0,documentId:tab.doc,tab});
  const get=()=>store.get(tab.id!).protection!;
  const manual=(scope:'page'|'root')=>worker.operate(tab,{op:'threat',scope,revision:get().revision});
  const idle=async(w=worker)=>{await (w as unknown as {tail:Promise<void>}).tail;};
  return {store,worker,tab,saved,packets,painted,get,emit,idle,manual,makeReply,
    setReply:(next:typeof reply)=>{reply=next;},advance:(ms:number)=>{now+=ms;},
    disconnect:()=>{paired=false;}};
}

test('opted-in arrival sends the root only, keeps its warning across a page miss and never caches misses',async t=>{
  const f=await fixture(t);
  await f.emit(); await f.idle();
  assert.deepEqual(f.packets,[{route:'/v1/threat/check',body:{scope:'root',url:origin+'/'}}]);
  assert.equal(f.get().threatPage,article);
  assert.equal(f.get().threat?.status,'match');
  assert(f.get().caution);
  f.setReply(q=>Response.json(f.makeReply(q,'no_match')));
  await f.manual('page'); await f.idle();
  assert.equal(f.get().threat?.scope,'page');
  assert.equal(f.get().threat?.status,'no_match');
  assert.deepEqual(f.get().threatWarnings?.map(x=>x.url),[origin+'/']);
  assert(f.get().caution);
  await f.manual('page'); await f.idle();
  assert.match(f.get().threatNotice!,/budget/i);
  assert.equal(f.packets.length,2);
  f.advance(60_001);
  await f.manual('page'); await f.idle();
  assert.equal(f.packets.filter(x=>x.route==='/v1/threat/check').length,3);
  await f.manual('root'); await f.idle();
  assert.equal(f.packets.at(-1)?.route,'/v1/explain/connect');
  f.advance(60_001);
  await f.emit(f.worker,'expire');
  assert(!f.get().caution);
  assert.equal(f.get().threatWarnings?.length,0);
});

test('merchant and threat use one persisted quota and pairing; private data cannot enter a request',async t=>{
  const f=await fixture(t,true);
  f.store.prefs.protection!.budget=1;
  await f.emit(); await f.idle();
  assert.equal(f.packets.length,1);
  assert.equal(f.get().status,'quota');
  assert(f.get().caution);
  f.disconnect();
  const restored=new Protection(f.store,noop);
  await restored.restore();
  assert.equal(f.get().threatWarnings?.length,0);
  assert.match(f.get().threatNotice!,/pairing expired/i);
  assert.equal(f.packets.filter(x=>x.route==='/v1/threat/check').length,1);
  f.tab.url=origin+'/wiki/Example?token=private-fixture';
  await restored.navigation(f.tab.id!,{url:f.tab.url},f.tab);
  await f.idle(restored);
  assert.equal(f.get().status,'private');
  assert.equal(f.get().threatHome,undefined);
  await restored.operate(f.tab,{op:'threat',scope:'page',revision:f.get().revision});
  assert(!JSON.stringify(f.packets).includes('private-fixture'));
});

test('an explicit page lookup cannot update a replacement route, and repeated clicks share one request',async t=>{
  const f=await fixture(t);
  f.store.prefs.protection!.threatRoot=false;
  await f.emit(); await f.idle();
  assert.equal(f.packets.length,0);
  let release!:()=>void,start!:()=>void;
  const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>start=r);
  f.setReply(async q=>{start();await hold;return Response.json(f.makeReply(q,'match'));});
  const old=f.get().revision;
  await f.manual('page'); await started;
  await f.manual('page');
  assert.equal(f.packets.length,1);
  f.tab.url=origin+'/wiki/Atmosphere_of_Mars';
  await f.worker.navigation(f.tab.id!,{url:f.tab.url},f.tab);
  assert.notEqual(f.get().revision,old);
  release(); await f.idle();
  assert.equal(f.get().threat,undefined);
  assert(!f.get().caution);
  await assert.rejects(f.worker.operate(f.tab,{op:'threat',scope:'page',revision:old}));
  assert(!f.painted.some(v=>v.threat?.url===article && v.revision!==old));
});

test('a newly reported page match is visible even after the root warning was dismissed',async t=>{
  const f=await fixture(t);
  await f.emit();await f.idle();
  await f.worker.operate(f.tab,{op:'dismiss',revision:f.get().revision});
  assert(f.get().dismissed);
  await f.manual('page');await f.idle();
  assert.equal(f.get().threatWarnings?.length,2);
  assert.equal(f.get().dismissed,false);
  f.advance(120_001);
  // A worker can be suspended while the content timer is pending. The panel
  // must not return an expired match as current on its first subsequent read.
  assert.equal(await f.worker.isCurrent(f.tab,f.get()),false);
  assert.equal(f.get().caution,false);
  assert.equal(f.get().threat,undefined);
  assert.match(f.get().threatNotice!,/expired/);
});
