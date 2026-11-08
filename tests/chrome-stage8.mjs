// Builder journeys on a fresh Chrome profile. No live model or provider credentials are used.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { merchantService, testArrival } from './support/stage8-protection.mjs';

const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? 'apps/extension/.output/chrome-mv3');
const { sha256 } = await fingerprint(bundle);
assert.match(JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')).version, /^0\.8\./);
const trial = process.env.SAFESTEP_S8_TRIAL ?? 'builder';
assert.match(trial, /^[a-z0-9-]{1,40}$/);
const out = resolve('.test-artifacts/stage8', sha256.slice(0,12), trial);
await mkdir(out, { recursive: true });
const lab = await startFixture(0);
const base = lab.origin;
const urls = {
  home: base + '/settings-lab', offline: base + '/settings-lab', cleanup: base + '/cleanup-lab',
  usernameGuide: base + '/settings-lab', usernameAuto: base + '/settings-lab',
  history: base + '/settings-lab',
  isolation: base + '/settings-lab', compare: base + '/comparison-lab/original',
  shopping: base + '/shopping-lab/listing', trust: base + '/trust-lab',
  arrival: 'https://example.org/?safestep_setup=private',
  amazonBoundary:'https://www.amazon.com/',
  seller: 'https://foxedandfound.resell.store/mastering-art-french-cooking-1961',
  product: 'https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/',
  vlcGuide: 'https://www.videolan.org/', vlcAuto: 'https://www.videolan.org/',
  zipGuide: 'https://www.7-zip.org/download.html', zipAuto: 'https://www.7-zip.org/download.html',
};
const groups = (process.env.SAFESTEP_S8_CASES ?? Object.keys(urls).join(',')).split(',');
assert(groups.length && groups.every(g=>Object.hasOwn(urls,g)));
const results=[];
const button=(page,name)=>page.locator('::-p-aria('+name+'[role="button"])').setTimeout(7500);
const composer='#chat-composer';
const featureIds=['visual_guidance','url_identity','site_trust','download_guidance','seller_assessment','product_assessment','automatic_navigation','page_cleanup','shopping_alternatives'];
const readView=async s=>(await view(s.panel)).v;
async function until(fn, note, ms=18000) {
  const end=Date.now()+ms;
  while(Date.now()<end){const v=await fn();if(v)return v;await delay(75);}
  throw Error('Timed out: '+note);
}
async function visible(page,css){
  const items=await page.$$(css);
  for(const el of items)if(await el.evaluate(e=>e.checkVisibility()&&e.getBoundingClientRect().height>0))return el;
  return null;
}
async function actFeature(panel,id){
  let el=await visible(panel,'[data-feature="'+id+'"]');
  if(!el){await button(panel,'Help').click();el=await until(()=>visible(panel,'[data-feature="'+id+'"]'),'Help entry '+id);}
  await el.click();
}
async function submit(p,text){
  await p.focus(composer);
  await p.keyboard.down('Control');await p.keyboard.press('a');await p.keyboard.up('Control');
  await p.keyboard.type(text);await p.keyboard.press('Enter');
}
async function shot(s,r,name,page=false){
  const file=r.name+'-'+r.width+'-'+name+(page?'-page':'-panel')+'.png';
  await (page?s.page:s.panel).screenshot({path:join(out,file)});r.screens.push(file);
}
function record(r,ids,detail){for(const id of ids.split(' '))(r.caseChecks[id]??=[]).push(detail);}
async function waitText(p,css,text){
  return until(()=>p.$eval(css,(e,txt)=>e.innerText.includes(txt),text).catch(()=>false),text);
}
async function dimensions(s){
  return s.panel.evaluate(()=>({viewport:[innerWidth,innerHeight],scroll:document.documentElement.scrollWidth,
    input:(()=>{const e=document.querySelector('#chat-composer');const a=e.getBoundingClientRect();return [a.x,a.y,a.width,a.height,a.bottom]})()}));
}
async function home(s,r){
  const p=s.panel;
  assert.equal(await p.$$eval('textarea',es=>es.filter(e=>e.checkVisibility()).length),1);
  assert.equal(await p.$('[role=tablist]'),null);
  assert(await p.$('[role=log]'));
  const examples=await p.$$eval('[data-feature]',es=>es.filter(e=>e.checkVisibility()).map(e=>e.dataset.feature));
  assert(examples.length>0&&examples.length<=3);
  assert.match(await p.$eval('body',e=>e.innerText),/localhost/);
  await shot(s,r,'home');
  await button(p,'Help').click();
  const help=await p.$$eval('[data-feature]',es=>es.filter(e=>e.checkVisibility()).map(e=>e.dataset.feature));
  assert(featureIds.every(id=>help.includes(id)));
  await p.keyboard.press('Escape');
  await until(()=>p.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='Help'||document.activeElement?.textContent.trim()==='Help'),'focus returned to Help');
  await button(p,'Settings').click();
  await p.locator('summary::-p-text(Reading and conversation)').click();
  const larger=await p.waitForSelector('::-p-aria(Larger text[role="checkbox"])',{timeout:5000});
  await larger.click();await until(async()=>(await readView(s)).prefs.largeText,'larger text');
  await shot(s,r,'settings-large');await p.keyboard.press('Escape');
  await until(()=>p.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='Settings'||document.activeElement?.textContent.trim()==='Settings'),'focus returned to Settings');
  const d=await dimensions(s);assert(d.scroll<=d.viewport[0]+1);assert(d.input[4]<=d.viewport[1]+1);
  r.layout=d;
  await p.focus(composer);await p.keyboard.type('First line');await p.keyboard.down('Shift');await p.keyboard.press('Enter');await p.keyboard.up('Shift');await p.keyboard.type('second line');
  assert.equal(await p.$eval(composer,e=>e.value),'First line\nsecond line');
  record(r,'S8-U01 S8-U02 S8-U03','One labelled composer and conversation log, actual host, at most three contextual shortcuts, nine Help tools, separate Settings, visible larger text, multiline input and keyboard focus return.');
}
async function offline(s,r){
  const p=s.panel, original='Tell me about a different public reading topic with no substitutions.';
  await submit(p,original);await waitText(p,'[role=log]',original);
  await until(()=>p.$eval('[role=log]',e=>/unavailable|offline|connect|pair|not configured|could not route/i.test(e.innerText)),'truthful offline state');
  assert.equal((await readView(s)).task,null);
  await actFeature(p,'site_trust');
  await until(async()=>(await readView(s)).review?.selection.kind==='website','local website result');
  await shot(s,r,'offline-and-local-result');
  record(r,'S8-S04 S8-F02','Unknown free text remained in the log with an unavailable-service state; a direct website check returned current local findings without a model key.');
}
async function clearConversation(p){
  await button(p,'Settings').click();
  const disclosure=await p.$('summary::-p-text(Reading and conversation)');
  if(disclosure && !(await disclosure.evaluate(e=>e.parentElement.open)))await disclosure.click();
  await button(p,'New chat').click();
}
async function history(s,r){
  const p=s.panel;
  const initial='Public reading request ';
  for(let n=0;n<28;n++){
    const text=initial+String(n)+' about finding a public topic.';
    await submit(p,text);
    await until(async()=>{const c=(await readView(s)).chat;return c?.turns.some(t=>t.role==='user'&&t.text===text)&&c.turns.at(-1).state!=='routing'},'settled request '+n);
  }
  const c=(await readView(s)).chat;assert(c.turns.length<=50);assert(!c.turns.some(t=>t.text.includes(initial+'0 about')));
  assert(!JSON.stringify(c).includes('PRIVATE_ACCOUNT_FIELD'));
  const el=await p.waitForSelector('[role=log]');
  const scroll=await el.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));return {height:el.clientHeight,full:el.scrollHeight}});
  assert(scroll.full>scroll.height);
  await submit(p,'Another public topic while reading earlier messages.');
  await until(()=>p.evaluate(()=>[...document.querySelectorAll('button')].some(e=>e.checkVisibility()&&/latest|new messages/i.test(e.innerText))),'jump to latest without forced scroll');
  assert((await el.evaluate(e=>e.scrollTop))<16);await shot(s,r,'reading-older');
  const jump=await p.$$('button');for(const x of jump){if(await x.evaluate(e=>e.checkVisibility()&&/latest|new messages/i.test(e.innerText))){await x.click();break;}}
  await submit(p,'A'.repeat(241));
  assert.equal(await p.$eval(composer,e=>e.value.length),241);assert(await p.$eval('button[type=submit]',e=>e.disabled));
  const stored=await p.evaluate(async()=>{const t=(await chrome.tabs.query({active:true,currentWindow:true}))[0];return chrome.storage.session.get('task:'+t.id)});
  assert(!JSON.stringify(stored).includes('PRIVATE_ACCOUNT_FIELD'));
  record(r,'S8-U04 S8-S05','Actual transcript pruned older turns after 28 entered requests, exposed Jump to latest while reading from the top, kept the composer reachable, and displayed an overlength request without truncation. Trusted saved state excluded the private page marker.');
}
async function cleanup(s,r){
  const p=s.panel;
  const secret=await s.page.$eval('#private',e=>e.value);
  await actFeature(p,'page_cleanup');
  await until(async()=>{const c=(await readView(s)).cleanup;return c&&!c.enabled&&c.items.length>0},'cleanup preview');
  assert.equal((await readView(s)).cleanup.hidden,0);await shot(s,r,'preview');
  await button(p,'Apply cleanup').click();await until(async()=>(await readView(s)).cleanup?.hidden>0,'explicit apply');
  assert(!(await s.page.$eval('#ad',e=>e.checkVisibility())));
  await clearConversation(p);
  await until(async()=>(await readView(s)).cleanup?.hidden>0,'preserved cleanup after new chat');
  await button(p,'Restore page').click();
  await until(()=>s.page.$eval('#ad',e=>e.checkVisibility()),'restored advertisement');
  assert.equal(await s.page.$eval('#private',e=>e.value),secret);
  await shot(s,r,'restored');
  record(r,'S8-A01 S8-A03 S8-F05 S8-S06','Preview made no page changes. Explicit Apply hid the eligible ad. Clearing chat retained cleanup ownership, the direct Restore restored the ad, and the current form value survived.');
}
async function nav(s,r){
  const p=s.panel, download=/^(vlc|zip)/.test(r.name),vlc=r.name.startsWith('vlc'),auto=r.name.endsWith('Auto');
  const goal=download?(vlc?'Help me find the Windows VLC download.':'Help me find the right Windows x64 7-Zip download.'):'Find my username settings';
  await submit(p,goal);
  if(vlc){const choice=await p.waitForSelector('button::-p-text(Windows x64 EXE)',{timeout:7000});await choice.click();}
  const start=await until(async()=>{const t=(await readView(s)).task;return t?.state==='awaiting_confirmation'&&t},'scoped goal');
  assert.equal(start.goal,goal);assert(!start.adaptive.authorized);assert.equal(s.page.url(),r.start);
  if(auto){
    await button(p,'Take me there').click();assert(!(await readView(s)).task.adaptive.authorized);
    await shot(s,r,'awaiting-start');await button(p,'Start automatic').click();
  }else await button(p,'Show me').click();
  let last='';
  const end=await until(async()=>{
    const v=await readView(s),t=v.task;if(!t)return false;
    if(t.state==='completed')return v;
    if(['paused','failed','cancelled'].includes(t.state))throw Error(t.adaptive?.status??t.state);
    if(!auto&&t.state==='showing_step'&&last!==t.revision){
      const handle=await s.page.evaluateHandle(()=>{
        const ring=document.querySelector('[data-safestep-outline]')?.getBoundingClientRect();if(!ring)return null;
        return [...document.querySelectorAll('a[href]')].find(e=>{const b=e.getBoundingClientRect();return b.width&&Math.abs(b.left-ring.left-3)<3&&Math.abs(b.top-ring.top-3)<3;})??null;
      });
      const link=handle.asElement();if(link){const href=await link.evaluate(e=>e.href);assert(!/\.(exe|dmg|zip|msi)(?:$|[?#])/i.test(href));last=t.revision;r.guideClicks.push(new URL(href).pathname);await link.click();}
    }
    return false;
  },'verified goal destination',40000);
  let selected;
  if(download){assert(end.review?.selected&&end.review.binding.taskId===end.task.id);selected=end.review.candidates.find(c=>c.ref===end.review.selected);assert(selected);assert(await s.page.$('[data-safestep-outline]'));assert.equal(end.review.selection.profile,vlc?'vlc_windows_x64':'seven_zip_windows_x64_exe');}
  else{assert.equal(new URL(s.page.url()).pathname,'/settings-lab/username');assert.match(await s.page.$eval('h1',e=>e.textContent),/Username/);}
  assert.equal(end.task.adaptive.authorized,false);if(auto)assert.equal(r.guideClicks.length,0);
  r.destination={path:new URL(s.page.url()).pathname,steps:end.task.steps,selected:selected?.reason??null,profile:end.review?.selection.profile??null};
  await shot(s,r,'complete');await shot(s,r,'complete',true);
  record(r,download?'S8-F01 S8-A01':'S8-A01 S8-S01',auto?'Explicit start led to a verified destination through SafeStep with zero website clicks by the driver.':'The driver followed only an actual current highlighted link in Show me mode; SafeStep verified the destination.');
}
async function shopping(s,r){
  const p=s.panel;
  const kinds=r.name==='shopping'?['seller','product']:[r.name];
  for(const k of kinds){
    await actFeature(p,k==='seller'?'seller_assessment':'product_assessment');
    const card=await until(async()=>(await readView(s)).shopping?.[k]?.data,k+' source evidence');
    assert(card.binding.operationId);assert(card.context);assert(card.scope);assert(!JSON.stringify(card).includes('PRIVATE_SHOP_TOKEN'));
    const article=await visible(p,'article[aria-label="'+(k==='seller'?'Seller':'Product')+' assessment"]');
    assert(article);r.sourceEvidence??={};r.sourceEvidence[k]={status:card.status,scope:card.scope,source:card.context.source??null,count:card.records.length};
    await shot(s,r,k+'-card');
  }
  record(r,'S8-F03 S8-U06','Separate source-attributed shopping cards displayed the bound subject, scope and source counts. Known buttons invoked the local tool.');
}
async function trust(s,r){
  await actFeature(s.panel,'site_trust');
  const t=await until(async()=>(await readView(s)).review,'website evidence');
  assert.equal(t.selection.kind,'website');assert(t.status);assert(t.observations);
  await shot(s,r,'website');record(r,'S8-F02','Local website evidence retained source and current host in its conversation card.');
}
async function amazonBoundary(s,r){
  const p=s.panel;await actFeature(p,'seller_assessment');
  const turn=await until(async()=>{const t=(await readView(s)).chat?.turns.at(-1);return t?.state==='unavailable'&&t},'exact Amazon seller source unavailable');
  assert.match(turn.text,/Amazon.*seller-service feedback is unavailable/i);
  assert(!(await readView(s)).shopping?.seller?.data);
  await submit(p,'Check this expected Amazon address: https://amazon.io/');
  const answer=await until(async()=>{const t=(await readView(s)).chat?.turns.at(-1);return t?.feature==='url_identity'&&t.state==='completed'&&t},'local pasted address');
  assert.match(answer.text,/does not match/);assert.equal(s.page.url(),r.start);
  await shot(s,r,'partial-source');
  record(r,'S8-R03 S8-F02','On an intercepted labelled Amazon origin, the card distinguished missing seller-service access from the separate pasted-address mismatch. No live Amazon seller or product data was requested.');
}
async function compare(s,r){
  const p=s.panel;await actFeature(p,'shopping_alternatives');
  const ready=await until(async()=>(await readView(s)).comparison,'actual comparison baseline');
  assert(ready.baseline);await button(p,'Find options').click();
  const v=await until(async()=>{const c=(await readView(s)).comparison;return c&&['ready','partial','no_matches'].includes(c.status)&&c},'bounded comparison results');
  assert(v.baseline);r.compare={status:v.status,baseline:v.baseline.id,candidates:v.candidates.map(x=>x.offer.id)};
  await shot(s,r,'results');record(r,'S8-F04 S8-U06','Direct request opened the existing settings/baseline, explicitly searched and displayed the resulting candidates and cost evidence.');
}
async function isolation(s,r){
  const p=s.panel;await actFeature(p,'site_trust');
  const first=await until(async()=>(await readView(s)).review,'initial current card');
  await s.page.goto(base+'/cleanup-lab');await s.page.bringToFront();
  await until(async()=>!(await readView(s)).review,'retired earlier review after new document');
  await shot(s,r,'new-document');
  assert(!(await readView(s)).review);r.oldOperation=first.binding.operationId;
  const other=await s.browser.newPage();await other.goto(base+'/settings-lab/account');await other.bringToFront();await s.activate(other);
  await until(async()=>!(await readView(s)).review,'tab partition');await other.close();await s.page.bringToFront();
  record(r,'S8-A02 S8-A04','A real document change and second tab retired the original current review without replay.');
}
const runAt=new Date().toISOString();
const save=()=>writeFile(join(out,'run-'+groups.join('-')+'-'+(process.env.SAFESTEP_WIDTH??'both')+'.json'),JSON.stringify({role:'builder',sha256,bundle,runAt,provider:'No live Gemini',results},null,2)+'\n');
try{
  for(const w of [1440,1366]){
    if(process.env.SAFESTEP_WIDTH&&Number(process.env.SAFESTEP_WIDTH)!==w)continue;
    for(const name of groups){
      const r={name,width:w,status:'fail',start:urls[name],caseChecks:{},screens:[],guideClicks:[],fileAttempts:[],downloads:0};let s,service;
      try{
        if(name==='arrival')service=await merchantService();
        s=await nativeSession(bundle,w,w===1440?900:768,r.start,{...(service?{apiHost:'127.0.0.8'}:{}),prepare:async page=>{
          await page.setRequestInterception(true);
          page.on('request',req=>{const u=new URL(req.url());if(name==='amazonBoundary'&&u.origin==='https://www.amazon.com'){if(req.isNavigationRequest())void req.respond({status:200,contentType:'text/html',body:'<main><h1>Labelled SafeStep marketplace fixture</h1></main>'});else void req.abort().catch(()=>{});return;}if(/\.(exe|msi|dmg|zip|7z|whl)$/i.test(u.pathname)||u.hostname==='generativelanguage.googleapis.com'){r.fileAttempts.push(u.hostname+u.pathname);void req.abort().catch(()=>{});}else void req.continue().catch(()=>{});});
        }});
        r.dimensions=s.dimensions;r.chrome=await s.browser.version();
        const loaded=(await s.root.send('Extensions.getExtensions')).extensions.find(x=>x.id===s.id);assert(loaded?.enabled&&resolve(loaded.path)===bundle);r.loaded={id:loaded.id,path:loaded.path};
        await s.root.send('Browser.setDownloadBehavior',{behavior:'deny',eventsEnabled:true});s.root.on('Browser.downloadWillBegin',()=>r.downloads++);
        const f={home,offline,history,cleanup,isolation,compare,shopping,seller:shopping,product:shopping,trust,amazonBoundary}[name]??nav;
        if(service)await testArrival(s,r,service,{until,button,shot,readView,record,submit});
        else await f(s,r);
        assert.equal(r.fileAttempts.length,0);assert.equal(r.downloads,0);r.status='pass';
      }catch(err){r.error=String(err.message).slice(0,420);if(s){r.visible=await s.panel.evaluate(()=>document.body.innerText.slice(0,2400)).catch(()=>null);await shot(s,r,'failed').catch(()=>{});}}
      finally{if(s)await s.browser.close();if(service){service.api.closeAllConnections();await new Promise(ok=>service.api.close(ok));}results.push(r);await save();console.log(r.status,name,w,r.error??'');}
    }
  }
}finally{lab.server.close();}
if(!results.length||results.some(r=>r.status!=='pass'))process.exitCode=1;
