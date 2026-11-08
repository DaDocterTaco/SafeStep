import {
  ExplainHealth,
  Fault,
  MerchantReply,
  MerchantRequest,
  ProtectionView,
  ThreatReply,
  automaticThreatSubject,
  threatFinding,
  threatPageUrl,
  threatRootUrl,
  permittedOrigin,
  protectionOff,
  type ProtectionCommand,
} from '@safestep/contracts';
import type { Store } from './store';
import type { RecordState } from './state';
import { allWeb, pattern, probe, removedOrigin, protectionFile } from './access';
import { protectionAddress } from '../sites/protection';
import { z } from 'zod';
import { protectionRouteToken } from '../page/protection-route';
import { boundedResponseText } from './bounded-response';
import { ThreatLookups, type ThreatDecision } from './threat-lookups';
import type { DestinationPreflight } from './destination-check';

const receiptPrefix = 'auto-check:';
const sessionKey = 'local-ai-session';
const quotaKey = 'auto-check-budget';
const service = 'http://127.0.0.1:4317';
type Current = { id: number; doc: string; raw: string; route: string; view: ProtectionView; controller:AbortController };
type ThreatSubject = { scope: 'root'|'page'; url:string };
type Job = { key:string; host: string; subject?:ThreatSubject; targets: Set<Current>; controller: AbortController };
const threatUrl = (scope:ThreatSubject['scope'],raw:string) => {
  const publicUrl = automaticThreatSubject(raw);
  if (!publicUrl) return null;
  return scope==='root' ? threatRootUrl(publicUrl.url) : publicUrl.scope==='page' ? publicUrl.url : null;
};
const freshMatch = (reply: ThreatReply, now=Date.now()) =>
  reply.status==='match' && !!reply.expiresAt && Date.parse(reply.expiresAt)>now;
const Quota = z.strictObject({
  session: z.string().regex(/^[a-f0-9]{64}$/),
  count: z.number().int().nonnegative(),
  times: z.array(z.number().finite()).max(20),
});

