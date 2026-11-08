import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeSession} from './support/native-stage2.mjs';
import {button,until,overlay,verifyCue,currentTarget,dockControl} from './support/design-cues.mjs';
import {fingerprint} from '../scripts/stage1.mjs';
const [id,widthArg='1440',query='Phishing']=process.argv.slice(2),width=Number(widthArg);
const bundle=resolve('artifacts',id,'chrome-mv3'),fp=await fingerprint(bundle);
assert.equal(id,'stage-8-'+fp.sha256.slice(0,12));
const dir=join('docs/evidence',id,'guide',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(dir,{recursive:true});
const log={id,sha256:fp.sha256,query,started:new Date().toISOString(),actions:[],frames:[],status:'running'};
const save=()=>writeFile(join(dir,'results.json'),JSON.stringify(log,null,2)+'\n');
const closed=()=>s.panel.isClosed();
let s,running=false,record,seq=0;
const snap=async(name)=>{
  await s.page.screenshot({path:join(dir,name+'-page.png')});
  if(!closed())await s.panel.screenshot({path:join(dir,name+'-panel.png')});
};
async function capture(){
  while(running){
    const n=String(seq++).padStart(4,'0'),start=Date.now(),hasPanel=!closed();
    try{
      const jobs=[s.page.screenshot({type:'jpeg',quality:80,path:join(dir,'frames',n+'p.jpg')})];
      if(hasPanel) jobs.push(s.panel.screenshot({type:'jpeg',quality:84,path:join(dir,'frames',n+'s.jpg')}));
      await Promise.all(jobs);log.frames.push({n,t:start,panel:hasPanel});
    }catch{}
    await delay(Math.max(1,180-(Date.now()-start)));
  }
}
const cue=async(text,sentence)=>until(async()=>{
  const selector='[data-safestep-outline][data-manual-guide]';
  const words=await s.page.$eval('[data-safestep-instruction]',e=>e.textContent).catch(()=>null);
  if(words!==text || !await s.page.$(selector))return false;
  return closed() || !sentence || await s.panel.$eval('.manual-step [data-testid=assist-state]',e=>e.textContent).catch(()=>null)===sentence;
},text,12000);
try{
  s=await nativeSession(bundle,width,width===1440?900:768,'https://en.wikipedia.org/wiki/Main_Page',
    {requireUsablePanel:true,headless:process.env.SAFESTEP_GUIDE_HEADED!=='1'});
  log.chrome=await s.browser.version();log.dimensions=s.dimensions;log.visibleMode=process.env.SAFESTEP_GUIDE_HEADED==='1'?'headed':'isolated Chrome headless, native side panel';
  if(width===1440 && query==='Phishing'){await mkdir(join(dir,'frames'));running=true;record=capture();}
  const goal=query==='Phishing'?'Find the Phishing article and its APA citation.':'Find the Wikipedia article about '+query+'.';
  await s.panel.type('#chat-composer',goal);await s.panel.keyboard.press('Enter');await button(s.panel,'Show me').click();
  const field='input[type=search]:not([name=fulltext])';
  const selected=()=>s.page.$('[aria-describedby*="safestep-step-"]');
  await until(selected,'first verified target');
  if((await s.page.$eval('[data-safestep-instruction]',e=>e.textContent))==='Open search'){
    await cue('Open search','Open Wikipedia’s search box.');await (await selected()).click();
  }
  const type='Type “'+query+'”',sentence=type+' in Wikipedia’s search box.';
  await cue(type,sentence);await snap('before');log.actions.push('matching before pair');
  const selectedField='input[aria-describedby*="safestep-step-"]';const target=await s.page.$(selectedField);
  await target.click();const beforeURL=s.page.url();await s.page.keyboard.type(query,{delay:110});
  await cue('Press Enter','Press Enter to search for the article.');await snap('typed');
  const c=await overlay(s);verifyCue(c,await currentTarget(s,selectedField));assert(c.hint?.visible);
  assert(await target.evaluate(e=>e===document.activeElement));assert.equal(s.page.url(),beforeURL);
  await s.page.keyboard.press('Backspace');await cue(type,sentence);
  await s.page.keyboard.type(query.slice(-1));await cue('Press Enter','Press Enter to search for the article.');
  await s.page.keyboard.down('Control');await s.page.keyboard.press('a');await s.page.keyboard.up('Control');await s.page.keyboard.press('Backspace');
  await cue(type,sentence);await s.tabSession.send('Input.insertText',{text:query});await cue('Press Enter','Press Enter to search for the article.');
  assert.equal(s.page.url(),beforeURL);log.actions.push('delete/retype and bulk text insertion; URL unchanged until manual submit');
  if(query==='Phishing'){
    await delay(600);await s.page.keyboard.press('Enter');
    await cue('Open Tools','Open Tools on the Phishing article.');await button(s.panel,'Tuck panel').click();
    await until(()=>s.page.$('[data-safestep-dock]'),'tuck');
    await s.page.mouse.wheel({deltaY:530});await delay(500);
    await dockControl(s,'Show step',true);await delay(450);
    const tools=await selected();await tools.click();
    await cue('Choose Cite this page');await delay(500);await snap('tools');await (await selected()).click();
    await until(()=>s.page.url().includes('CiteThisPage'),'citation document');
    await s.page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await delay(650);
    const dock=await overlay(s,'dock');log.citation={url:s.page.url(),dock:!!dock,buttons:dock?.buttons?.filter(b=>b.visible).map(b=>b.name)};
    await snap('citation-offscreen');await save();await dockControl(s,'Show step',true);
    log.citation.apaVisible=await until(()=>s.page.$eval('#APA_style',e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.top<innerHeight;}),'verified APA visible');
    await snap('citation-revealed');log.actions.push('manual Tools and Cite, cross-document dock, Show step revealed APA');
  }else{await button(s.panel,'Pause').click();assert(!await s.page.$('[data-safestep-outline]'));log.actions.push('Pause cleared cue');}
  log.status='pass';
}catch(e){log.status='fail';log.error=String(e.message).slice(0,400);if(s) {log.url=s.page.url();log.panel=closed()?null:await s.panel.evaluate(()=>document.body.innerText).catch(()=>null);await snap('failure').catch(()=>{});}}
finally{running=false;await record;log.finished=new Date().toISOString();await save();await s?.browser.close();console.log(dir,log.status,log.error??'');}
if(log.status!=='pass')process.exitCode=1;
