import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {AdaptiveNavigation} from '../apps/extension/core/adaptive';
import {Store} from '../apps/extension/core/store';
import type {RecordState} from '../apps/extension/core/state';
import type {AssistBinding, AssistPage, AssistSnapshot, PublicRef, StepInput, Step} from '@safestep/contracts';

const origin = 'https://en.wikipedia.org';
const query = 'the atmosphere of Earth';
const search = origin + '/w/index.php?title=Special%3ASearch&search=the+atmosphere+of+Earth';

// Drive the actual onUpdated handler. Replace only browser lookups and the
// next planning call, so no provider or page action can run.
function scenario(t: TestContext, staleFrames = 0) {
  const store = new Store(), state=store.get(42), nav=new AdaptiveNavigation(store);
  const tab = {id:42,active:true,windowId:1,status:'complete',url:search} as chrome.tabs.Tab;
  let documentId='1'.repeat(32);
  const previous=Object.getOwnPropertyDescriptor(globalThis,'chrome');
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{
    tabs:{get:async()=>tab,sendMessage:async()=>null}, windows:{get:async()=>({focused:true})},
    scripting:{executeScript:async (args: {args?:string[]})=>{
      const old=staleFrames-- > 0;
      return [{frameId:0,documentId:old?'0'.repeat(32):documentId,
        result:args.args ? {matches:!old,ready:!old} : origin}];
    }},
    runtime:{id:'a'.repeat(32),sendMessage:async()=>{}},
  }});
  t.after(()=>{if(previous) Object.defineProperty(globalThis,'chrome',previous); else Reflect.deleteProperty(globalThis,'chrome');});
  t.mock.method(store,'save',async()=>{});
  state.windowId=1;state.cp.invokedOrigin=origin;
  const task = state.cp.task = {id:crypto.randomUUID(),tabId:42,epoch:0,steps:1,cancelled:false,
    state:'showing_step',goal:'Find the Wikipedia article about the atmosphere of Earth.',mode:'guide',
    documentId:'0'.repeat(32),revision:crypto.randomUUID(),lastVerified:'inspected',
    adaptive:{origin,profile:'wikipedia',version:1,searchQuery:query,intent:null,status:'Search Wikipedia',
      since:Date.now(),calls:0,noProgress:0,authorized:false,journal:null}};
  type RunFixture = {from?:string;arrived?:string;expected?:string;selected?:PublicRef;history:string[];
    b?: AssistBinding; snap?: AssistSnapshot; waiting?:boolean; transition?:boolean};
  const internal = nav as unknown as {createRun:(s:RecordState)=>RunFixture;plan:(s:RecordState,r:RunFixture)=>Promise<void>;
    inspect:(s:RecordState,r:RunFixture)=>Promise<AssistSnapshot>; verifyLocal:(s:RecordState,r:RunFixture)=>Promise<void>;
    send:(b:AssistBinding,c:AssistPage['cmd'])=>Promise<AssistSnapshot|null>;
    confirmSnapshot:(s:RecordState,r:RunFixture)=>Promise<void>;
    request:(s:RecordState,r:RunFixture,input:StepInput)=>Promise<Step>};
  const run=internal.createRun(state);
  run.from='/wiki/Main_Page'; run.arrived=run.from; run.expected=run.from;
  run.selected={ref:crypto.randomUUID(),role:'search',action:'submit_public_search',path:null,visible:true,label:'Search Wikipedia'};
  const plans=t.mock.method(internal,'plan',async (_s,r)=>{
    r.selected=undefined; r.expected=undefined;
    state.cp.task!.state='planning';
  });
  const update = async (url:string, replacement=false) => {
    tab.url=url;
    if(replacement) documentId='2'.repeat(32);
    await nav.navigation(state,{url,status:'complete'},tab);
  };
  return {task,run,plans,update,nav,state,tab,internal};
}

test('a complete tab event cannot bind or count a same-origin frame still showing the previous page', async t=>{
  const {task,plans,update} = scenario(t,2);
  await update(search);
  await update(search+'&ns0=1');
  assert.equal(task.state,'planning',task.adaptive.status);
  assert.equal(task.steps,2);
  assert.equal(plans.mock.callCount(),1);
});
test('the identified responsive Wikipedia toggle can land on its actual public search form',async t=>{
  const {task,run,plans,update}=scenario(t);
  run.expected='/wiki/Special:Search';
  run.selected={ref:crypto.randomUUID(),label:'Open Wikipedia search',path:'/wiki/Special:Search',
    role:'button',action:'toggle_known_navigation',visible:true};
  await update(origin+'/wiki/Special:Search');
  assert.equal(plans.mock.callCount(),1);assert.equal(task.steps,2);assert.notEqual(task.state,'paused');
  await update(origin+'/wiki/Special:UserLogin');
  assert.equal(task.state,'paused');
});