export class Protection {
  private current = new Map<number, Current>();
  private generation = new Map<number, number>();
  private jobs = new Map<string, Job>();
  private tail: Promise<void> = Promise.resolve();
  private cache = new Map<string, MerchantReply>();
  private threatCache = new Map<string, ThreatReply>();
  private readonly threats = new ThreatLookups();
  private targetVersions = new Map<number, number>();
  private targetIsCurrent = new Map<number,()=>boolean>();
  private limited = new Map<number,{ticket:string;owner:Current;epoch:number;task?:string;version?:number;binding:string;kind:string;url:string;approved:boolean;expires:number}>();
  private lastArrival = new Map<number, number>();
  private dismissals = new Map<number, { doc: string; keys: Set<string> }>();
  constructor(
    private store: Store,
    private pause: (s: RecordState, why: string) => Promise<void>,
  ) {}
  private get prefs() {
    return this.store.prefs.protection ?? protectionOff();
  }
  private async allowed(t: chrome.tabs.Tab) {
    const site = permittedOrigin(t.url),
      p = this.prefs;
    if (
      t.incognito ||
      !site ||
      p.scope === 'off' ||
      (p.scope === 'selected' && !p.sites.includes(site))
    )
      return false;
    if (p.scope==='all' && !await chrome.permissions.contains({origins:allWeb})) return false;
    return chrome.permissions.contains({ origins: [pattern(site)] });
  }
  private async bound(c: Current) {
    if (this.current.get(c.id) !== c) return false;
    try {
      const raw=c.raw, t = await chrome.tabs.get(c.id);
      return (
        t.url === c.raw &&
        (await this.allowed(t)) &&
        (await probe(c.id, c.view.origin)) === c.doc &&
        this.current.get(c.id) === c && c.raw===raw && (await chrome.tabs.get(c.id)).url===raw
      );
    } catch {
      return false;
    }
  }
  async isCurrent(tab: chrome.tabs.Tab, view: ProtectionView) {
    const c = this.current.get(tab.id!);
    if (!c || tab.url !== c.raw || c.view.revision !== view.revision || !(await this.bound(c))) return false;
    if(c.view.destination && (!tab.active || !this.targetIsCurrent.get(c.id)?.())){
      this.limited.delete(c.id);
      await this.show(c,v=>({...v,destination:undefined}));
      return false;
    }
    if (this.hasExpired(c.view)) {
      await this.expire(c);
      return false; // The controller will publish the refreshed current receipt.
    }
    return true;
  }
  private hasExpired(view:ProtectionView) {
    return !!(view.expiresAt && Date.parse(view.expiresAt)<=Date.now()) ||
      (view.threat?.status==='match' && !freshMatch(view.threat)) ||
      (view.threatWarnings??[]).some(x=>!freshMatch(x)) ||
      (view.destination?.result?.status==='match' && !freshMatch(view.destination.result));
  }
  private async expire(c:Current) {
    if(c.view.expiresAt && Date.parse(c.view.expiresAt)<=Date.now()) {
      await this.local(c,'unavailable','Previous outside merchant evidence expired. Recheck for current evidence.');
    } else await this.show(c,current=>current);
  }
  private async show(c: Current, update: ProtectionView|((current:ProtectionView)=>ProtectionView), dismiss=false) {
    if (!(await this.bound(c))) return;
    let next = typeof update==='function'?update(c.view):update;
    if(next.destination?.result?.status==='match' && !freshMatch(next.destination.result))next={...next,destination:undefined};
    const matches=(next.threatWarnings??[]).filter(x=>
      freshMatch(x) && threatUrl(x.scope,c.raw)===x.url);
    next={...next,threatWarnings:matches,
      caution:protectionAddress(c.raw).caution || next.status==='reports' || matches.length>0};
    if(next.threat && next.threat.status==='match' && !freshMatch(next.threat)){
      next={...next,threat:undefined,threatNotice:'The previous Google Web Risk match expired. Recheck for current results.'};
    }
    if (next.caution) {
      const key = JSON.stringify([
        next.identity,
        next.status === 'reports'
          ? next.sources
              .slice(1)
              .map((s) => s.url)
              .sort()
          : [],
        matches.map(x=>[x.scope,x.url,[...x.categories].sort()]).sort(),
      ]);
      let saved = this.dismissals.get(c.id);
      if (saved?.doc !== c.doc) {
        saved = { doc: c.doc, keys: new Set() };
        this.dismissals.set(c.id, saved);
      }
      if (dismiss) {
        if (saved.keys.size >= 8) saved.keys.delete(saved.keys.values().next().value!);
        saved.keys.add(key);
      }
      next = { ...next, dismissed: saved.keys.has(key) };
    } else next={...next,dismissed:false};
    c.view = next;
    const s = this.store.get(c.id);
    s.protection = next;
    if (next.caution && !next.dismissed && s.cp.task?.adaptive?.authorized)
      await this.pause(s, 'Website warning. Review Safety checks before continuing.');
    if (this.current.get(c.id) !== c || c.view !== next) return;
    await Promise.all([
      chrome.storage.session.set({ [receiptPrefix + c.id]: next }),
      chrome.action.setBadgeText({
        tabId: c.id,
        text: next.caution
          ? '!'
          : next.status === 'checking'
            ? '…'
            : ['quota', 'unavailable'].includes(next.status)
              ? '?'
              : '·',
      }),
      chrome.action.setBadgeBackgroundColor({
        tabId: c.id,
        color: next.caution ? '#953c11' : '#354a50',
      }),
      chrome.action.setTitle({
        tabId: c.id,
        title: 'SafeStep · ' + next.host + ' · ' + next.outside.slice(0, 120),
      }),
      chrome.tabs
        .sendMessage(
          c.id,
          { channel: 'protection-display', op: 'show', route: c.route, view: next },
          { documentId: c.doc },
        )
        .catch(() => {}),
      chrome.runtime.sendMessage({ channel: 'cue-updated', tabId: c.id }).catch(() => {}),
    ]);
  }
  private stopWork(c: Current) {
    this.targetIsCurrent.delete(c.id);
    this.limited.delete(c.id);
    c.controller.abort();
    for (const job of this.jobs.values())
      if (job.targets.delete(c) && !job.targets.size) {
        job.controller.abort();
        this.jobs.delete(job.key);
      }
  }
  private async clear(id: number) {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    const c = this.current.get(id);
    if (c) {
      this.current.delete(id);
      this.stopWork(c);
    }
    const s = this.store.tabs.get(id);
    if (s) delete s.protection;
    await Promise.all([
      chrome.storage.session.remove(receiptPrefix + id),
      chrome.action.setBadgeText({ tabId: id, text: '' }).catch(() => {}),
      chrome.action.setTitle({ tabId: id, title: 'Open SafeStep' }).catch(() => {}),
      chrome.tabs
        .sendMessage(
          id,
          { channel: 'protection-display', op: 'clear' },
          c ? { documentId: c.doc } : { frameId: 0 },
        )
        .catch(() => {}),
      chrome.runtime.sendMessage({ channel: 'cue-updated', tabId: id }).catch(() => {}),
    ]);
  }
  private async arrive(id: number, doc: string, force = false, restored?: ProtectionView) {
    const at = this.generation.get(id) ?? 0;
    const t = await chrome.tabs.get(id);
    if (!t.url || !(await this.allowed(t)) || (this.generation.get(id)??0) !== at) return;
    const raw = t.url,
      site = permittedOrigin(raw)!;
    if ((await probe(id, site)) !== doc || (this.generation.get(id)??0) !== at) return;
    const [binding] = await chrome.scripting.executeScript({
      target: { tabId: id, documentIds: [doc] },
      func: protectionRouteToken,
    });
    if (!binding?.result || (await chrome.tabs.get(id)).url!==raw || (this.generation.get(id)??0) !== at) return;
    const old = this.current.get(id);
    if (!force && old?.doc === doc && old.raw === raw && old.route===binding.result) {
      await this.show(old, old.view);
      return;
    }
    const a=protectionAddress(raw);
    const pageUrl = threatUrl('page',raw) ?? undefined;
    const homeUrl = threatUrl('root',raw) ?? undefined;
    if(!force && old?.doc===doc && old.view.origin===site && old.view.host===a.host &&
      old.view.identity===a.identity && (old.view.status==='private')===a.privateRoute &&
      (old.view.threatPage===pageUrl || (!this.prefs.threatRoot && !this.prefs.automaticUrlConsent && !old.view.threat && !old.view.threatWarnings?.length && ![...this.jobs.values()].some(job=>job.subject && job.targets.has(old)))) &&
      (!this.prefs.automaticUrlConsent || old.raw.split('#')[0]===raw.split('#')[0]) && (old.view.threatHome===homeUrl || (
        !this.prefs.threatRoot && !old.view.threat && !old.view.threatWarnings?.length &&
        ![...this.jobs.values()].some(j=>j.subject && j.targets.has(old)))) &&
      (!old.view.expiresAt||Date.parse(old.view.expiresAt)>Date.now())){
      // Public SPA navigation can change the page route while the same domain
      // warning is being read. Rebind the route without replacing its controls.
      old.raw=raw;old.route=binding.result;
      await this.show(old,{...old.view,threatHome:homeUrl,threatPage:pageUrl,routeToken:old.route});
      return;
    }
    if(old)this.stopWork(old);
    if (restored?.routeToken !== binding.result) restored = undefined;
    const now = new Date().toISOString();
    const view: ProtectionView = {
      doc,
      routeToken: binding.result,
      origin: site,
      host: a.host,
      revision: crypto.randomUUID(),
      identity: a.identity,
      address: a.address,
      checkedAt: now,
      status: a.privateRoute ? 'private' : 'local',
      outside: a.privateRoute
        ? 'Private or restricted address. Outside sources were not queried.'
        : 'Outside reports are off. Only the current address was checked.',
      sources: [],
      details: [],
      caution: a.caution,
      dismissed: false,
      expiresAt: null,
      threatPage:pageUrl,
      threatHome:homeUrl,
      threatNotice:a.privateRoute?'Private or restricted address. No threat lookup was made.':
        'Known-threat lookup has not been run for this document.',
    };
    // Domain evidence survives public SPA navigation in this document; page
    // results and pending page requests never move to a different path.
    if(old?.doc===doc && old.view.origin===site && !a.privateRoute && !restored){
      if(old.view.expiresAt && Date.parse(old.view.expiresAt)>Date.now() && old.view.status!=='checking') {
        Object.assign(view,{status:old.view.status,outside:old.view.outside,checkedAt:old.view.checkedAt,
          expiresAt:old.view.expiresAt,sources:old.view.sources,details:old.view.details});
      }
      const retain=(x:ThreatReply)=>freshMatch(x) && threatUrl(x.scope,raw)===x.url;
      view.threatWarnings=old.view.threatWarnings?.filter(retain);
      if(old.view.threat && retain(old.view.threat)) view.threat=old.view.threat;
    }
    if (
      restored &&
      restored.doc === doc &&
      restored.origin === site &&
      restored.host === a.host &&
      !a.privateRoute
    ) {
      // Retain document-local dismissal without replaying pending or expired research after restart.
      Object.assign(view, restored, {threatPage:pageUrl,threatHome:homeUrl});
      if (
        restored.status === 'checking' ||
        (restored.expiresAt && Date.parse(restored.expiresAt) <= Date.now())
      ) {
        view.status = 'unavailable';
        view.outside = 'Outside check interrupted or expired. Recheck for current evidence.';
        view.details=[];
        view.sources=[];
        view.expiresAt=null;
      }
      if(view.threat && threatUrl(view.threat.scope,raw)!==view.threat.url){
        delete view.threat;
        view.threatNotice='This address has changed. Recheck its current threat coverage.';
      }
      if(view.threatNotice?.startsWith('Checking Google Web Risk'))
        view.threatNotice='The previous threat lookup was interrupted. Recheck if desired.';
    }
    delete view.destination;
    const c = { id, doc, raw, view, route: binding.result, controller:new AbortController() };
    this.current.set(id, c);
    await this.show(c, view, !!restored?.dismissed);
    if (this.prefs.automaticUrlConsent === 2 && await this.bound(c)) {
      if (!restored || !view.threat || !freshMatch(view.threat)) void this.automaticArrival(c).catch(()=>{});
    }
    if (restored || a.privateRoute || !this.prefs.budget || !(await this.bound(c))) return;
    if (this.prefs.threatRoot && this.prefs.automaticUrlConsent!==2) await this.startThreat(c,'root');
    if (this.prefs.outside) {
      await this.show(c, current=>({...current,
        // Keep known complaint reports visible while the same merchant refreshes.
        status:current.status==='reports'?'reports':'checking',
        outside:'Checking public merchant reports for '+a.host+'.',
      }));
      this.enqueue(c);
    }
  }
  private async startThreat(c:Current,scope:ThreatSubject['scope']){
    if (!(await this.bound(c))) throw new Fault('stale_document');
    const url=threatUrl(scope,c.raw);
    if(!url || (!this.prefs.budget && this.prefs.automaticUrlConsent!==2)){
      await this.show(c,current=>({...current,threatNotice:!this.prefs.budget?
        'Outside lookup budget is zero. No URL was sent.':
        'This URL is outside the public lookup policy. No URL was sent.'}));
      return;
    }
    await this.show(c,current=>({...current,threatNotice:
      'Checking Google Web Risk for the '+(scope==='root'?'homepage only.':'displayed public page.')}));
    if(this.prefs.automaticUrlConsent===2) {
      void this.checkCurrent(c,{scope,url,purpose:'manual'}).catch(()=>{});
    } else this.enqueue(c,{scope,url});
  }
  private async applyThreat(c:Current, result:ThreatDecision) {
    if(!result.reply) {
      await this.threatNotice(c,result.message??'Google Web Risk is unavailable.');
      return;
    }
    const reply=result.reply;
    await this.show(c,current=>{
      const retain=(current.threatWarnings??[]).filter(x=>freshMatch(x) &&
        (x.scope!==reply.scope || x.url!==reply.url || ['unavailable','rate_limited'].includes(reply.status)));
      if(freshMatch(reply)) retain.push(reply);
      return {...current,threat:reply,threatNotice:undefined,threatWarnings:retain};
    });
  }
  private async checkCurrent(c:Current,subject:NonNullable<ReturnType<typeof automaticThreatSubject>>) {
    const allowed=async()=>this.prefs.automaticUrlConsent===2 && await this.bound(c) &&
      threatUrl(subject.scope,c.raw)===subject.url;
    const result=await this.threats.check(subject,c.controller.signal,allowed);
    if(!c.controller.signal.aborted && await allowed()) await this.applyThreat(c,result);
  }
  private async automaticArrival(c:Current) {
    this.lastArrival.set(c.id,Date.now());
    const subject=automaticThreatSubject(c.raw);
    if(!subject) {
      await this.threatNotice(c,'Private or ineligible address. No URL was shared with Google.');
      return;
    }
    await this.show(c,v=>({...v,threatNotice:'Checking Google Web Risk for '+(subject.scope==='root'?'the homepage only.':'the current public page.')}));
    const home=new URL(subject.url).origin+'/';
    if(home!==subject.url && this.threats.hasPositive(home))
      await this.checkCurrent(c,{url:home,scope:'root',purpose:'arrival'});
    await this.checkCurrent(c,subject);
  }
  readonly destination:DestinationPreflight = async (s,tab,target,signal)=>{
    const prefs=this.prefs, site=permittedOrigin(tab.url);
    if(prefs.automaticUrlConsent!==2 || prefs.scope==='off' ||
      (prefs.scope==='selected' && (!site || !prefs.sites.includes(site)))) return {allow:true};
    const id=s.cp.tabId,epoch=s.cp.epoch,task=s.cp.task?.id,version=s.cp.task?.adaptive?.version;
    const request=(this.targetVersions.get(id)??0)+1;
    this.targetVersions.set(id,request);
    const denied=(reason:string)=>({allow:false,reason});
    if(!site || tab.incognito || !await this.allowed(tab)) return denied('Protection needs site access. Take over to navigate manually.');
    let c=this.current.get(id);
    if(!c || c.doc!==target.documentId || c.raw!==tab.url){
      await this.arrive(id,target.documentId);
      c=this.current.get(id);
    }
    if(!c || c.doc!==target.documentId || c.raw!==tab.url) return denied('The protected document changed. Inspect the current page again.');
    const owner=c, subject=automaticThreatSubject(target.url,'target');
    const comparison=target.kind==='offer'?s.comparison?.version:undefined;
    const selection=target.kind==='download'?s.cp.review?.operationId:undefined;
    const sourceIdentity=()=>target.kind==='source'?JSON.stringify([s.comparison?.id,s.comparison?.version,
      s.shopping?.seller?.data.binding.operationId,s.shopping?.product?.data.binding.operationId]):undefined;
    const source=sourceIdentity();
    const binding=JSON.stringify([target.kind,comparison,selection,source]);
    const sameSelection=()=>this.current.get(id)===owner && this.targetVersions.get(id)===request &&
      s.cp.task?.id===task && s.cp.task?.adaptive?.version===version &&
      (target.kind!=='offer' || s.comparison?.version===comparison) &&
      (target.kind!=='download' || s.cp.review?.operationId===selection) && sourceIdentity()===source;
    let expectedPause:string|undefined;
    let pauseEpoch:number|undefined;
    // Pausing a task retires its action epoch. Keep only the resulting warning
    // for that exact pause and selection; the retired epoch can never act.
    this.targetIsCurrent.set(id,()=>{
      if(!sameSelection())return false;
      if(s.cp.epoch===epoch)return true;
      if(!expectedPause || s.cp.task?.state!=='paused' || s.cp.task.adaptive?.status!==expectedPause)return false;
      pauseEpoch??=s.cp.epoch;
      return s.cp.epoch===pauseEpoch;
    });
    const bound=async()=>!signal.aborted && sameSelection() && s.cp.epoch===epoch &&
      this.prefs.automaticUrlConsent===2 && await this.bound(owner) &&
      (await chrome.tabs.get(id)).active;
    const old=this.limited.get(id);
    const authorized=!!old && old.approved && Date.now()<old.expires && old.owner===owner &&
      old.epoch===epoch && old.task===task && old.version===version && old.binding===binding && old.kind===target.kind && old.url===target.url;
    this.limited.delete(id);
    const explain=async(message:string,result?:ThreatReply,canApprove=false)=>{
      const reason=result?.status==='match'?'Google Web Risk reported a possible threat at the selected destination. Review the warning or take over.':message.slice(0,175);
      if(await bound()) {
        expectedPause=reason;
        const ticket=canApprove?crypto.randomUUID():undefined;
        if(ticket)this.limited.set(id,{ticket,owner,epoch,task,version,binding,kind:target.kind,url:target.url,approved:false,expires:Date.now()+60000});
        await this.show(owner,v=>({...v,destination:{kind:target.kind,message,result,limitedTicket:ticket}}));
      }
      return denied(reason);
    };
    if(!await bound())return denied('The selected destination changed. Inspect it again.');
    if(!subject)return explain('This destination is private or outside URL-check coverage. Take over to follow it manually.');
    const destOrigin=new URL(subject.url).origin;
    const grant=async()=>this.prefs.scope!=='off' && (this.prefs.scope==='all' || this.prefs.sites.includes(destOrigin)) &&
      await chrome.permissions.contains({origins:[pattern(destOrigin)]});
    if(!await grant()) return explain('Protection has no site grant for '+destOrigin+'. Enable that site or take over manually.');
    const home=threatRootUrl(subject.url);
    let hasHomeConcern=owner.view.threatWarnings?.find(x=>freshMatch(x) && x.url===home);
    if(!hasHomeConcern && home && this.threats.hasPositive(home)){
      const known=await this.threats.check({url:home,scope:'root',purpose:'target'},
        AbortSignal.any([signal,owner.controller.signal,AbortSignal.timeout(6500)]),async()=>await bound() && await grant());
      if(known.reply && freshMatch(known.reply))hasHomeConcern=known.reply;
      else if(!known.reply || known.reply.status==='unavailable' || known.reply.status==='rate_limited')
        return explain('A previous homepage warning could not be revalidated. Take over to review this destination.');
    }
    if(hasHomeConcern) return explain('The destination’s homepage has a current threat warning. Take over to review it.',hasHomeConcern);
    await this.show(owner,v=>({...v,destination:{kind:target.kind,message:'Checking the selected '+target.kind+' destination…'}}));
    const timeout=AbortSignal.timeout(6500);
    const result=await this.threats.check(subject,AbortSignal.any([signal,owner.controller.signal,timeout]),async()=>await bound() && await grant());
    if(!await bound() || !await grant()) return denied('The page, selection or site access changed. Take over or inspect again.');
    const reply=result.reply;
    if(!reply || reply.status!=='no_match' || subject.scope==='root'){
      const message=(reply?threatFinding(reply):result.message??'The lookup did not finish.')+
        ' SafeStep paused. You can take over manually.';
      if(authorized && reply?.status!=='match' && await bound() && await grant()){
        await this.show(owner,v=>({...v,destination:{kind:target.kind,message:'You accepted limited URL coverage for this destination only.',result:reply}}));
        return {allow:await bound() && await grant(),reason:'The destination or site access changed.'};
      }
      return explain(message,reply,reply?.status!=='match');
    }
    await this.show(owner,v=>({...v,destination:{kind:target.kind,message:'Selected '+target.kind+' destination. '+threatFinding(reply),result:reply}}));
    return await bound() && await grant() ? {allow:true} : denied('The selected destination changed.');
  };
  private enqueue(c: Current,subject?:ThreatSubject) {
    if (this.current.get(c.id) !== c) return;
    const host = c.view.host, key=subject?'threat:'+subject.scope+':'+subject.url:'merchant:'+host,
      pending = this.jobs.get(key);
    if (pending) {
      pending.targets.add(c);
      return;
    }
    if (this.jobs.size >= 8) {
      if(subject) void this.threatNotice(c,'Outside lookup queue is full. No threat lookup was sent.');
      else void this.local(c, 'quota', 'Outside check queue is full. Recheck later.');
      return;
    }
    const job = { key,host,subject, targets: new Set([c]), controller: new AbortController() };
    this.jobs.set(key, job);
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        try {
          await this.lookup(job);
        } catch {
          if (!job.controller.signal.aborted)
            await Promise.all(
              [...job.targets].map((x) => subject?this.threatNotice(x,
                'Google Web Risk service unavailable. Coverage is unknown.'):this.local(
                  x,
                  'unavailable',
                  'Outside service unavailable. Local address checks remain available.',
                ),
              ),
            );
        } finally {
          if (this.jobs.get(key) === job) this.jobs.delete(key);
        }
      });
  }
  private threatNotice(c:Current, message:string){
    return this.show(c,current=>({...current,threatNotice:message,
      threat:current.threat && freshMatch(current.threat)?current.threat:undefined}));
  }
  private local(c: Current, status: ProtectionView['status'], outside: string) {
    return this.show(c, current=>({
      ...current,
      status,
      outside,
      details: [],
      sources: [],
      expiresAt: null,
      caution: protectionAddress(c.raw).caution,
    }));
  }
  private async lookup(job: Job) {
    const subject=job.subject;
    for (const c of [...job.targets])
      if (!(await this.bound(c)) || (subject && threatUrl(subject.scope,c.raw)!==subject.url)) job.targets.delete(c);
    if (
      !job.targets.size ||
      job.controller.signal.aborted ||
      (!subject && !this.prefs.outside) ||
      !this.prefs.budget
    )
      return;
    const local = (status: ProtectionView['status'], why: string) =>
      Promise.all([...job.targets].map((c) => subject?this.threatNotice(c,why):this.local(c, status, why)));
    const session = await chrome.storage.session.get([sessionKey, quotaKey]),
      token = session[sessionKey];
    if (typeof token !== 'string' || !/^ss3_[\w-]{43}$/.test(token)) {
      await local(
        'unavailable',
        'Outside service is not paired. Connect the local service in Settings.',
      );
      return;
    }
    // The quota is keyed to a session fingerprint. The credential stays in its original trusted storage slot.
    const bytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    );
    const signature = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
    const previous = Quota.safeParse(session[quotaKey]);
    const budget =
      previous.success && previous.data.session === signature
        ? previous.data
        : { session: signature, count: 0, times: [] };
    const now = Date.now();
    budget.times = budget.times.filter((ms) => ms > now - 60000);
    const key = signature + ':' + job.key,
      cachedMerchant = !subject && this.cache.get(key),
      cachedThreat = subject && this.threatCache.get(key);
    const validCached = !!((cachedMerchant && Date.parse(cachedMerchant.expiresAt)>now) ||
      (cachedThreat && freshMatch(cachedThreat,now)));
    if (!validCached) {
      if (budget.count >= Math.min(20, this.prefs.budget) || budget.times.length >= 2) {
        await local('quota', 'Automatic lookup budget reached. No outside request was made.');
        return;
      }
      budget.count++;
      budget.times.push(now);
      await chrome.storage.session.set({ [quotaKey]: budget });
    }
    // Recheck document and policy after awaits/storage accounting. A moved tab
    // may consume a reserved slot but must never send its old URL to a provider.
    for(const c of [...job.targets])
      if(!(await this.bound(c)) || (subject && threatUrl(subject.scope,c.raw)!==subject.url)) job.targets.delete(c);
    if (job.controller.signal.aborted || !job.targets.size) return;
    if (subject) {
      const allowed=async()=> {
        for (const c of [...job.targets]) {
          if (!await this.bound(c) || threatUrl(subject.scope,c.raw)!==subject.url) job.targets.delete(c);
        }
        return job.targets.size>0 && !job.controller.signal.aborted;
      };
      const result=await this.threats.check(subject,job.controller.signal,allowed);
      if (!await allowed()) return;
      if (result.reply && freshMatch(result.reply)) {
        if(this.threatCache.size>=24) this.threatCache.delete(this.threatCache.keys().next().value!);
        this.threatCache.set(key,result.reply);
      }
      await Promise.all([...job.targets].map(c=>this.applyThreat(c,result)));
      return;
    }
    const response = await fetch(service + (validCached ? '/v1/explain/connect' : '/v1/merchant/check'), {
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(validCached ? {} : {body:JSON.stringify(MerchantRequest.parse({domain:job.host}))}),
      credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',
      signal:AbortSignal.any([job.controller.signal,AbortSignal.timeout(18000)]),
    });
    if(response.status===401 || response.status===403) {
      this.cache.clear(); await local('unavailable','Pairing expired or was refused. Reconnect in Settings.'); return;
    }
    if(response.status===429) {await local('quota','Outside source quota reached. Recheck later.');return;}
    if(!response.ok)throw Error();
    const json=JSON.parse(await boundedResponseText(response,64*1024,'Invalid outside response.'));
    if(validCached && !ExplainHealth.parse(json).connected) {
      await local('unavailable','Pairing unavailable. Reconnect in Settings.'); return;
    }
    const reply = validCached && cachedMerchant ? cachedMerchant : MerchantReply.parse(json);
    if (reply.domain !== job.host || job.controller.signal.aborted) throw Error();
    if (Date.parse(reply.expiresAt) > now) {
      if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, reply);
    }
    await Promise.all(
      [...job.targets].map((c) =>
        this.show(c, current=>({
          ...current,
          status: reply.status === 'rate_limited' ? 'quota' : reply.status,
          outside: reply.summary,
          checkedAt: reply.checkedAt,
          expiresAt: Date.parse(reply.expiresAt) > now ? reply.expiresAt : null,
          details: [
            ...(['reports','limited','no_match'].includes(reply.status) ? [
              'Complaint period: '+reply.windowStart+' through '+reply.checkedAt.slice(0,10)+'.',
              'Sample: '+reply.rowsInspected+' practice rows inspected (maximum 12); '+
                reply.distinctComplaints+' distinct complaints in this sample.',
            ] : []),
            ...reply.limitations,
            ...reply.records
              .slice(0, 7)
              .map((x) => x.date + ' · ' + x.practices.join(', ') + ' · ' + x.caseStatus),
          ].slice(0, 18),
          sources: [
            { label: reply.provider, url: reply.source },
            ...reply.records
              .slice(0, 7)
              .map((x) => ({ label: 'Complaint ' + x.id + ' · ' + x.date, url: x.url })),
          ],
          caution: protectionAddress(c.raw).caution || reply.severity === 'caution',
        })),
      ),
    );
  }
  async restore() {
    const saved = await chrome.storage.session.get(null);
    let authenticated: Promise<boolean> | undefined;
    for (const [key, value] of Object.entries(saved)) {
      if (!key.startsWith(receiptPrefix)) continue;
      const id = Number(key.slice(receiptPrefix.length)),
        p = ProtectionView.safeParse(value);
      if (!Number.isInteger(id) || !p.success) continue;
      try {
        const t = await chrome.tabs.get(id);
        if (
          !(await this.allowed(t)) ||
          permittedOrigin(t.url) !== p.data.origin ||
          (await probe(id, p.data.origin)) !== p.data.doc
        ) {
          await this.clear(id);
          continue;
        }
        let prior = p.data;
        if (prior.sources.length || prior.threat || prior.threatWarnings?.length) {
          authenticated ??= this.stillPaired(saved[sessionKey]);
          if (!(await authenticated)) {
            prior = {
              ...prior,
              status: prior.sources.length?'unavailable':prior.status,
              sources: [],
              details: [],
              expiresAt: null,
              outside: prior.sources.length ? prior.caution
                ? 'Previously reported concerns need rechecking. Current outside coverage is unavailable.'
                : 'Pairing expired or the service is offline. Recheck for current outside evidence.' : prior.outside,
              threat:undefined,
              threatWarnings:[],
              threatNotice:'Pairing expired or the service is offline. Recheck for current threat coverage.',
            };
          }
        }
        await this.arrive(id, prior.doc, false, prior);
      } catch {
        await chrome.storage.session.remove(key);
      }
    }
  }
  private async stillPaired(token: unknown) {
    if (typeof token !== 'string' || !/^ss3_[\w-]{43}$/.test(token)) return false;
    try {
      const res = await fetch(service + '/v1/explain/connect', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(3000),
      });
      return res.ok && ExplainHealth.parse(JSON.parse(await boundedResponseText(res,8192,'Invalid pairing response.'))).connected;
    } catch {
      return false;
    }
  }
  async page(raw: unknown, sender: chrome.runtime.MessageSender) {
    if (
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      sender.tab?.id === undefined ||
      !raw ||
      typeof raw !== 'object'
    )
      return;
    const msg = raw as { op?: unknown; revision?: unknown },
      id = sender.tab.id;
    if (msg.op === 'arrive') {
      await this.arrive(id, sender.documentId);
      return;
    }
    const c = this.current.get(id);
    if (
      !c ||
      c.doc !== sender.documentId ||
      msg.revision !== c.view.revision ||
      !(await this.bound(c))
    )
      return;
    if (msg.op === 'dismiss') await this.show(c,current=>current,true);
    else if (msg.op === 'expire' && this.hasExpired(c.view)) await this.expire(c);
    else if (msg.op === 'leave' && c.view.caution) {
      // Only the isolated warning's trusted button can send Leave.
      await chrome.tabs.update(id, { url: 'about:blank' });
    }
  }
  async navigation(id: number, ch: chrome.tabs.OnUpdatedInfo, _eventTab: chrome.tabs.Tab) {
    if (!ch.url && ch.status !== 'loading' && ch.status !== 'complete') return;
    const t=await chrome.tabs.get(id), prior=this.current.get(id);
    if(!t.url||!await this.allowed(t)){if(prior&&prior===this.current.get(id))await this.clear(id);return;}
    const site=permittedOrigin(t.url)!;
    const doc=await probe(id,site).catch(()=>null);
    const now=await chrome.tabs.get(id);
    if(now.url!==t.url)return;
    if(!doc){if(prior&&prior.raw!==now.url&&prior===this.current.get(id))await this.clear(id);return;}
    if(prior&&prior.doc!==doc&&prior===this.current.get(id))await this.clear(id);
    await this.arrive(id,doc);
  }
  async drop(id: number) {
    await this.clear(id);
    this.generation.delete(id);
    this.dismissals.delete(id);
    this.lastArrival.delete(id);
    this.targetVersions.delete(id);
  }
  async activated(id:number) {
    if(this.prefs.scope==='off') return;
    const tab=await chrome.tabs.get(id);
    await this.navigation(id,{status:'complete'},tab);
    const c=this.current.get(id);
    if(!c || this.prefs.automaticUrlConsent!==2 || !await this.bound(c))return;
    const prior=c.view.threat;
    if(prior?.status==='no_match' || (prior && freshMatch(prior)))return;
    if(Date.now()-(this.lastArrival.get(id)??0)<60_000)return;
    await this.automaticArrival(c);
  }
  async pairingChanged() {
    this.threats.reset();
    this.cache.clear();
    this.threatCache.clear();
    for (const c of this.current.values()) {
      this.stopWork(c);
      c.controller=new AbortController();
      if (c.view.threat || c.view.threatWarnings?.length || this.prefs.threatRoot)
        await this.show(c,current=>({...current,threat:undefined,threatWarnings:[],
          threatNotice:'Local pairing changed. Recheck for current threat coverage.'}));
      if (this.prefs.outside && c.view.status !== 'private')
        await this.local(
          c,
          'unavailable',
          'Local pairing changed. Recheck with a current session.',
        );
      if (this.prefs.automaticUrlConsent===2 && await this.bound(c))
        void this.automaticArrival(c).catch(()=>{});
    }
  }
  async revoked(patterns: string[]) {
    this.threats.reset();
    const prefs = this.prefs;
    prefs.sites = prefs.sites.filter((site) => !removedOrigin(site, patterns));
    if (prefs.scope === 'all' && !(await chrome.permissions.contains({ origins: allWeb })))
      prefs.scope = 'off';
    for (const c of [...this.current.values()])
      if (removedOrigin(c.view.origin, patterns) || prefs.scope === 'off') await this.clear(c.id);
    this.cache.clear();
    this.threatCache.clear();
  }
  async reset() {
    this.threats.reset();
    for (const c of [...this.current.values()]) await this.clear(c.id);
    this.cache.clear();
    this.threatCache.clear();
    this.dismissals.clear();
  }
  async operate(t: chrome.tabs.Tab, cmd: ProtectionCommand) {
    const id = t.id!;
    if(cmd.op==='allowLimitedTarget'){
      const c=this.current.get(id),grant=this.limited.get(id),s=this.store.get(id);
      if(!c || !grant || grant.owner!==c || !t.active || grant.expires<=Date.now() || grant.ticket!==cmd.ticket ||
        c.view.revision!==cmd.revision || c.view.destination?.limitedTicket!==cmd.ticket || this.prefs.automaticUrlConsent!==2 ||
        s.cp.task?.id!==grant.task || s.cp.task?.adaptive?.version!==grant.version ||
        !this.targetIsCurrent.get(id)?.() || !await this.bound(c))throw new Fault('stale_document');
      grant.approved=true;
      grant.epoch=s.cp.epoch;
      await this.show(c,v=>({...v,destination:{kind:v.destination!.kind,message:'Limited coverage accepted once. Retry this same destination to continue.'}}));
      return;
    }
    if (cmd.op === 'dismiss' || cmd.op === 'recheck' || cmd.op==='threat') {
      const c = this.current.get(id);
      if (!c || c.view.revision !== cmd.revision || !(await this.bound(c)))
        throw new Fault('stale_document');
      if (cmd.op === 'dismiss') await this.show(c,current=>current,true);
      else if(cmd.op==='threat') await this.startThreat(c,cmd.scope);
      else if (![...this.jobs.values()].some(j=>j.targets.has(c))) await this.arrive(id, c.doc, true);
      return;
    }
    const prior = this.prefs,
      sites = new Set(prior.sites);
    if (cmd.op === 'removeSite') {
      sites.delete(cmd.site);
      this.store.prefs.protection = { ...prior, sites: [...sites] };
      await this.store.configure();
      for (const c of [...this.current.values()])
        if (c.view.origin === cmd.site) await this.clear(c.id);
      return;
    }
    if (cmd.op !== 'configure') throw new Fault('invalid_message');
    if ((cmd.outside || cmd.threatRoot) && !cmd.budget) throw new Fault('invalid_message');
    if (cmd.scope === 'all' && !(await chrome.permissions.contains({ origins: allWeb })))
      throw new Fault('permission_required');
    if (cmd.scope === 'selected' && cmd.site) {
      if (
        cmd.site !== permittedOrigin(t.url) ||
        t.incognito ||
        !(await chrome.permissions.contains({ origins: [pattern(cmd.site)] }))
      )
        throw new Fault('permission_required');
      sites.add(cmd.site);
    }
    if (sites.size > 64 || (cmd.scope === 'selected' && !sites.size))
      throw new Fault('blocked_by_policy');
    this.store.prefs.protection = {
      scope: cmd.scope,
      sites: [...sites],
      outside: cmd.scope !== 'off' && cmd.outside,
      threatRoot:cmd.scope!== 'off' && !!cmd.threatRoot,
      ...(cmd.scope!=='off' && cmd.automaticUrlConsent===2 ? {automaticUrlConsent:2} : {}),
      budget: cmd.budget,
    };
    await this.reset();
    await this.store.configure();
    if (await this.allowed(t)) {
      await chrome.scripting.executeScript({
        target: { tabId: id, frameIds: [0] },
        files: [protectionFile],
      });
      await chrome.tabs
        .sendMessage(id, { channel: 'protection-display', op: 'ping' }, { frameId: 0 })
        .catch(() => {});
    }
  }
}
