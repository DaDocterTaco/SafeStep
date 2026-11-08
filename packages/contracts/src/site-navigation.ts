// Typed public page templates. These policies describe the sites' controls,
// never a destination returned by a model or a route chosen for a test prompt.
const publicWords = /^[\p{L}\p{N}][\p{L}\p{N} .'’(),_-]{0,84}$/u;
export function wikiCitationSubject(goal:string):string|null {
  if(!/\bAPA\b/i.test(goal))return null;
  const g=goal.replace(/[.!?]+$/,'').trim();
  const m=/\b(?:citation|APA)(?: citation)?\s+(?:for|of)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N} .'’(),_-]+?)(?:\s+(?:Wikipedia\s+)?article)?$/iu.exec(g)
    ?? /\b(?:find|open|locate|to)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N} .'’(),_-]+?)\s+(?:Wikipedia\s+)?article\s+(?:and|then)\b/iu.exec(g)
    ?? /\b(?:article|page) (?:about|on|for)\s+(.+?)\s+(?:and|then).+\bAPA\b/i.exec(g);
  const t=m?.[1]?.trim();
  return t && publicWords.test(t) && !/^(?:this|current|the current)$/i.test(t)?t:null;
}
export function wikiSectionRequest(goal:string) {
  const m=/\b(?:find|show|reveal|locate|open|to)\s+(?:me\s+)?(?:the\s+)?([\p{L}][\p{L} '’-]{0,55}?)(?:\s+section)?\s+(?:on|of|in)\s+(?:this|the current|the)\s+(?:(.{1,85}?)\s+)?(?:article|page)[.!?]*$/iu.exec(goal.trim());
  if(!m)return null;
  const subject=m[2]?.replace(/\s+Wikipedia$/i,'').trim()??null;
  if(subject && !publicWords.test(subject))return null;
  return {section:m[1]!.trim(),subject:subject&&subject.toLowerCase()!=='wikipedia'?subject:null,
    ambiguous:!!subject && (/^(?:other|previous|last|earlier|different|first|second|that|same)\b/i.test(subject) || /\sor\s/i.test(subject))};
}
export function wikiCurrentSection(goal:string) {
  return wikiSectionRequest(goal)?.section??null;
}
// Identify only the export control for the current public article. The link is
// a manual handoff even when the user selected automatic navigation.
export function wikiExportGoal(goal:string) {
  return /\b(?:pdf|export)\b/i.test(goal) && /\b(?:this|current)\s+(?:Wikipedia\s+)?(?:article|page)\b/i.test(goal) &&
    !/\b(?:not|never|instead|except|upload|email|send|save as|print|edit)\b/i.test(goal);
}
export function wikiExportTarget(raw:URL,articlePath:string) {
  if(raw.origin!=='https://en.wikipedia.org' || raw.username || raw.password || raw.hash || raw.pathname!=='/w/index.php' ||
    !articlePath.startsWith('/wiki/') || /[?#]/.test(articlePath))return false;
  const q=raw.searchParams,page=q.get('page');
  if(q.size!==3 || q.get('title')!=='Special:DownloadAsPdf' || q.get('action')!=='show-download-screen' ||
     !page || !publicWords.test(page) || /[\w-]{28}/.test(page))return false;
  try{return decodeURIComponent(articlePath.slice(6)).replaceAll('_',' ')===page.replaceAll('_',' ');}
  catch{return false;}
}
export function wikiCitationPage(u:URL) {
  if(u.origin!=='https://en.wikipedia.org'||u.username||u.password||u.pathname!=='/w/index.php'||
    (u.hash && u.hash!=='#APA_style'))return null;
  const keys=[...u.searchParams.keys()];
  if(new Set(keys).size!==keys.length || keys.some(k=>!['title','page','id','wpFormIdentifier'].includes(k)) ||
    u.searchParams.get('title')!=='Special:CiteThisPage' ||
    (u.searchParams.has('id')&&!/^\d{1,12}$/.test(u.searchParams.get('id')!)) ||
    (u.searchParams.has('wpFormIdentifier')&&u.searchParams.get('wpFormIdentifier')!=='titleform'))return null;
  const page=u.searchParams.get('page');
  return page && publicWords.test(page) && !/[\w-]{28}/.test(page)?page:null;
}
export function publisherBrowseGoal(g:string) {
  if(/\b(?:formats?|options|packages)\b/i.test(g) && /\b(?:Windows|win64)\b/i.test(g) &&
     !/\b(?:install|activate)\b/i.test(g))return 'formats';
  if(/\bFAQ\b/i.test(g))return 'faq';
  if(/\b(?:support|help center)\b/i.test(g))return 'support';
  if(/\b(?:security|advisories)\b/i.test(g))return 'security';
  if(/\bfeatures?\b/i.test(g))return 'features';
  if(/\bnews\b/i.test(g))return 'news';
  if(/\b(?:release(?:s| notes)?|changelog)\b/i.test(g))return 'release';
  if(platformSelection(g) && /\b(?:page|information|platform|options|formats?|browse)\b/i.test(g))return 'platform';
  return null;
}
export function platformSelection(g:string) {
  const platforms=[[/\b(?:macos|mac os x|mac)\b/i,'macosx'],[/\bubuntu\b/i,'ubuntu'],
    [/\bandroid\b/i,'android'],[/\bios\b/i,'ios'],[/\bwindows\b/i,'windows']] as const;
  const matched=platforms.filter(([pattern])=>pattern.test(g));
  return matched.length===1?matched[0]![1]:null;
}
export const catalogOrigin='https://resell.store';
export const catalogKinds=['everything','clothing','shoes','bags','home','collectibles','books','tech','kids','garden'];
export const catalogSorts={'Newest first':'newest','Best match':'relevance','Price, low to high':'price-asc','Price, high to low':'price-desc'} as const;
const prices={'Under $25':'under-25','$25 to $100':'25-100','Over $100':'over-100'};
export const catalogPrices:Readonly<Record<string,string>>=prices;
export function publicCatalogPath(u:URL) {
  if(u.origin!==catalogOrigin || u.username || u.password || u.hash ||
    !['/','/discover'].includes(u.pathname) || (u.pathname==='/'&&u.search))return null;
  const keys=[...u.searchParams.keys()];
  if(new Set(keys).size!==keys.length || keys.length>4)return null;
  for(const [k,v] of u.searchParams){
    if(k==='q' && publicWords.test(v) && !/[\w-]{28,}|\b(?:token|password|private|account|session|email)\b/i.test(v))continue;
    if(k==='category' && catalogKinds.includes(v))continue;
    if(k==='sort' && Object.values(catalogSorts).some(s=>s===v))continue;
    if(k==='price' && Object.values(catalogPrices).includes(v))continue;
    return null;
  }
  // Sort parameter order so two equivalent history entries cannot count twice.
  const sorted=new URLSearchParams(u.search);sorted.sort();
  return u.pathname+(sorted.size?'?'+sorted.toString():'');
}
export function catalogGoal(g:string) {
  const lower=g.replace(/^\s*from (?:the )?(?:home(?:page)?|main page)[,:]?\s*/i,'')
    .split(/\b(?:then|and then|and (?:check|assess|compare))\b/i)[0]!.toLowerCase();
  const category=catalogKinds.find(c=> c!=='everything' && new RegExp('\\b'+c+'\\b').test(lower))??null;
  const ceiling=/\b(?:under|below|less than|at most|up to)\s*(?:USD\s*|\$\s*)(\d{1,6}(?:\.\d{1,2})?)/i.exec(g);
  const sort=/\b(?:lowest|cheapest|low to high)\b/i.test(g)?'price-asc':/\b(?:highest|high to low)\b/i.test(g)?'price-desc':null;
  const publicSubject=g.split(/\b(?:then|and then|and (?:check|assess|compare))\b/i)[0]!;
  const raw=(ceiling?publicSubject.replace(ceiling[0],' '):publicSubject).replace(/\s*,?\s*(?:sorted by |sort by )?(?:lowest|highest) price\b/ig,' ')
    .trim().replace(/[.!?,]+$/,'')
    .replace(/^.*?\b(?:find|search(?: for)?|locate|open|show|browse|compare)\s+(?:me\s+)?/i,'')
    .replace(/^(?:a|an|the)\s+|\b(?:confirmed|current)\s+/gi,'')
    .replace(/\s+(?:in|on|at|from)\s+(?:the |this )?(?:public )?(?:marketplace|catalog|home|resell\b).*$/i,'')
    .replace(/\s+(?:offer|listing)(?:\s+.*)?[.!?]?$/i,'').replace(/[.!?,]+$/,'').trim();
  const allowed=publicWords.test(raw)&&!/[\w-]{28,}|\b(?:token|password|private|session|account|email)\b/i.test(raw);
  const wantsOffer=/\b(?:open|visit|select|check this seller|check its seller)\b/i.test(g);
  const search = wantsOffer?raw.replace(/\s+(?:extra[ -]fine|fine|medium|broad)(?:\s+nib)?$/i,'').trim():raw;
  const unknownBudget=/\b(?:under|below|less than|at most|up to)\s+/i.test(g)&&!ceiling;
  const unavailableControl=/\b(?:condition|used|refurbished|brand new)\b/i.test(g)?'Condition':
    /\b(?:size|sizing)\b/i.test(g)?'Size':null;
  const more=/\b(?:show|load|see|browse|view)\s+(?:me\s+)?(?:some\s+)?more\s+(?:(?:catalog|marketplace|public)\s+)?(?:results|listings|items|things)\b/i.test(g);
  const inclusive=/\b(?:at most|up to)\b/i.test(ceiling?.[0]??'');
  return {category,ceiling:ceiling?Number(ceiling[1]):null,inclusive,under25:!!ceiling && Number(ceiling[1])===25 && !inclusive,
    more,unavailableControl,unknownBudget,sort,subject:allowed?raw:null,query:!category&&allowed&&!more&&!unavailableControl?search:null,wantsOffer};
}
export function tenantOrigin(u:URL){
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port &&
    /^[a-z0-9][a-z0-9-]{0,44}\.resell\.store$/i.test(u.hostname) &&
    !['api','www','admin','files','docs','accounts','account','login','auth','mail','sso','billing','pay','checkout','internal','private'].includes(u.hostname.split('.')[0]!);
}
export function returnToCatalog(goal:string) {
  return /\b(?:return|back|go back|take me back)\b/i.test(goal) && /\b(?:marketplace|catalog|results)\b/i.test(goal);
}
export function storeListing(u:URL) {
  return tenantOrigin(u) && !u.search && !u.hash &&
    /^\/[a-z0-9][a-z0-9-]{0,98}\/?$/.test(u.pathname) &&
    !/[a-z0-9]{28,}/i.test(u.pathname) &&
    !/(?:^|[/-])(?:accounts?|checkout|cart|login|logout|sign-?in|register|follow(?:ing)?|saves?|messages?|offers?|sell(?:ing)?|billing|orders?|buy|pay|payment|tokens?|private|auth|api|settings|admin)(?:[/-]|$)/i.test(u.pathname);
}