function bind(taskId: string): AssistBinding {
  return {operationId:crypto.randomUUID(),taskId,tabId:42,windowId:1,goalVersion:1,
    origin,documentId:'1'.repeat(32),epoch:0,revision:crypto.randomUUID(),generation:1};
}
for(const oldState of ['paused','showing_step'] as const){
  test('a retired catalog task cannot erase an explicit grant to the current storefront: '+oldState,async t=>{
    const {task,run,state,update}=scenario(t);
    const tenant='https://nibdrawer.resell.store';
    state.cp.invokedOrigin=tenant;
    task.adaptive.origin='https://resell.store';task.adaptive.profile='catalog';task.adaptive.authorized=true;
    task.state=oldState;
    run.from='/discover';run.expected='/pen';
    await update(tenant+'/pen');
    assert.equal(state.cp.invokedOrigin,tenant);
    assert.equal(task.state,'paused');
    if(oldState==='showing_step')assert.equal(task.adaptive.authorized,false);
  });
}

test('a guide click tolerates the retiring document, while Stop cancels progress and its late arrival',async t=>{
  const {task,run,plans,update,nav,state,tab}=scenario(t);
  const b=run.b=bind(task.id);
  run.selected={ref:crypto.randomUUID(),label:'Atmosphere of Earth',role:'link',
    action:'activate_readonly_link',path:'/wiki/Atmosphere_of_Earth',visible:true};
  run.from='/wiki/Special:Search';
  run.expected=run.selected.path!;
  const sender={id:chrome.runtime.id,frameId:0,documentId:b.documentId,tab};
  const send=(event:string)=>nav.notice({channel:'assist-notice',binding:b,event},sender);
  await send('user_target');
  assert.equal(run.waiting,true);
  await send('changed');
  assert.notEqual(task.state,'paused');
  await nav.control(state,tab,'stop');
  await update(origin+run.expected);
  assert.equal(task.state,'cancelled');
  assert.equal(plans.mock.callCount(),0);
  assert.equal(task.steps,1);
});

test('a delayed disclosure is verified when its own public search field appears',async t=>{
  const {task,run,plans,state,internal}=scenario(t);
  const toggle:PublicRef={ref:crypto.randomUUID(),label:'Open Wikipedia search',role:'button',
    action:'toggle_known_navigation',path:null,visible:true};
  const before:AssistSnapshot={profile:'wikipedia',path:'/wiki/Main_Page',controls:[toggle],
    headings:[],limited:false,complete:null};
  run.b=bind(task.id);
  run.selected=toggle;
  run.snap=before;
  let calls=0;
  t.mock.method(internal,'confirmSnapshot',async()=>{});
  t.mock.method(internal,'send',async()=>run.snap!);
  t.mock.method(internal,'inspect',async()=>run.snap=++calls<3 ? before : {...before,controls:[
    {ref:crypto.randomUUID(),label:'Search Wikipedia',role:'search',action:'submit_public_search',visible:true,path:null}]});
  await internal.verifyLocal(state,run);
  assert.equal(calls,3);
  assert.equal(task.steps,2);
  assert.equal(plans.mock.callCount(),1);
});

test('opening a disclosure waits for its newly rendered eligible choice before replanning',async t=>{
  const {task,run,plans,state,internal}=scenario(t);
  const toggle:PublicRef={ref:crypto.randomUUID(),label:'Reading menu',role:'button',
    action:'toggle_known_navigation',path:null,visible:true,expanded:false};
  const before:AssistSnapshot={profile:'experimental',path:'/public-guide-lab/',controls:[toggle],
    headings:[],limited:false,complete:null};
  run.b=bind(task.id);run.selected=toggle;run.snap=before;
  let reads=0;
  t.mock.method(internal,'confirmSnapshot',async()=>{});
  t.mock.method(internal,'send',async()=>run.snap!);
  t.mock.method(internal,'inspect',async()=>run.snap=({...before,controls:[
    {...toggle,expanded:true}, ...(++reads<3?[]:[{label:'Reading room',ref:crypto.randomUUID(),
    role:'link',action:'activate_readonly_link',visible:true,path:'/public-guide-lab/reading-room'}])]}));
  await internal.verifyLocal(state,run);
  assert.equal(reads,3);
  assert.equal(plans.mock.callCount(),1);
  assert.equal(task.steps,2);
});

