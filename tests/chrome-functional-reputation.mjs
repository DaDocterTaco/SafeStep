// Real native panel, isolated loopback server and explicitly synthetic page/provider
// responses. No request goes to Web Risk, Gemini or a malicious website.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { newPairToken,GeminiService } from '../apps/api/dist/gemini.js';

const bundle=resolve(process.argv[2]), {sha256}=await fingerprint(bundle), build='stage-8-'+sha256.slice(0,12);
assert(bundle.endsWith(join(build,'chrome-mv3')));
const out=resolve('docs/evidence',build,'reputation-native',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(out,{recursive:true});
const base='https://developer.mozilla.org', pageURL=base+'/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter';
const pp=(p,name)=>p.locator('::-p-aria('+name+'[role="button"])').setTimeout(7500);
async function until(fn,msg,ms=16000) {
  const end=Date.now()+ms;
  while(Date.now()<end){const value=await fn().catch(()=>null);if(value)return value;await wait(75);}
  throw Error('Timed out: '+msg);
}
const rows=[];
for(const width of [1440,1366]){
  const r={width,checks:[],requests:[],screens:[],status:'failed'}, token=newPairToken();
  const api=makeApi(undefined,new GeminiService({},token),undefined,{
    readiness:()=>({provider:'url_threat',status:'ready',credentialPresent:false}),
    check:async input=>{
      assert([base+'/',pageURL].includes(input.url)); r.requests.push({scope:input.scope,url:input.url});
      const match=input.scope==='root';
      return {...input,source:'Google Web Risk Lookup',checkedAt:new Date().toISOString(),
        categories:match?['SOCIAL_ENGINEERING']:[],expiresAt:match?new Date(Date.now()+120000).toISOString():null,
        status:match?'match':'no_match',reason:null};
    },
  });
  let s;
  try{
    api.listen(4317,'127.0.0.7'); await once(api,'listening');
    s=await nativeSession(bundle,width,width===1440?900:768,base+'/account',{apiHost:'127.0.0.7',prepare:async p=>{
      await p.setRequestInterception(true);
      p.on('request',q=>void(q.isNavigationRequest()?q.respond({status:200,contentType:'text/html',
        body:'<!doctype html><title>SafeStep fixture</title><main><h1>Labelled isolated public page fixture</h1></main>'}):q.abort()).catch(()=>{}));
    }});
    r.chrome=await s.browser.version();r.dimensions=s.dimensions;
    const loaded=(await s.root.send('Extensions.getExtensions')).extensions.find(e=>e.id===s.id);
    assert(loaded?.enabled && resolve(loaded.path)===bundle);r.loaded=loaded.path;
    const state=async()=> (await view(s.panel)).v;
    const shot=async(p,n)=>{const f=width+'-'+n+'.png';await p.screenshot({path:join(out,f)});r.screens.push(f);};
    await pp(s.panel,'Settings').click();
    await s.panel.locator('summary::-p-text(Connect local AI)').click();
    await s.panel.type('input[type=password]',token);
    await pp(s.panel,'Connect').click();
    await until(()=>s.panel.evaluate(()=>/Connected[. ]/.test(document.body.innerText)),'keyless pairing');
    assert.equal(r.requests.length,0);
    const settings='[aria-label="Auto protection settings"]';
    await s.panel.select(settings+' select','selected');
    await s.panel.locator('::-p-aria(Check the homepage with Google Web Risk on arrival[role="checkbox"])').click();
    await pp(s.panel,'Apply protection settings').click();
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      resolve('tests/support/permission.ps1'),'-BrowserProcessId',String(s.browser.process().pid),'-Choice','Allow'],
      {windowsHide:true,timeout:15000}).catch(()=>{ /* selected-site grant can already be present */ });
    await until(async()=>(await state()).prefs.protection?.threatRoot,'explicit threat opt in');
    assert.equal(r.requests.length,0);r.checks.push('No provider calls before opt-in or on private account URL.');
    await s.panel.evaluate(async()=>{const w=await chrome.windows.getCurrent();await chrome.sidePanel.close({windowId:w.id});}).catch(()=>{});
    await until(async()=>!(await s.root.send('Target.getTargets',{filter:[{}]})).targetInfos.some(t=>t.url.endsWith(s.id+'/sidepanel.html')),'panel closed');
    await s.page.goto(pageURL,{waitUntil:'domcontentloaded'});
    await s.page.waitForSelector('[data-safestep-protection]',{timeout:15000});await shot(s.page,'closed-warning');
    assert.deepEqual(r.requests,[{scope:'root',url:base+'/'}]);r.checks.push('Closed panel warned about only the HTTPS homepage.');
    await s.page.bringToFront();await s.activate(s.page);
    s.panel=await(await s.browser.waitForTarget(t=>t.url()==='chrome-extension://'+s.id+'/sidepanel.html')).asPage();
    await s.panel.waitForSelector('#chat-composer');
    await until(()=>s.panel.evaluate(()=>{const w=document.querySelector('[aria-label="Current website warning"]');
      return !!w && !document.querySelector('[role=log]').contains(w) && w.textContent.includes('HTTPS homepage only');}),'current warning outside log');
    await s.panel.type('#chat-composer','Check this website');await s.panel.keyboard.press('Enter');
    await s.panel.locator('summary::-p-text(Request one threat lookup)').click();
    await pp(s.panel,'Check exact page: '+pageURL).click();
    await until(async()=>{const x=(await state()).protection;return x?.threat?.status==='no_match' && x.threatWarnings?.some(w=>w.scope==='root');},'separate page miss and preserved root match');
    await shot(s.panel,'separate-page-and-homepage');
    assert.deepEqual(r.requests[1],{scope:'page',url:pageURL});r.checks.push('Explicit exact-page lookup reached only disclosed public path; page miss did not dismiss the root match.');
    await pp(s.panel,'Check exact page: '+pageURL).click();
    await until(async()=>/budget|limit|quota/i.test((await state()).protection?.threatNotice??''),'shared lookup allowance');
    assert.equal(r.requests.length,2);r.checks.push('Third new check refused by rolling budget before provider call.');
    await s.page.goto(base+'/account',{waitUntil:'domcontentloaded'});
    await until(async()=>(await state()).protection?.status==='private','new private doc');
    assert(!(await s.page.$('[data-safestep-protection]')));assert.equal(r.requests.length,2);
    r.checks.push('Private replacement retired stale warning; no private address sent.');r.status='pass';
  }catch(e){r.error=String(e.message).slice(0,250);}finally{
    if(s)await s.browser.close();api.closeAllConnections();if(api.listening)await new Promise(ok=>api.close(ok));
    rows.push(r);await writeFile(join(out,'results.json'),JSON.stringify({role:'builder',build,sha256,
      coverage:'Installed Chrome and paired API; controlled page, synthetic threat responses. No actual provider or Gemini request.',rows},null,2)+'\n');
    console.log(r.status,width,r.error??'');
  }
}
console.log(out);
if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
