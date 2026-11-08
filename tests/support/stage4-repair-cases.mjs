import assert from 'node:assert/strict';
export function installRepairCases({run,check,data,button,until,base,addon}){
 const original=process.env.SAFESTEP_S4_ORIGINAL==='1';
 return async(w,h)=>{
  await run('SS4-01-06 Mozilla',w,h,addon+'reviews/',async(s,r)=>{
    await s.page.waitForSelector('a[href*="score=1"]');
    const bins=await s.page.$$eval('a[href*="score="]',els=>Object.fromEntries(els.filter(a=>!new URL(a.href).searchParams.has('page')).map(a=>[new URL(a.href).searchParams.get('score'),a.innerText.trim().replaceAll(',','')]).filter(([k,v])=>/^[1-5]$/.test(k)&&/^\d+$/.test(v)&&v!==k).map(([k,v])=>[k,Number(v)])));
    assert.equal(Object.keys(bins).length,5);const all=await check(s.panel,'product');const shown=all.metrics.filter(m=>/^[1-5]-star ratings$/.test(m.label));
    assert.equal(shown.length,original?0:5);for(const m of shown)assert.equal(m.value,bins[m.label[0]]);
    await s.page.click('a[href*="score=1"]');await s.page.waitForFunction(()=>new URL(location.href).searchParams.get('score')==='1');
    const first=await check(s.panel,'product');assert(first.records.length&&first.records.every(x=>x.rating===1));
    const target=s.browser.waitForTarget(t=>t.type()==='page'&&t.url()===first.source,{timeout:10000});
    await s.panel.locator('article[aria-label="Product assessment"] a::-p-text(View source)').click();
    const page=await(await target).asPage();await page.bringToFront();await s.activate(page);const second=await check(s.panel,'product');
    r.checks.push({id:'SS4-01',source:first.source,first:first.filter,reopened:second.filter,scores:[...new Set(second.records.map(x=>x.rating))]});
    r.checks.push({id:'SS4-06',published:bins,shown:shown.map(m=>[m.label,m.value])});assert.equal(second.filter===first.filter,!original);
  });
  await run('SS4-02-03-05 local',w,h,base+'listing',async(s,r)=>{
   for(const k of ['product','seller']){
    await s.page.evaluate(k=>{const root=document.querySelector('#'+k+'-section'),rows=[...root.querySelectorAll('article')];rows.slice(2).forEach(e=>e.remove());rows.forEach((e,i)=>e.querySelector('[data-comment]').textContent=k==='product'?['It isn’t easy to use','It wasn’t easy to use'][i]:['The item wasn’t as described','The book isn’t as described'][i]);root.querySelector(k==='product'?'[data-metric="Written reviews"]':'[data-metric="Positive feedback"]').dataset.value='';},k);
    const d=await check(s.panel,k); const card=await s.panel.$eval('article[aria-label="'+(k==='seller'?'Seller':'Product')+' assessment"]',x=>x.innerText);
    const m=d.metrics.find(x=>x.label===(k==='product'?'Written reviews':'Positive feedback'));
    assert.equal(!!m,original);assert.equal(card.includes('Recurring in 2'),original);r.checks.push({id:'SS4-02/03',kind:k,metric:m??null,recurring:card.includes('Recurring in 2')});
   }
   await button(s.panel,'Show evidence on page').click();await until(()=>s.page.$('[data-safestep-outline]'),'enabled source cue');
   await s.page.$eval('[data-source=seller]',a=>{a.setAttribute('aria-disabled','true');a.tabIndex=-1;a.style.pointerEvents='none';});
   if(!original)await until(async()=>!(await data(s.panel,'seller'))&&!await s.page.$('[data-safestep-outline]'),'disabled cue cleared');
   const fresh=await check(s.panel,'seller');assert.equal(!!fresh.target,original);r.checks.push({id:'SS4-05',disabledStillOffered:!!fresh.target});
  });
  await run('SS4-04 session limit',w,h,base+'listing',async(s,r)=>{
   const sizes=[];
   for(let n=1;n<=4;n++){
    await s.page.select('#scenario','truncated');await s.page.evaluate(n=>{const root=document.querySelector('#product-section');root.dataset.sort='Explicit practice set '+n;root.querySelectorAll('article').forEach((a,i)=>{a.dataset.id='set'+n+'_'+i;a.querySelector('[data-comment]').textContent='Set '+n+' record '+i;});},n);
    const d=await check(s.panel,'product');sizes.push(d.records.length);
   }
   r.checks.push({id:'SS4-04',sizes});assert.deepEqual(sizes,original?[20,20,20,20]:[20,20,20,0]);
  });
 };
}