for (const interruption of ['widget replacement','Stop'] as const) {
  test('a verified search disclosure makes one grounded follow-up or none on '+interruption,async t=>{
    const {task,run,plans,internal,state,tab,nav}=scenario(t);
    plans.mock.restore(); // Drive the real planning loop, replacing only browser and provider I/O.
    task.adaptive.intent={action:'find_document',subjects:[{start:0,end:4,text:'Find'}],
      constraints:[],excluded:[],question:'',choices:[]};
    const toggle:PublicRef={ref:crypto.randomUUID(),label:'Open Wikipedia search',role:'button',
      action:'toggle_known_navigation',path:null,visible:true};
    const first:PublicRef={ref:crypto.randomUUID(),label:'Search Wikipedia',role:'search',
      action:'submit_public_search',path:null,visible:true};
    const replacement={...first,ref:crypto.randomUUID()};
    const start:AssistSnapshot={profile:'wikipedia',path:'/wiki/Main_Page',controls:[toggle],
      headings:[],limited:false,complete:null};
    run.b=bind(task.id);run.selected=toggle;run.snap=start;
    let actual=first;
    const proposals:string[]=[],cues:string[]=[];
    t.mock.method(internal,'confirmSnapshot',async()=>{});
    t.mock.method(internal,'inspect',async()=>run.snap={...start,controls:[actual]});
    t.mock.method(internal,'send',async(_b,c)=>{
      if(c.op==='verify_snapshot'){
        if(run.snap!.controls[0]?.ref!==actual.ref)throw Error('The controls changed during disclosure.');
        return run.snap!;
      }
      if(c.op==='cue')cues.push(c.ref);
      return null;
    });
    t.mock.method(internal,'request',async(_s,_r,input)=>{
      const ref=input.snapshot.controls[0]!.ref;
      proposals.push(ref);
      return {kind:'next_candidate',ref,action:'submit_public_search',citations:[ref]};
    });
    const wait=internal.verifyLocal(state,run);
    const stop=interruption==='Stop';
    const settled=stop ? assert.rejects(wait,/operation changed/i):wait;
    const timer=setTimeout(()=>{
      actual=replacement;
      if(stop)void nav.control(state,tab,'stop');
      else void nav.notice({channel:'assist-notice',binding:run.b,event:'changed'},
        {id:chrome.runtime.id,frameId:0,documentId:run.b!.documentId,tab});
    },175);
    t.after(()=>clearTimeout(timer));
    await settled;
    assert.deepEqual(proposals,stop?[]:[replacement.ref]);
    assert.deepEqual(cues,proposals);
    assert.equal(task.state,stop?'cancelled':'showing_step');
    assert.equal(task.steps,stop?1:2);
  });
}

for (const disposition of ['clean destination','foreign parameter','wrong title','unknown provenance','unobserved activation'] as const) {
  test('Wikipedia result-click normalization: '+disposition,async t=>{
    const {task,run,plans,update,nav,tab}=scenario(t);
    await update(search);
    const b=run.b=bind(task.id);
    const article='/wiki/Atmosphere_of_Earth';
    run.from='/wiki/Special:Search'; run.expected=article;
    run.selected={ref:crypto.randomUUID(),label:'Atmosphere of Earth',role:'link',
      action:'activate_readonly_link',path:article,visible:true};
    const notify=(event:string)=>nav.notice({channel:'assist-notice',binding:b,event},
      {id:chrome.runtime.id,frameId:0,documentId:b.documentId,tab});
    if(disposition!=='unobserved activation') await notify('user_target');
    await update(search+'&ns0=1&searchToken=fixture');
    if(disposition==='unobserved activation') {
      assert.equal(task.state,'paused');
      assert.equal(plans.mock.callCount(),1);
      return;
    }
    await update(origin+(disposition==='wrong title'?'/wiki/Mars':article)+
      '?wprov='+(disposition==='unknown provenance'?'unknown':'srpw1_0')+
      (disposition==='foreign parameter'?'&extra=1':''),true);
    // The opaque intermediate addresses themselves never plan or mark progress.
    assert.equal(task.steps,2);
    assert.equal(plans.mock.callCount(),1);
    if(disposition==='clean destination'){
      assert.notEqual(task.state,'paused');
      await update(origin+article);
      assert.equal(task.steps,3);
      assert.equal(plans.mock.callCount(),2);
    } else assert.equal(task.state,'paused');
  });
}

for(const interruption of ['changed query','replaced document'] as const) {
  test('Wikipedia counts the verified search once and stops on ' + interruption, async(t)=>{
    const {task,run,plans,update} = scenario(t);
    await update(search);
    assert.equal(task.steps,2);
    assert.equal(plans.mock.callCount(),1);
    await update(search+'&ns0=1');
    await update(search.replace('title=Special%3ASearch&search=the+atmosphere+of+Earth',
      'search=the+atmosphere+of+Earth&title=Special%3ASearch&ns0=1'));
    assert.equal(task.state,'planning');
    assert.equal(task.steps,2);
    assert.equal(plans.mock.callCount(),1);
    assert.deepEqual(run.history,['Search Wikipedia']);
    if(interruption==='changed query') await update(search.replace('Earth','Mars')+'&ns0=1');
    else await update(search+'&ns0=1',true);
    assert.equal(task.state,'paused');
    assert.equal(task.steps,2);
    assert.equal(plans.mock.callCount(),1);
    assert.match(task.adaptive.status, interruption==='changed query' ? /search changed/i : /document was replaced/i);
  });
}
