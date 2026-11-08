import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { makeApi } from '../../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../../apps/api/dist/gemini.js';

export async function merchantService(){
  const token=newPairToken();
  const api=makeApi(undefined,new GeminiService({},token));
  const traffic=[];
  api.on('request',req=>traffic.push({method:req.method,path:req.url?.split('?')[0]}));
  api.listen(4317,'127.0.0.8');await once(api,'listening');
  return {token,api,traffic};
}
export async function testArrival(s,r,service,{until,button,shot,readView,record,submit}){
  const p=s.panel;
  await button(p,'Settings').click();
  await p.locator('summary::-p-text(Connect local AI)').click();
  await p.type('input[type=password]',service.token);await button(p,'Connect').click();
  await until(()=>p.evaluate(()=>/Connected[. ]/.test(document.body.innerText)),'paired keyless merchant service');
  const sel=await p.waitForSelector('[aria-label="Auto protection settings"] select');
  assert.equal(await sel.evaluate(e=>e.value),'off');
  await sel.select('all');
  await p.locator('::-p-aria(Look up outside merchant reports[role="checkbox"])').click();
  await button(p,'Apply protection settings').click();
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    resolve('tests/support/permission.ps1'),'-BrowserProcessId',String(s.browser.process().pid),'-Choice','Allow'],{windowsHide:true,timeout:15000});
  await until(async()=>(await readView(s)).prefs.protection?.scope==='all','explicit Chrome site grant');
  assert.equal(service.traffic.filter(x=>x.path==='/v1/merchant/check').length,0,'private setup URL not submitted');
  await p.evaluate(async()=>{const w=await chrome.windows.getCurrent();await chrome.sidePanel.close({windowId:w.id})}).catch(()=>{});
  await until(async()=>!(await s.root.send('Target.getTargets',{filter:[{}]})).targetInfos.some(t=>t.url.endsWith(s.id+'/sidepanel.html')),'closed native panel');
  await s.page.goto('https://www.wayfair.com/terms',{waitUntil:'domcontentloaded',timeout:30000});
  await s.page.waitForSelector('[data-safestep-protection]',{timeout:45000});
  await shot(s,r,'closed-panel-page-warning',true);
  await s.page.bringToFront();await s.activate(s.page);
  s.panel=await(await s.browser.waitForTarget(t=>t.url()==='chrome-extension://'+s.id+'/sidepanel.html')).asPage();
  await s.panel.waitForSelector('#chat-composer',{visible:true,timeout:15000});
  const current=await until(async()=>{const v=await readView(s);return v.protection?.caution&&v.protection},'current merchant caution');
  assert.equal(current.host,new URL(s.page.url()).hostname);
  assert.equal(current.status,'reports');assert(current.sources.length>1);
  r.merchant={host:current.host,checkedAt:current.checkedAt,status:current.status,sources:current.sources,details:current.details};
  await s.panel.waitForSelector('[aria-label="Current website warning"]',{visible:true,timeout:12000});
  const pinned=await s.panel.evaluate(()=>{
    const log=document.querySelector('[role=log]');
    return [...document.querySelectorAll('aside,section,[role=alert]')].some(e=>!e.contains(log)&&!log.contains(e)&&e.checkVisibility()&&/caution|warning|complaints|reported/i.test(e.innerText));
  });assert(pinned,'actual warning outside transcript');
  for(const [address,finding] of [['https://www.amazon.com/','matches the expected Amazon'],['https://amazon.io/','does not match']]){
    await submit(s.panel,'Check this expected Amazon address: '+address);
    await until(async()=>{const turns=(await readView(s)).chat?.turns??[];return turns.at(-1)?.feature==='url_identity'&&turns.at(-1).text.includes(finding)},'locally verified address '+address);
    assert.equal(new URL(s.page.url()).hostname,current.host);
  }
  await shot(s,r,'pinned-warning');
  await button(s.panel,'Settings').click();await s.panel.locator('summary::-p-text(Reading and conversation)').click();await button(s.panel,'New chat').click();
  await until(async()=>{const v=(await readView(s)).protection;return v?.doc===current.doc&&v.caution&&!v.dismissed},'clear chat retained warning');
  assert(!service.traffic.some(t=>/\/(?:assist|compare|shopping)\/|\/chat\/route|^\/v1\/explain$/.test(t.path)),'zero AI operations');
  r.requests=service.traffic.slice();
  record(r,'S8-U05 S8-S06 S8-F02 S8-L04','The keyless paired API obtained attributed exact-domain Washington regulator reports while the panel was closed. Two pasted Amazon addresses through chat returned separate match and mismatch findings locally. The current warning stayed outside the log and survived clearing chat.');
}
