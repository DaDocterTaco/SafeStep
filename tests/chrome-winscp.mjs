// Installed, disposable Chrome. Only information pages can be navigated.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { dockControl } from './support/design-cues.mjs';
import { startFixture } from './fixtures/serve.mjs';

const [id,run='local']=process.argv.slice(2);
assert.match(id,/^stage-8-[0-9a-f]{12}$/);
const bundle=resolve('artifacts',id,'chrome-mv3'), fp=await fingerprint(bundle);
assert.equal(id,'stage-8-'+fp.sha256.slice(0,12));
const refs=JSON.parse(await readFile('docs/evidence/'+id+'/current-reference.json','utf8'));
assert.equal(refs.extensionSHA256,fp.sha256);
const liveAI=run==='ai', fixture=await startFixture(0);
const out=join('docs/evidence',id,'winscp',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(out,{recursive:true});
const report={role:'builder',id,reference:refs.path,sha256:fp.sha256,run,results:[],started:new Date().toISOString()};
const save=()=>writeFile(join(out,'results.json'),JSON.stringify(report,null,2)+'\n');
let server, token, ledger;
const site='https://winscp.net/eng/', standard='Help me find the standard WinSCP installer for Windows.',
  portable='Show me the portable WinSCP download, not PuTTY or source code.',
  automatic='Take me to the correct WinSCP download, but do not download it.';
const btn=(p,n)=>p.locator('::-p-aria('+n+'[role="button"])').setTimeout(7500);
const state=async s=>(await view(s.panel)).v;
async function until(f,label,ms=12000){
  const end=Date.now()+ms;
  while(Date.now()<end){const v=await f().catch(()=>false);if(v)return v;await delay(100);}
  throw Error('Timed out: '+label);
}
async function say(s,text){
  await s.panel.click('#chat-composer');
  await s.panel.keyboard.type(text);
  await s.panel.keyboard.press('Enter');
}
async function shot(s,row,label){
  for(const [which,page] of [['page',s.page],['panel',s.panel]]){
    const name=row.name+'-'+row.width+'-'+label+'-'+which+'.png';
    await page.screenshot({path:join(out,name)});row.screens.push(name);
  }
}
async function cleanup(s,r){
  await s.page.evaluate(()=>window.scrollTo(0,0));
  const readSlots=()=>s.page.evaluate(()=>[...document.querySelectorAll('ins.adsbygoogle')].slice(0,15).map(el=>({
    filled:el.getAttribute('data-ad-status'),frames:el.querySelectorAll('iframe').length,
    titles:[...el.querySelectorAll('iframe')].map(f=>f.title).slice(0,5),
    hosts:[...el.querySelectorAll('iframe')].map(f=>{try{return new URL(f.src).hostname;}catch{return null;}}).slice(0,5),
    visible:el.getBoundingClientRect().height>0,
  })));
  await s.page.waitForFunction(()=>document.querySelector('ins.adsbygoogle iframe'),{timeout:2000}).catch(()=>{});
  r.slots=await readSlots();
  await say(s,'Hide the ads so I can see the real download.');
  const preview=await until(async()=>{const v=await state(s);return v.chat?.turns.at(-1)?.state==='preview_ready'&&v.cleanup;},'cleanup preview');
  r.preview=preview.items.map(i=>({signal:i.signal,reason:i.reason,hidden:i.hidden}));
  await shot(s,r,'preview');
  if(!preview.items.some(i=>i.reason==='advertisement')){
    r.cleanup='no eligible visible ad wrapper';return false;
  }
  await btn(s.panel,'Apply cleanup').click();
  const hidden=await until(async()=>(await state(s)).cleanup?.hidden,'owned regions hidden');
  const facts=()=>s.page.evaluate(()=>({
    hidden:document.querySelectorAll('[data-safestep-clean]').length,
    files:[...document.querySelectorAll('a[href]')].filter(a=>/WinSCP-[\d.]+-(?:Setup\.exe|Portable\.zip)\/download$/.test(a.href)).map(a=>({label:a.textContent.trim(),visible:a.checkVisibility()})),
    security:[...document.querySelectorAll('[data-security],[data-consent]')].every(e=>e.checkVisibility()),
  }));
  r.applied=await facts();assert.equal(r.applied.hidden,hidden);
  assert(r.applied.files.length&&r.applied.files.every(a=>a.visible)&&r.applied.security);
  await shot(s,r,'applied');
  await btn(s.panel,'Settings').click();
  const reading=await s.panel.$('summary::-p-text(Reading and conversation)');
  if(reading && !await reading.evaluate(e=>e.parentElement.open))await reading.click();
  await btn(s.panel,'New chat').click();
  const close=await s.panel.$('::-p-aria(Close Settings[role="button"])');
  if(close&&await close.isVisible())await close.click();
  assert.equal((await state(s)).cleanup.hidden,hidden);
  r.retainedAfterClear=true;
  await btn(s.panel,'Tuck panel').click();
  await dockControl(s,'Restore page',true);
  await until(async()=>(await facts()).hidden===0,'tucked Restore');
  r.restored=await facts();assert(r.restored.files.every(a=>a.visible)&&r.restored.security);
  const name=r.name+'-'+r.width+'-restored-page.png';await s.page.screenshot({path:join(out,name)});r.screens.push(name);
  r.cleanup='preview, apply, retained file controls, tucked restore';return true;
}
async function trial(name,width){
  const r={name,width,source:name==='fixture'?'inert local combined fixture':liveAI?'live publisher and guarded text intent':'live publisher, unpaired local checks',screens:[],fileRequests:0,downloadEvents:0,driverSiteClicks:0,navigations:[],status:'fail'};
  let s;
  try{
    const origin=['fixture','covered'].includes(name)?fixture.origin+'/download-lab?product=winscp':
      name==='vlc'?'https://www.videolan.org/vlc/download-windows.html':name==='7zip'?'https://www.7-zip.org/download.html':
      site+(name==='auto' || name==='portable-auto'?'download.php':'downloads.php');
    s=await nativeSession(bundle,width,width===1440?900:768,origin,{requireUsablePanel:true,...(liveAI?{apiHost:'127.0.0.6'}:{}),prepare:async p=>{
      await p.setRequestInterception(true);p.on('request',q=>{
        let u;try{u=new URL(q.url());}catch{return void q.abort();}
        const top=q.isNavigationRequest()&&q.frame()===p.mainFrame();
        if((u.hostname==='winscp.net'&&u.pathname.startsWith('/download/'))||/\.(?:exe|msi|zip|7z)(?:\/download)?$/i.test(u.pathname)){
          r.fileRequests++;return void q.abort();
        }
        if(top){r.navigations.push(u.origin+u.pathname);if(u.origin!==new URL(origin).origin ||
          (u.origin==='https://winscp.net'&&!/^\/eng\/downloads?\.php$/.test(u.pathname)))return void q.abort();}
        void q.continue().catch(()=>{});
      });
    }});
    r.dimensions=s.dimensions;r.chrome=await s.browser.version();
    assert.equal(resolve((await s.root.send('Extensions.getExtensions')).extensions.find(e=>e.id===s.id).path),bundle);
    await s.root.send('Browser.setDownloadBehavior',{behavior:'deny',eventsEnabled:true});
    s.root.on('Browser.downloadWillBegin',()=>r.downloadEvents++);
    if(name==='cleanup'){
      const ok=await cleanup(s,r);r.status=ok?'pass':'live_ads_unavailable';return;
    }
    if(name==='covered'){
      await s.page.evaluate(()=>{
        const cover=document.createElement('div');cover.setAttribute('role','dialog');
        cover.style.cssText='position:fixed;inset:0;z-index:99999;background:white';cover.textContent='Labelled inert fixture overlay. Close ad manually.';
        document.body.append(cover);
      });
      await say(s,standard);
      await until(async()=>(await state(s)).task?.state==='awaiting_confirmation','fixture goal ready');
      await btn(s.panel,'Take me there').click();await btn(s.panel,'Start automatic').click();
      await until(async()=>{const v=await state(s);return v.task?.state==='paused'&&!v.task.adaptive.authorized&&!v.review?.selected;},'covered file refused');
      r.covered='Paused before the covered file control with no selected package';
      await btn(s.panel,'Stop').click();
      await until(async()=>(await state(s)).task?.state==='cancelled','Stop acknowledged');
      await s.page.goto(fixture.origin+'/help');await delay(200);
      assert(!await s.page.$('[data-safestep-outline],[data-safestep-clean]'));
      r.recovery='Stopped, different document has no stale cue or cleanup';r.status='pass';return;
    }
    if(liveAI){
      await btn(s.panel,'Settings').click();
      await s.panel.locator('summary::-p-text(Connect local AI)').click();await s.panel.type('input[type=password]',token);
      await btn(s.panel,'Connect').click();
      await s.panel.waitForFunction(()=>document.body.innerText.includes('Connected to Gemini'),{timeout:7000});
      await btn(s.panel,'Close Settings').click();
    }
    const isAuto=name==='auto'||name==='portable-auto';
    r.goal=name==='auto'?automatic:name.includes('portable')?portable:
      name==='vlc'?'Help me find the VLC Windows x64 EXE download':name==='7zip'?'Find the 7-Zip Windows x64 EXE download':standard;
    await say(s,r.goal);
    const t=await until(async()=>{const t=(await state(s)).task;return t?.goal===r.goal&&['awaiting_confirmation','paused'].includes(t.state)&&t;},'actual package intent',liveAI?23000:10000);
    r.intent={state:t.state,profile:t.adaptive?.download,status:t.adaptive?.status,calls:t.adaptive?.calls,parsed:t.adaptive?.intent};assert.equal(t.state,'awaiting_confirmation');
    if(liveAI){assert(t.adaptive.calls>0&&t.adaptive.intent?.subjects.length,'validated genuine intent required');}
    if(isAuto){await btn(s.panel,'Take me there').click();await btn(s.panel,'Start automatic').click();}
    else await btn(s.panel,'Show me').click();
    const d=await until(async()=>{const v=await state(s);return v.task?.state==='completed'&&v.review?.selected&&v.review;},'verified publisher control',12000);
    const candidate=d.candidates.find(c=>c.ref===d.selected);
    assert(candidate?.publisherPath);r.selected=candidate;r.alternatives=d.candidates.map(c=>({label:c.label,kind:c.relation,package:c.packageHint}));
    assert(name==='vlc'||name==='7zip'||(name.includes('portable')?/-Portable\.zip\/download$/:/-Setup\.exe\/download$/).test(candidate.publisherPath));
    const owns=await s.page.evaluate(path=>{const el=[...document.querySelectorAll('a[href]')].find(a=>new URL(a.href).pathname===path);
      return {registered:!!el,outline:!!document.querySelector('[data-safestep-outline]'),visible:el?.checkVisibility()};},candidate.publisherPath);
    assert(owns.registered&&owns.outline&&owns.visible);
    await shot(s,r,'handoff');
    if(name==='fixture'){
      await s.page.$eval('#setup',a=>a.href='https://example.invalid/changed');await until(()=>s.page.evaluate(()=>!document.querySelector('[data-safestep-outline]')),'stale outline cleared');
      r.stale='Changed file target retired without activation';
      assert(await cleanup(s,r),'inert fixture ad required');
    }
    r.status='pass';
  }catch(e){
    r.error=String(e.message??e).slice(0,260);
    if(s){const v=await state(s).catch(()=>null);r.diagnostic={task:v?.task?.state,why:v?.task?.adaptive?.status,turn:v?.chat?.turns.at(-1)?.text,review:v?.review?.fileState,issue:v?.issue};await shot(s,r,'observed').catch(()=>{});}
  }finally{
    if(r.fileRequests||r.downloadEvents)r.status='fail';
    await s?.browser.close();report.results.push(r);await save();console.log(r.status,r.name,width,r.error??'',r.diagnostic?.why??'');
  }
}
try{
  if(liveAI){
    const {PaidLedger}=await import('../scripts/stage8-paid-ledger.mjs');
    ledger=new PaidLedger(resolve('.test-artifacts/stage8-paid-budget'),false,'builder');
    assert(ledger.bounded()?.grant_id==='winscp-text-test-1');
    report.paidBefore=ledger.status();
    const {makeApi}=await import('../apps/api/dist/app.js'),{GeminiService,newPairToken}=await import('../apps/api/dist/gemini.js');
    token=newPairToken();server=makeApi(undefined,new GeminiService(process.env,token));server.listen(4317,'127.0.0.6');await once(server,'listening');
    await trial('ai-standard',1440);
  }else{
    const names=run==='quick'?['guide','auto','portable']:run==='remaining'?['cleanup','fixture','portable-auto','vlc','7zip']:run.split(',');
    for(const w of (process.env.SAFESTEP_WIDTH?[Number(process.env.SAFESTEP_WIDTH)]:[1440,1366]))
      for(const name of names)await trial(name,w);
  }
}finally{
  if(ledger){report.paidAfter=ledger.status();report.sessionReceipts=ledger.report().attempts.filter(a=>a.session===ledger.session);ledger.close();}
  if(server)server.close();fixture.server.close();report.finished=new Date().toISOString();await save();console.log(out);
}
if(report.results.some(r=>r.status==='fail'))process.exitCode=1;
