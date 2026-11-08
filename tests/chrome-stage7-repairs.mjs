// Replay SS7-01 without borrowing independent results or contacting a model.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from '../scripts/stage1.mjs';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';

const bundle=resolve(process.env.SAFESTEP_BUNDLE);
const original=process.env.SAFESTEP_REPRO_ORIGINAL==='1';
const trial=process.env.SAFESTEP_REPAIR_TRIAL??'';
assert(!trial||/^[a-z0-9-]+$/.test(trial));
const {sha256}=await fingerprint(bundle);
const out=resolve('docs/evidence/stage-7-'+sha256.slice(0,12),'SS7-01');
await mkdir(out,{recursive:true});
const mdn='https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array';
const wiki='https://en.wikipedia.org/wiki/Phishing';
const goals=[
  ['excludedCitation','Find the Array.map examples on MDN and skip the citation section.'],
  ['elementName','Help me find the HTML cite element on MDN.'],
  ['ordinaryControl','Find the Array.map examples on MDN and skip the footnotes.'],
  ['sensitiveControl','Change my password.'],
];
async function input(p,text){
  await p.$eval('#goal',e=>e.select());
  await p.keyboard.type(text);await p.keyboard.press('Enter');
}
async function settled(s,text){
  const end=Date.now()+8500;
  while(Date.now()<end){
    const field=await s.panel.$eval('#goal',e=>e.value);
    const v=(await view(s.panel)).v;
    const feedback=await s.panel.$eval('[aria-label="Guided task"]',e=>e.querySelector('p[role="status"]')?.textContent??'');
    if(field===text&&(feedback||v.task?.goal===text&&v.task.state!=='planning'))return {field,feedback,task:v.task?{goal:v.task.goal,state:v.task.state,status:v.task.adaptive?.status}:null};
    await delay(60);
  }
  throw Error('Native result did not settle for '+text);
}
const results=[];
for(const width of [1440,1366]){
  if(process.env.SAFESTEP_WIDTH&&Number(process.env.SAFESTEP_WIDTH)!==width)continue;
  const row={width,status:'fail',goals:[],screens:[],modelRequests:0};let s;
  try{
    s=await nativeSession(bundle,width,width===1440?900:768,mdn,{attachWorker:true});
    row.dimensions=s.dimensions;row.chrome=await s.browser.version();
    const info=(await s.root.send('Extensions.getExtensions')).extensions.find(x=>x.id===s.id);
    assert(info?.enabled&&resolve(info.path)===bundle);
    const worker=await s.browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().includes(s.id));
    const client=await worker.createCDPSession();await client.send('Network.enable');
    client.on('Network.requestWillBeSent',e=>{const u=new URL(e.request.url);if(u.hostname==='generativelanguage.googleapis.com'||e.request.method==='POST'&&/^\/v1\/(?:assist|compare)\/(?:intent|step)$/.test(u.pathname))row.modelRequests++});
    for(const [id,text] of goals){
      await input(s.panel,text);const actual=await settled(s,text);row.goals.push({id,...actual});
      assert.equal(actual.field,text);assert.equal(s.page.url(),mdn);
      if(original&&['excludedCitation','elementName'].includes(id)){assert(actual.feedback.includes('two tasks'));assert.equal(actual.task,null);}
      else if(id==='sensitiveControl'){assert.match(actual.feedback,/password/i);assert.notEqual(actual.task?.goal,text);}
      else{assert.equal(actual.task?.goal,text);assert.equal(actual.task?.state,'paused');assert.match(actual.task.status,/connect|unavailable|local.*service/i);}
      const screen=[id,width,trial].filter(Boolean).join('-')+'.png';await s.panel.screenshot({path:join(out,screen)});row.screens.push(screen);
    }
    await s.browser.close();s=null;
    s=await nativeSession(bundle,width,width===1440?900:768,wiki);
    const picker=s.panel.locator('::-p-aria(Choose a supported task[role="button"])');
    const selected=await s.panel.$('::-p-aria(Wikipedia · APA citation[role="button"])');
    if(!selected)await picker.click();
    await s.panel.locator('::-p-aria(Wikipedia · APA citation[role="button"])').click();
    await s.panel.waitForFunction(()=>/Tools|Cite this page/i.test(document.querySelector('[data-testid=instruction]')?.innerText??''));
    assert.equal((await view(s.panel)).v.task.guide.workflow,'wikipedia_cite_apa');
    assert.equal(row.modelRequests,0);
    row.picker='Current Phishing article, explicit Wikipedia APA picker, live initial citation step: '+await s.panel.$eval('[data-testid=instruction]',e=>e.innerText);
    row.status=original?'reproduced':'pass';
  }catch(e){row.error=String(e.message??e).slice(0,450);if(s)row.diagnostic=await s.panel.evaluate(()=>document.body.innerText.slice(0,1200)).catch(()=>null);}
  finally{if(s)await s.browser.close();results.push(row);const file=[original?'original':'verified',trial].filter(Boolean).join('-')+'.json';await writeFile(join(out,file),JSON.stringify({role:'builder',stage:7,issue:'SS7-01',at:new Date().toISOString(),bundle,sha256,results},null,2)+'\n');console.log(width,row.status,row.error??'');}
}
if(results.some(x=>x.status==='fail')) process.exitCode=1;
