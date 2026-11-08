import {articleMatchesQuery,publicSearchQuery,samePublicTitle,type PublicRef,type AssistSnapshot,type Step} from './assist.js';
import {catalogGoal,platformSelection,publisherBrowseGoal,returnToCatalog,wikiCitationPage,wikiCitationSubject,wikiCurrentSection} from './site-navigation.js';
export function pilotCandidates(goal:string,s:AssistSnapshot):PublicRef[]|null {
  const controls=s.controls, headings=s.headings;
  if(s.profile==='wikipedia'){
    const citation=wikiCitationSubject(goal),section=wikiCurrentSection(goal);
    if(section)return [...headings,...controls].filter(c=>samePublicTitle(c.label,section));
    if(citation){
      if(wikiCitationPage(new URL(s.path,'https://en.wikipedia.org')))
        return [...headings,...controls].filter(c=>/^APA(?: style)?$/i.test(c.label)).sort((a,b)=>Number(b.role==='heading')-Number(a.role==='heading'));
      if(articleMatchesQuery(s.path,citation)){
        const linked=controls.filter(c=>c.path && samePublicTitle(wikiCitationPage(new URL(c.path,'https://en.wikipedia.org'))??'',citation));
        return linked.length?linked:controls.filter(c=>c.label==='Tools for this article');
      }
    }
    const query=publicSearchQuery(goal);
    if(!query)return null;
    const matched=controls.filter(c=>c.path&&articleMatchesQuery(c.path,query));
    if(matched.length)return matched;
    if(articleMatchesQuery(s.path,query))return headings.filter(c=>samePublicTitle(c.label,query));
    return controls.filter(c=>c.action==='submit_public_search' || c.label==='Open Wikipedia search');
  }
  if(s.profile==='publisher'){
    const kind=publisherBrowseGoal(goal);
    if(!kind)return null;
    const links=controls.filter(c=>c.action==='activate_readonly_link'&&c.path);
    const match=(pattern:RegExp)=>links.filter(c=>pattern.test(c.path!.split('#')[0]!));
    if(kind==='platform'){
      const target='/vlc/download-'+platformSelection(goal)+'.html';
      return s.path.split('#')[0]===target?headings.filter(h=>/\bVLC\b/i.test(h.label)):links.filter(c=>c.path?.split('#')[0]===target);
    }
    if(kind==='release'){
      const version=/\b\d+(?:\.\d+){1,3}\b/.exec(goal)?.[0];
      const here=/^\/vlc\/releases\/(\d+(?:\.\d+){1,3})\.html/.exec(s.path);
      if(here && (!version||here[1]===version))return headings.filter(h=>h.label.includes(here[1]!));
      const releases=match(/^\/vlc\/releases\/\d+(?:\.\d+){1,3}\.html$/);
      if(version)return releases.filter(c=>c.path==='/vlc/releases/'+version+'.html');
      // Rank only versions actually linked by the current publisher document.
      const ranked=releases.sort((a,b)=>{
        const parts=(c:PublicRef)=>c.path!.split('/').at(-1)!.replace(/\.html$/,'').split('.').map(Number);
        const x=parts(a),y=parts(b);
        for(let n=0;n<Math.max(x.length,y.length);n++)if((x[n]??0)!==(y[n]??0))return (y[n]??0)-(x[n]??0);
        return 0;
      });
      return ranked.length?ranked:match(/^\/news\.html$/);
    }
    const exact=kind==='formats'?match(/\/download-windows\.html$/i):kind==='faq'?match(/\/faq\.html$/i):
      kind==='support'?match(/\/support\/$/):kind==='security'?match(/\/security\/$/):
      kind==='features'?match(/\/features\.html$/):match(/\/news\.html$/);
    if(exact.length)return exact;
    if(kind==='faq')return match(/\/support\/$/);
    if(kind==='formats')return match(/\/vlc\/$/);
    return links;
  }
  if(s.profile==='catalog'){
    const g=catalogGoal(goal), url=new URL(s.path,'https://resell.store');
    if(g.unknownBudget)return [];
    if(url.pathname==='/')return controls.filter(c=>c.path==='/discover').sort((a,b)=>
      Number(b.label==='Marketplace')-Number(a.label==='Marketplace'));
    if(g.unavailableControl)return controls.filter(c=>c.action==='inspect_catalog_filter'&&c.label===g.unavailableControl);
    if(g.more)return controls.filter(c=>c.action==='load_catalog_results');
    if(g.category && url.searchParams.get('category')!==g.category)
      return controls.filter(c=>c.action==='apply_catalog_filter' && c.label.toLowerCase()===g.category);
    if(g.query && url.searchParams.get('q')!==g.query)return controls.filter(c=>c.action==='submit_public_search');
    if(g.ceiling===25 && url.searchParams.get('price')!=='under-25'){
      const choices=controls.filter(c=>c.action==='apply_catalog_filter' && c.label==='Under $25');
      return choices.length?choices:controls.filter(c=>c.action==='toggle_known_navigation' && c.label==='Price');
    }
    if(g.sort && url.searchParams.get('sort')!==g.sort){
      const choices=controls.filter(c=>c.action==='apply_catalog_filter' && c.path && new URL(c.path,url).searchParams.get('sort')===g.sort);
      return choices.length?choices:controls.filter(c=>c.action==='toggle_known_navigation' && /price|newest|best match/i.test(c.label));
    }
    if(g.wantsOffer)return controls.filter(c=>c.action==='handoff_storefront');
    if(g.query && url.searchParams.get('q')===g.query)
      return headings.filter(h=>samePublicTitle(h.label,'Results for '+g.query));
    return [];
  }
  if(s.profile==='storefront'&&returnToCatalog(goal))
    return controls.filter(c=>c.action==='handoff_catalog');
  return null;
}

// A framework can commit the catalog URL while its visible controls still
// describe the previous query. Wait for goal-relevant controls before asking
// for a proposal. An actually observed empty result can stop without a click.
export function catalogReadyForPlan(goal:string,s:AssistSnapshot){
  const url=new URL(s.path,'https://resell.store'),g=catalogGoal(goal);
  if(s.complete||s.catalogNotice)return true;
  if(url.pathname!=='/discover')return s.controls.some(c=>c.path==='/discover');
  if(g.query && url.searchParams.get('q')===g.query){
    const queryHeading=s.headings.some(h=>samePublicTitle(h.label,'Results for '+g.query!));
    const empty=s.headings.some(h=>/^nothing (?:for|here yet)|^no (?:matching )?results/i.test(h.label));
    return queryHeading && (!g.wantsOffer || empty || s.controls.some(c=>c.action==='handoff_storefront'));
  }
  if(g.category && url.searchParams.get('category')===g.category && (!g.sort||url.searchParams.get('sort')===g.sort))
    return s.headings.some(h=>/^nothing (?:for|here yet)|^no (?:matching )?results/i.test(h.label));
  return !!pilotCandidates(goal,s)?.length;
}
export function localPilotStep(goal:string,s:AssistSnapshot):Step {
  const cs=pilotCandidates(goal,s)??[];
  if(!cs.length)return {kind:'cannot_continue',reason:'missing_target'};
  const first=cs[0]!;
  if(cs.some(c=>(c.targetOrigin??'')+(c.path??'')!==(first.targetOrigin??'')+(first.path??'')) &&
      cs.some(c=>c.action==='handoff_storefront'))
    return {kind:'clarify',question:'More than one current listing matches. Which seller and variant do you want?'};
  return {kind:'next_candidate',ref:first.ref,action:first.action,citations:[first.ref]};
}
