import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogGoal,catalogReadyForPlan,localPilotStep,pilotCandidates,publicCatalogPath,publicPath,publicSearchQuery,
  storeListing,wikiCitationPage,wikiCitationSubject,wikiCurrentSection,wikiSectionRequest,wikiExportGoal,wikiExportTarget, type AssistSnapshot,type PublicRef} from '@safestep/contracts';
import {AdaptiveNavigation} from '../apps/extension/core/adaptive';
import {Store} from '../apps/extension/core/store';
import {hit} from '../apps/extension/page/assist-reader';
const u=(p:string)=>new URL(p,'https://resell.store');
const ref=(label:string,path:string|null,action:PublicRef['action']='activate_readonly_link'):PublicRef=>({
  ref:crypto.randomUUID(),visible:true,role:action==='apply_catalog_filter'?'button':'link',label,path,action});
const snapshot=(profile:AssistSnapshot['profile'],path:string,controls:PublicRef[]):AssistSnapshot=>
  ({profile,path,controls,headings:[],limited:false,complete:null});

test('registered public templates preserve topic, tool and current-article scope',()=>{
  assert.equal(publicSearchQuery("From the main page find Wikipedia's article about Earth's atmosphere."),"Earth's atmosphere");
  assert.equal(wikiCitationSubject('Find the Phishing article and its APA citation.'),'Phishing');
  assert.equal(wikiCurrentSection('Find References on the current article.'),'References');
  const w=new URL('https://en.wikipedia.org/w/index.php?title=Special:CiteThisPage&page=Phishing&id=1384366720&wpFormIdentifier=titleform#APA_style');
  assert.equal(wikiCitationPage(w),'Phishing');
  assert.equal(publicPath(w,'wikipedia'),w.pathname+w.search+w.hash);
  for(const add of ['&page=Other','&action=edit','&token=private']){
    const bad=new URL(w);bad.hash='';bad.search+=add;assert.equal(publicPath(bad,'wikipedia'),null);
  }
  for(const path of ['/support/faq.html','/support/','/security/','/vlc/features.html','/vlc/download-windows.html'])
    assert.equal(publicPath(new URL(path,'https://www.videolan.org'),'publisher'),path);
  for(const path of ['/support/contact-form.php','/vlc.exe','/security/?session=private'])
    assert.equal(publicPath(new URL(path,'https://www.videolan.org'),'publisher'),null);
});
test('marketplace captures the wanted item and absolute budget rather than a navigation prefix',()=>{
  assert.equal(catalogGoal('From home find fountain pens in the public marketplace.').category,null);
  assert.equal(catalogGoal('From home find fountain pens in the public marketplace.').query,'fountain pens');
  const search=catalogGoal('Open a confirmed current Lamy 2000 extra-fine offer, then check this seller.');
  assert.equal(search.query,'Lamy 2000');assert.equal(search.subject,'Lamy 2000 extra-fine');
  const books=catalogGoal('Show books under USD 200, sorted by lowest price.');
  assert.equal(books.category,'books');assert.equal(books.ceiling,200);assert.equal(books.sort,'price-asc');
  assert(catalogGoal('show books under EUR 200').unknownBudget);
  assert(catalogGoal('Show books below USD 25.').under25);
  assert(!catalogGoal('Show books at most USD 25.').under25);
  const pens=catalogGoal('Find fountain pens under USD 80, sorted by lowest price.');
  assert.equal(pens.query,'fountain pens');assert.equal(pens.ceiling,80);assert.equal(pens.sort,'price-asc');
  const priceButton={...ref('Price',null,'toggle_known_navigation'),role:'button' as const};
  const selection=snapshot('catalog','/discover?category=books',[priceButton]);
  assert.deepEqual(pilotCandidates('Show books under USD 25.',selection),[priceButton]);
  assert.deepEqual(pilotCandidates('Show books at most USD 25.',selection),[]);
  assert.equal(publicCatalogPath(u('/discover?sort=price-asc&category=books')),'/discover?category=books&sort=price-asc');
  for(const path of ['/discover?email=a%40b.org','/discover?sort=buy','/discover?q=pen&q=book','/account','/discover?q=password%20secret'])
    assert.equal(publicCatalogPath(u(path)),null);
});
test('a named Wikipedia section cannot target the same section on another article',()=>{
  const goal='Find References on the Mars article.';
  const heading={...ref('References',null,'reveal_target'),role:'heading' as const};
  const link=ref('Mars','/wiki/Mars'),other=ref('Atmosphere of Mars','/wiki/Atmosphere_of_Mars');
  const current=snapshot('wikipedia','/wiki/Phishing#References',[link,other]);current.headings.push(heading);
  assert.deepEqual(wikiSectionRequest(goal),{section:'References',subject:'Mars',ambiguous:false});
  assert.equal(publicSearchQuery(goal),'Mars');
  assert.deepEqual(pilotCandidates(goal,current),[link]);
  assert.deepEqual(pilotCandidates(goal,{...current,path:'/wiki/Mars'}),[heading]);
  assert.deepEqual(pilotCandidates('Find References on the current article.',current),[heading]);
  const unclear='Find References on the previous article.';
  assert(wikiSectionRequest(unclear)?.ambiguous);assert.equal(publicSearchQuery(unclear),null);
  assert.deepEqual(pilotCandidates(unclear,current),[]);
});
test('Wikipedia export discovery is bound to the current article and never adds an automatic route',()=>{
  const goal='Show me the PDF export for this article.',path='/wiki/Phishing';
  const dest='/w/index.php?title=Special:DownloadAsPdf&page=Phishing&action=show-download-screen';
  const u=new URL(dest,'https://en.wikipedia.org');
  assert(wikiExportGoal(goal));assert(!wikiExportGoal('Send the PDF for this article to someone.'));
  assert(wikiExportTarget(u,path));assert(!wikiExportTarget(u,'/wiki/Other'));
  for(const bad of [u.href+'&token=x',u.href+'&page=Phishing',u.href+'#irrelevant',u.href.replace('show-download-screen','download'),
    u.href.replace('en.wikipedia.org','en.wikipedia.org.example'),u.href.replace('Phishing','Special:Preferences')])
    assert(!wikiExportTarget(new URL(bad),path));
  const pdf=ref('Download this page as a PDF file',dest,'identify_article_export');
  const browse={...pdf,ref:crypto.randomUUID(),action:'activate_readonly_link' as const};
  assert.deepEqual(pilotCandidates(goal,snapshot('wikipedia',path,[browse,pdf])),[pdf]);
  assert.deepEqual(pilotCandidates(goal,snapshot('wikipedia','/wiki/Other',[pdf])),[]);
  assert.equal(publicPath(u,'wikipedia'),null);
});
test('a wrapped text link needs an actual uncovered point in one of its visible line boxes',t=>{
  const globals=globalThis as any;
  const props=['innerWidth','innerHeight','document','getComputedStyle'];
  const original=props.map(key=>Object.getOwnPropertyDescriptor(globals,key));
  t.after(()=>{for(const [i,key] of props.entries()){
    if(original[i])Object.defineProperty(globals,key,original[i]!);else delete globals[key];
  }});
  const target={getClientRects:()=>[{left:90,right:100,top:0,bottom:10},{left:0,right:15,top:10,bottom:20}],
    contains:(node:unknown)=>node===target};
  let covered=false;
  const values=[100,100,{elementFromPoint:(x:number,y:number)=>!covered && ((x>90&&y<10)||(x<15&&y>10))?target:null},()=>({pointerEvents:'auto'})];
  props.forEach((key,i)=>Object.defineProperty(globals,key,{value:values[i],configurable:true}));
  assert(hit(target as unknown as HTMLElement));covered=true;assert(!hit(target as unknown as HTMLElement));
});
test('Wikipedia Tools accepts its bound label or its own hit, and rejects an unrelated overlay or competing control',t=>{
  const rect={left:10,top:10,right:42,bottom:42,width:32,height:32};
  class Input {
    tagName='INPUT';id='vector-page-tools-dropdown-checkbox';type='checkbox';disabled=false;labels:unknown[]=[];
    getBoundingClientRect(){return rect;}
    contains(other:unknown){return other===this;}
  }
  const input=new Input(),text={closest:()=>null},link={closest:()=>link},unrelated={closest:()=>null};
  const label={control:input,checkVisibility:()=>true,getBoundingClientRect:()=>rect,getClientRects:()=>[rect],
    contains:(other:unknown):boolean=>other===label||other===text||other===link,closest:()=>null};
  input.labels=[label];
  let receiver:unknown=input;
  const values={innerWidth:100,innerHeight:100,HTMLInputElement:Input,
    location:{origin:'https://en.wikipedia.org'},document:{elementFromPoint:()=>receiver},
    getComputedStyle:(el:unknown)=>({opacity:el===input?'0':'1',pointerEvents:'auto'})};
  for(const [key,value] of Object.entries(values)){
    const original=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(original)Object.defineProperty(globalThis,key,original);else Reflect.deleteProperty(globalThis,key);});
  }
  const element=input as unknown as HTMLElement;
  assert(hit(element));receiver=text;assert(hit(element));receiver=unrelated;assert(!hit(element));
  receiver=link;assert(!hit(element));receiver=text;input.labels=[label,label];assert(!hit(element));
});
test('only observed scoped candidates can advance a pilot task',()=>{
  const good=ref('Official FAQ','/support/faq.html'),unrelated=ref('Features','/vlc/features.html');
  assert.deepEqual(pilotCandidates('Take me to the VLC FAQ',snapshot('publisher','/',[unrelated,good])),[good]);
  const sort=ref('Price, low to high','/discover?category=books&sort=price-asc','apply_catalog_filter');
  const wrong=ref('Buy now',null,'toggle_known_navigation');
  assert.deepEqual(pilotCandidates('Show books under USD 200 sorted lowest price',snapshot('catalog','/discover?category=books',[sort,wrong])),[sort]);
  const a=ref('Lamy 2000 fine','/pen','handoff_storefront'),b={...a,ref:crypto.randomUUID(),targetOrigin:'https://second.resell.store'};
  a.targetOrigin='https://one.resell.store';
  assert.equal(localPilotStep('Open Lamy 2000 fine',snapshot('catalog','/discover?q=Lamy+2000',[a,b])).kind,'clarify');
  assert(storeListing(new URL('https://nibdrawer.resell.store/lamy-2000-ef')));
  for(const url of ['https://nibdrawer.resell.store/checkout','https://api.resell.store/items','https://nibdrawer.resell.store/pen?token=1','https://resell.store.evil.example/item'])
    assert(!storeListing(new URL(url)));
});
test('a matched destination denies the cue and no action runs after a late preflight',async t=>{
  const store=new Store(),s=store.get(7);
  s.cp.task={adaptive:{origin:'https://www.videolan.org'}} as any;
  let resolve!:()=>void;
  const wait=new Promise<void>(r=>resolve=r);
  const calls:unknown[]=[];
  const nav=new AdaptiveNavigation(store,undefined,async(_s,tab,dest,signal)=>{
    calls.push([tab.id,dest]);await wait;signal.throwIfAborted();return {allow:false,reason:'Known phishing or malware match.'};
  });
  const x=nav as any;
  const run=x.createRun(s);
  run.b={documentId:'current-doc'};
  t.mock.method(x,'active',async()=>({id:7}));t.mock.method(x,'confirmSnapshot',async()=>{});
  const check=x.checkDestination(s,run,ref('FAQ','/support/faq.html'));
  resolve();
  await assert.rejects(check,/Known phishing/);
  assert.deepEqual(calls,[[7,{kind:'navigation',url:'https://www.videolan.org/support/faq.html',documentId:'current-doc'}]]);
  run.abort.abort();
  await assert.rejects(x.checkDestination(s,run,ref('FAQ','/support/faq.html')));
});
test('new catalog URL retains the requested subject while the client fills in search results',()=>{
  const goal='Open the Lamy 2000 extra-fine offer, then check its seller.';
  const current=snapshot('catalog','/discover?q=Lamy+2000',[ref('Home','/discover?category=home','apply_catalog_filter')]);
  current.headings=[{...ref('Shop everything',null),role:'heading',action:'reveal_target'}];
  assert(!catalogReadyForPlan(goal,current));
  current.headings[0]!.label='Results for “Lamy 2000”';
  assert(!catalogReadyForPlan(goal,current));
  const offer=ref('Lamy 2000 fountain pen, extra fine','/pen','handoff_storefront');offer.targetOrigin='https://shop.resell.store';
  current.controls.push(offer);
  assert(catalogReadyForPlan(goal,current));
});
test('pagination, informational filter inspection and publisher pages stay tied to observed controls',()=>{
  const more:PublicRef={...ref('Show more things',null,'load_catalog_results'),role:'button'};
  const size:PublicRef={...ref('Size',null,'inspect_catalog_filter'),role:'button'};
  const list=snapshot('catalog','/discover',[more,size,ref('Follow',null,'toggle_known_navigation')]);
  assert.deepEqual(pilotCandidates('Show more marketplace listings',list),[more]);
  assert.deepEqual(pilotCandidates('Filter the marketplace by size',list),[size]);
  const news=ref('News','/news.html'),release=ref('release page','/vlc/releases/3.0.24.html'),
    last=ref('older release','/vlc/releases/3.0.9.html'),mac=ref('Mac OS X','/vlc/download-macosx.html');
  const pub=snapshot('publisher','/',[last,release,mac,news]);
  assert.equal(pilotCandidates('Find current VLC release notes',pub)?.[0],release);
  assert.deepEqual(pilotCandidates('Find the VLC macOS platform page',pub),[mac]);
  assert.equal(publicPath(new URL('https://www.videolan.org/vlc/releases/3.0.24.html'),'publisher'),release.path);
  assert.equal(publicPath(new URL('https://www.videolan.org/vlc/releases/latest.exe'),'publisher'),null);
  const shop={...ref('Shop','/discover','handoff_catalog'),targetOrigin:'https://resell.store'};
  assert.deepEqual(pilotCandidates('Return to my previous marketplace results',snapshot('storefront','/pen',[shop])),[shop]);
});
