import {catalogGoal,catalogKinds,catalogOrigin,catalogPrices,catalogSorts,platformSelection,publicCatalogPath,publisherBrowseGoal,
  publicSearchQuery,publicPath,returnToCatalog,safeLabel,samePublicTitle,storeListing,tenantOrigin,wikiCitationPage,wikiCitationSubject,wikiCurrentSection,type PublicRef} from '@safestep/contracts';

type Candidate=Omit<PublicRef,'ref'|'visible'>;
const shown=(el:HTMLElement)=>el.isConnected && el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) &&
  el.getBoundingClientRect().width>0 && !el.closest('[hidden],[inert],[aria-hidden=true],[data-private],[data-account],[aria-modal=true]');
const words=(s:string):string[]=>s.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
const plain=(e:HTMLElement)=>e.innerText.trim().replace(/\s+/g,' ').slice(0,96);
export function catalogSearchForm(){
  if(location.origin!==catalogOrigin || location.pathname!=='/discover')return null;
  const forms=[...document.querySelectorAll<HTMLFormElement>('form[role=search]')].filter(f=>shown(f));
  if(forms.length!==1)return null;
  const f=forms[0]!,e=f.elements.namedItem('q');
  if(f.method.toLowerCase()!=='get' || new URL(f.action).href!==catalogOrigin+'/discover' ||
    f.elements.length!==1 || !(!f.target||f.target==='_self') || !(e instanceof HTMLInputElement) ||
    e.type!=='search' || e.disabled || e.readOnly || !shown(e) ||
    e.getAttribute('aria-label')!=='Search things, stores and sellers')return null;
  return {field:e,form:f};
}
export function catalogSearchPath(goal:string){
  const query=catalogGoal(goal).query;
  if(!query || !safeLabel(query))return null;
  const u=new URL('/discover',catalogOrigin);u.searchParams.set('q',query);return publicCatalogPath(u);
}
function nextCatalogFilter(name:string, value:string){
  const u=new URL(location.href);
  if(!publicCatalogPath(u)||u.pathname!=='/discover')return null;
  if(u.searchParams.get(name)===value)return null;
  u.searchParams.set(name,value);return publicCatalogPath(u);
}
function menuTrigger(el:HTMLButtonElement){
  const id=el.getAttribute('aria-controls');
  return !!id && el.getAttribute('aria-haspopup')==='menu' && el.hasAttribute('aria-expanded') &&
    (!document.getElementById(id) || document.getElementById(id)?.getAttribute('role')==='menu');
}
function catalogItem(e:HTMLAnchorElement){
  const u=new URL(e.href), parts=[...e.children];
  if(!storeListing(u)||e.hasAttribute('download')||e.hasAttribute('onclick')||e.hasAttribute('ping')||
    (e.target && e.target!=='_self') || !e.closest('main') || parts.length!==2 || parts.some(p=>p.localName!=='span'))return null;
  const name=(parts[0] as HTMLElement).innerText?.trim(),price=(parts[1] as HTMLElement).innerText?.trim();
  return name && safeLabel(name) && price && /^\$(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{1,2})?$/.test(price)
    ? {name,url:u,price,amount:Number(price.slice(1).replaceAll(',',''))}:null;
}
export function pilotControl(el:HTMLElement,goal:string): Candidate|null {
  if(location.origin==='https://en.wikipedia.org' && wikiCitationSubject(goal) &&
    el instanceof HTMLInputElement && el.id==='vector-page-tools-dropdown-checkbox' && el.type==='checkbox' &&
    el.getAttribute('role')==='button' && !el.disabled && el.closest('#vector-page-tools-dropdown') &&
    document.querySelectorAll('#vector-page-tools-dropdown-checkbox').length===1){
    const label=document.getElementById('vector-page-tools-dropdown-label');
    if(label instanceof HTMLLabelElement && label.control===el && /^Tools$/i.test(label.innerText.trim()) &&
      label.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}) && label.getBoundingClientRect().width &&
      el.getBoundingClientRect().width && !el.closest('[hidden],[inert],[aria-disabled=true]'))
      return {label:'Tools for this article',role:'button',action:'toggle_known_navigation',path:null,expanded:el.checked};
  }
  if(!shown(el)||el.closest('[disabled],[aria-disabled=true i]'))return null;
  if(tenantOrigin(new URL(location.href)) && returnToCatalog(goal) && el instanceof HTMLAnchorElement &&
    el.href===catalogOrigin+'/discover' && ['Shop','Marketplace'].includes(plain(el)) &&
    !el.hasAttribute('onclick') && !el.hasAttribute('download') && !el.hasAttribute('ping') &&
    (!el.target||el.target==='_self'))
    return {label:plain(el),role:'link',action:'handoff_catalog',path:'/discover',targetOrigin:catalogOrigin};
  if(location.origin!==catalogOrigin || location.pathname!=='/discover' || !publicCatalogPath(new URL(location.href)))return null;
  const request=catalogGoal(goal);
  if(el instanceof HTMLInputElement && request.query && el===catalogSearchForm()?.field){
    const path=catalogSearchPath(goal);
    return path?{label:'Search marketplace for '+request.query,role:'search',action:'submit_public_search',path}:null;
  }
  if(el instanceof HTMLAnchorElement && request.wantsOffer && request.query){
    const item=catalogItem(el);
    if(item && words(request.subject??request.query).every(w=>words(item.name).includes(w)))
      return {label:item.name.slice(0,96),role:'link',action:'handoff_storefront',path:item.url.pathname,targetOrigin:item.url.origin};
  }
  if(!(el instanceof HTMLButtonElement)||el.type!=='button'||el.closest('form')||el.hasAttribute('onclick'))return null;
  const label=plain(el);let path:string|null=null;
  if(el.closest('main') && request.more && label==='Show more things')
    return {label,role:'button',action:'load_catalog_results',path:null};
  if(el.closest('main') && label===request.unavailableControl && !el.getAttribute('aria-haspopup'))
    return {label,role:'button',action:'inspect_catalog_filter',path:null};
  if(el.closest('[role=group][aria-label=Categories]')&&el.hasAttribute('aria-pressed')&&
    el.getAttribute('aria-pressed')!=='true' && request.category===label.toLowerCase() && catalogKinds.includes(request.category))
    path=nextCatalogFilter('category',request.category);
  if(el.matches('[role=menuitemradio][aria-checked=false]') && el.closest('[role=menu]')){
    const menu=el.closest('[role=menu]')!, triggers=[...document.querySelectorAll<HTMLButtonElement>('button[aria-controls]')]
      .filter(b=>b.getAttribute('aria-controls')===menu.id && menuTrigger(b) && shown(b));
    if(triggers.length!==1)return null;
    const sort=catalogSorts[label as keyof typeof catalogSorts];
    if(sort && request.sort===sort && plain(triggers[0]!) in catalogSorts)path=nextCatalogFilter('sort',sort);
    if(label==='Under $25' && request.ceiling===25 && plain(triggers[0]!)==='Price')path=nextCatalogFilter('price',catalogPrices[label]!);
  }
  if(path)return {label,role:'button',action:'apply_catalog_filter',path};
  if(menuTrigger(el)&&((label in catalogSorts && request.sort && catalogSorts[label as keyof typeof catalogSorts]!==request.sort) ||
    (label==='Price'&&request.ceiling===25))) return {label,role:'button',action:'toggle_known_navigation',path:null,expanded:el.getAttribute('aria-expanded')==='true'};
  return null;
}
export function catalogReadings(goal:string){
  if(location.origin!==catalogOrigin || location.pathname!=='/discover' || !publicCatalogPath(new URL(location.href)))return {};
  const g=catalogGoal(goal);
  const items=new Set([...document.querySelectorAll<HTMLAnchorElement>('main a[href]')].slice(0,256)
    .map(catalogItem).filter(x=>!!x).map(x=>x.url.href));
  const msg=g.unavailableControl && g.unavailableControl+' filters are coming soon.';
  const note=msg && [...document.querySelectorAll<HTMLElement>('[role=dialog] h2')].filter(e=>shown(e)&&plain(e)===msg);
  return {catalogItems:items.size,...(note && note.length===1?{catalogNotice:msg as 'Size filters are coming soon.'|'Condition filters are coming soon.'}:{})};
}
export function wikiAmbiguity(goal:string,u:URL) {
  if(u.origin!=='https://en.wikipedia.org' || !u.pathname.startsWith('/wiki/') ||
      !document.querySelector('#disambigbox, #mw-normal-catlinks a[href$="/Category:Disambiguation_pages"]'))return undefined;
  const title=document.querySelector<HTMLElement>('main h1')?.innerText?.trim(),query=publicSearchQuery(goal);
  if(!title || !query || !samePublicTitle(title.replace(/\s*\(disambiguation\)$/i,''),query) || /\bdisambiguation\b/i.test(goal))return undefined;
  const choices=new Set<string>();
  for(const a of [...document.querySelectorAll<HTMLAnchorElement>('main .mw-parser-output li a[href]')].slice(0,160)){
    const name=a.title?.trim() || a.innerText.trim(),target=new URL(a.href);
    if(name && name.length<=90 && safeLabel(name) && target.origin===u.origin && publicPath(target,'wikipedia') &&
      !target.hash && target.pathname!==u.pathname && !/disambiguation/i.test(name) &&
      name.toLowerCase().startsWith(query.toLowerCase()+' ')) choices.add(name);
    if(choices.size===4)break;
  }
  return [...choices];
}
export function pilotCompletion(goal:string,u:URL, visible:(e:HTMLElement)=>boolean):string|null {
  const matchingHeading=(selector:string,name:string)=> {
    const nodes=[...document.querySelectorAll<HTMLElement>(selector)].filter(e=>samePublicTitle(plain(e),name));
    return nodes.length===1 && visible(nodes[0]!);
  };
  if(u.origin==='https://en.wikipedia.org'){
    const subject=wikiCitationSubject(goal),page=wikiCitationPage(u);
    if(subject && page && samePublicTitle(subject,page.replaceAll('_',' ')) && u.hash==='#APA_style'){
      const section=document.querySelector<HTMLElement>('main h3#APA_style');
      const article=[...document.querySelectorAll<HTMLElement>('main h2')].find(e=>e.textContent?.includes('"'+page.replaceAll('_',' ')+'"'));
      if(article && section && visible(section) && /^APA style$/i.test(plain(section)))return page+' · APA style';
    }
    const section=wikiCurrentSection(goal);
    if(section && u.pathname.startsWith('/wiki/') && u.hash && matchingHeading('main h2, main h3',section)){
      const anchor=document.getElementById(decodeURIComponent(u.hash.slice(1)));
      const heading=anchor?.matches('h2,h3')? anchor:anchor?.querySelector('h2,h3');
      if(heading instanceof HTMLElement && samePublicTitle(plain(heading),section) && visible(heading))
        return (document.querySelector('main h1')?.textContent?.trim()??'Current article')+' · '+section;
    }
  }
  if(u.origin==='https://www.videolan.org'){
    const goalKind=publisherBrowseGoal(goal);
    if(goalKind==='formats' && u.pathname==='/vlc/download-windows.html'){
      const formats=new Set<string>();
      for(const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')){
        const d=new URL(a.href);const m=/^\/vlc\/([\d.]+)\/win64\/vlc-([\d.]+)-win64\.(exe|7z|msi|zip)$/i.exec(d.pathname);
        if(d.origin==='https://get.videolan.org' && !d.search && !d.hash && m && m[1]===m[2] && a.textContent?.trim())formats.add(m[3]!.toUpperCase());
      }
      if(formats.size && [...document.querySelectorAll<HTMLElement>('h1,h2')].some(h=>visible(h)&&/VLC.*Windows/i.test(plain(h))))
        return 'Windows 64-bit formats observed on VideoLAN: '+[...formats].join(', ')+'. You choose whether to download.';
    }
    if(goalKind==='release' && /^\/vlc\/releases\/(\d+(?:\.\d+){1,3})\.html$/.test(u.pathname)){
      const version=u.pathname.split('/').at(-1)!.replace(/\.html$/,'');
      const needed=/\b\d+(?:\.\d+){1,3}\b/.exec(goal)?.[0];
      const h=[...document.querySelectorAll<HTMLElement>('h1,h2')].find(e=>visible(e)&&plain(e).includes(version));
      if(h && (!needed||needed===version))return 'VideoLAN release information · '+plain(h);
    }
    if(goalKind==='platform' && u.pathname==='/vlc/download-'+platformSelection(goal)+'.html'){
      const h=[...document.querySelectorAll<HTMLElement>('h1,h2')].find(e=>visible(e)&&/\bVLC\b/i.test(plain(e)));
      if(h)return 'Publisher platform information · '+plain(h);
    }
    const route=goalKind && {faq:'/support/faq.html',support:'/support/',features:'/vlc/features.html',security:'/security/',news:'/news.html',formats:'',release:'',platform:''}[goalKind];
    if(route && u.pathname===route){
      const h=[...document.querySelectorAll<HTMLElement>('h1,h2')].find(e=>visible(e)&&
        (goalKind==='faq'?/FAQ|frequently asked/i.test(plain(e)):plain(e).toLowerCase().includes(goalKind!)));
      if(h)return plain(h);
    }
  }
  if(u.origin===catalogOrigin && u.pathname==='/discover' && publicCatalogPath(u)){
    const goalData=catalogGoal(goal),h=document.querySelector<HTMLElement>('main h1');
    if(goalData.unknownBudget||goalData.more||goalData.unavailableControl)return null;
    if(goalData.query && !goalData.wantsOffer && u.searchParams.get('q')===goalData.query &&
      h && visible(h) && h.innerText.includes(goalData.query))return h.innerText.slice(0,120);
    if(goalData.category && u.searchParams.get('category')===goalData.category && (!goalData.sort||u.searchParams.get('sort')===goalData.sort) &&
      [...document.querySelectorAll<HTMLElement>('[role=group][aria-label=Categories] button[aria-pressed=true]')].some(b=>plain(b).toLowerCase()===goalData.category) &&
      (!goalData.sort||[...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup=menu]')].some(b=>shown(b)&&catalogSorts[plain(b) as keyof typeof catalogSorts]===goalData.sort))){
      const items=[...document.querySelectorAll<HTMLAnchorElement>('main a[href]')].slice(0,256).map(catalogItem).filter(x=>!!x);
      if(goalData.sort && items.some((x,i)=>i>0 && (goalData.sort==='price-asc'?items[i-1]!.amount>x.amount:items[i-1]!.amount<x.amount)))return null;
      if(goalData.ceiling!==null){
        const hits=items.filter(x=>goalData.inclusive?x.amount<=goalData.ceiling!:x.amount<goalData.ceiling!);
        if(!hits.length)return null;
        return (goalData.category+' · '+(goalData.sort?'sorted by price · ':'')+'under USD '+goalData.ceiling+': '+hits[0]!.name+' ('+hits[0]!.price+' item price; observed subset)').slice(0,160);
      }
      const explicitEmpty=[...document.querySelectorAll<HTMLElement>('main h2, main h3')].some(h=>shown(h)&&/^nothing (?:for|here yet)|^no (?:matching )?(?:results|items|things)/i.test(plain(h)));
      if(!items.length&&!explicitEmpty)return null;
      return (goalData.category+' · '+(goalData.sort??'category selected')+' · '+items.length+' observed listings').slice(0,160);
    }
  }
  return null;
}
