// Builder evidence map. A requirement identifies evidence that must exist, not a result.
import path from 'node:path';
import fs from 'node:fs';
import { providerBlockReason } from './stage5-provider-trace.mjs';
const req = {
  P01: 'r:gate',
  P02: 'r:repairs',
  P03: 'r:upstream',
  N01: 'n:stage7/setup r:foundation',
  N02: 'n:stage7/ui r:features',
  N03: 'n:stage7/ui l:stage7-guidance/generic c:N03',
  N04: 'n:stage7/conflict c:N04',
  N05: 'n:stage7/ui c:N05',
  N06: 'n:stage7/ui c:N06',
  F01: 'n:stage5-repairs/navigation-deep-guide n:stage5-repairs/navigation-covered n:stage5-repairs/nearby-replace',
  F02: 'l:stage7-guidance/generic l:stage7-guidance/wiki-transfer n:stage7/downloadEdges u:publicGoal',
  F03: 'n:stage7-protection/amazon r:addressEdges',
  F04: 'n:stage3/labelled_labs n:stage7-protection/arrival n:stage7-protection/lifecycle',
  F05: 'n:stage3/SS3-01_and_SS3-02 n:stage3/stale_reveal_and_chronological_releases n:stage7/downloadEdges',
  F06: 'n:stage4/SS4-02-03-05_local n:stage4/public-seller',
  F07: 'n:stage4/SS4-01-06_Mozilla n:stage4/public-product n:stage6/mozilla',
  F08: 'n:stage5/controls-actions n:stage5/controls-lastMoment n:stage5/controls-afterDispatch',
  F09: 'n:stage5-repairs/cleanup-baseline n:stage5-repairs/cleanup-protected n:stage5-repairs/cleanup-backdrop n:stage5/controls-cleanupEdges',
  F10: 'n:stage6/exact n:stage6/selected n:stage6/coverage n:stage6/pen n:stage6/book r:stage6Regression',
  I01: 'n:stage7/guidedSafety c:I01',
  I02: 'n:stage5/controls-pendingCleanup n:stage5/controls-cleanDuringTask',
  I03: 'n:stage7/conflict c:I03',
  I04: 'n:stage6/cleanup n:stage5-repairs/cleanup-protected',
  I05: 'n:stage6/window n:stage6/edits n:stage5/controls-tabs',
  I06: 'n:stage6/mozilla n:stage6/pen n:stage6-repairs/filteredSource n:stage4/SS4-01-06_Mozilla',
  I07: 'n:stage6/reviewBudget n:stage4/SS4-04_session_limit c:I07',
  I08: 'n:stage7/restoreData c:I08',
  R01: 'n:stage6/lifecycle n:stage5/controls-interruption n:stage5/controls-mutation',
  R02: 'n:stage6/recovery n:stage6/pendingRecovery n:stage5/controls-recovery',
  R03: 'n:stage6/permissions n:stage7-protection/lifecycle n:stage5/controls-tabs',
  R04: 'r:foundation n:stage7/restoreData c:R04',
  R05: 'n:stage5/AI_boundaries n:stage7/publisherOffline c:R05 r:connectPair u:timeout u:pairExpiry',
  R06: 'n:stage6/expiry n:stage6/coverage n:stage6/selected n:stage6-repairs/partialSort',
  R07: 'n:stage6/boundaries n:stage5/controls-privacyBudget n:stage7-protection/lifecycle r:foundation',
  R08: 'u:untrusted n:stage5/AI_boundaries n:stage6/boundaries',
  R09: 'r:secrets n:stage6/boundaries',
  U01: 'n:stage7/ui c:U01 r:visual',
  U02: 'n:stage7/ui n:stage6/recovery c:U02',
  U03: 'n:stage7/ui n:stage6/exact n:stage5/controls-keyboard c:U03',
  U04: 'n:stage7/setup c:U04',
  D01: 'r:identity',
  D02: 'r:cleanOperator',
  D03: 'r:features',
  D04: 'r:handoff',
  D05: 'r:independent',
  D06: 'r:presentation',
  D07: 'r:cutoff',
  D08: 'r:github',
  V01: 'l:stage2/wiki l:stage2/video',
  V02: 'l:stage5/mdn-map-guide l:stage5/mdn-map-auto l:stage5/mdn-filter-auto',
  V03: 'l:stage5/python-venv-guide l:stage5/python-venv-auto l:stage5/python-exceptions-guide',
  V04: 'l:stage3/vlc_windows_x64 l:stage3/seven_zip_windows_x64_exe',
  V05: 'l:stage4/public-seller l:stage6/pen l:stage6/book',
  V06: 'l:stage4/public-product l:stage6/mozilla l:stage6-repairs/filteredSource',
  C01: 'l:stage7-explanations/website l:stage7-explanations/download l:stage7-explanations/seller l:stage7-explanations/product l:stage7-explanations/comparison',
  C02: 'r:human',
  X01: 'l:stage7-guidance/generic n:stage7/unsupported u:goalSpans',
  X02: 'n:stage7-guidance/policy-dense n:stage5-repairs/navigation-covered n:stage5-repairs/navigation-deep-auto n:stage5/controls-mutation',
  X03: 'n:stage7-guidance/wiki-auto n:stage7-guidance/policy-modes n:stage5/controls-interruption n:stage5/controls-afterDispatch',
  X04: 'l:stage7-guidance/wiki-guide',
  X05: 'l:stage7-guidance/wiki-auto l:stage7-guidance/wiki-transfer',
  X06: 'l:stage7-guidance/generic n:stage7-guidance/policy-boundaries u:publicGoal n:stage6/boundaries',
  X07: 'n:stage7/downloadEdges n:stage7/fixtureDownloadGuide n:stage7/fixtureDownloadAuto c:X07',
  X08: 'n:stage7/fixtureDownloadGuide n:stage7/fixtureDownloadAuto',
  X09: 'l:stage7/downloadVlcGuide l:stage7/downloadVlcAuto l:stage7/download7Guide l:stage7/download7Auto',
  X10: 'n:stage7-protection/lifecycle c:X10',
  X11: 'l:stage7-protection/arrival',
  X12: 'u:merchantClaims n:stage7-protection/arrival c:X12',
  X13: 'l:stage7-protection/arrival r:merchantWire',
  X14: 'u:merchantClaims u:merchantBudget c:X14',
  X15: 'u:merchantHTTP u:merchantBudget n:stage7-protection/lifecycle c:X15',
  X16: 'n:stage7-protection/arrival n:stage7-protection/lifecycle c:X16',
  X17: 'n:stage7-protection/amazon u:amazonIdentity',
  X18: 'l:stage7-protection/amazon',
  X19: 'n:stage7-protection/amazon c:X19',
  X20: 'r:amazon',
  X21: 'r:amazon l:stage7-protection/sellerFirst',
  X22: 'c:X22',
  X23: 'c:X23',
  X24: 'r:amazon l:stage7-protection/sellerSecond',
  X25: 'n:stage7/conflict c:X25',
  X26: 'n:stage7/setup c:X26',
};
export const stage7EvidenceRequirements = Object.fromEntries(
  Object.entries(req).map(([id, s]) => ['S7-' + id, s.split(' ')]),
);
const unitNames = {
  publicGoal:
    'Stage 7 public guidance admits ordinary content and confines private, opaque or transactional destinations',
  merchantClaims:
    'Washington evidence groups a complaint once, preserves exact corporate scope and reports uncertain cases conservatively',
  merchantBudget:
    'Merchant lookup respects public-domain privacy, caching, session budget, concurrent owners and cancellation',
  merchantHTTP:
    'Merchant HTTP operations require an active paired extension and strict body before any outside read',
  untrusted:
    'Comparison intent and explanation preserve hard constraints, budgets, reference ownership and local decisions',
  timeout:
    'A05 rejection, cancellation, deadline, empty output, malformed JSON and upstream failures remain unavailable',
  pairExpiry:
    'A06 one pending call per operation, six calls per minute, thirty per session, pairing token expiry',
  amazonIdentity:
    'Amazon US identity uses the parsed registrable domain, secure origin and user-supplied expectation',
  goalSpans:
    'Intent spans bind exact entities, platform and negation to the user’s words',
};
const statusSet = new Set(['pass', 'fail', 'blocked', 'not_run']);
const normalize = (s) => String(s ?? '').replaceAll(' ', '_');
const summary = (r) =>
  r.observation ??
  r.checks
    ?.map((x) =>
      typeof x === 'string' ? x : x.actual || x.id || JSON.stringify(x),
    )
    .join(' ') ??
  r.verdict?.observation ??
  r.end ??
  r.final?.title ??
  '';
function measured(r, w) {
  const d = r.dimensions ?? r.environment;
  return (
    d?.closed?.width === w &&
    d.closed.height === (w === 1440 ? 900 : 768) &&
    d.zoom === 1 &&
    d.native === true &&
    d.panel?.width > 0 &&
    d.page?.width > 0
  );
}
// A missing live scenario may share a provider dependency with an actually
// executed request. Keep that inference separate from native case observations.
const qaModel='gemini-3.5-flash-lite';
export function dailyGeminiQuota(runs,sourceSHA,now=Date.now()) {
  const observations=[];
  const receipts=new Map();
  let lastSuccess=0;
  for(const f of runs) {
    if(!sourceSHA || f.sourceSHA!==sourceSHA || f.historicalOnly || !f.receipt ||
       !fs.existsSync(f.receipt) || !fs.existsSync(f.path)) continue;
    if(!receipts.has(f.receipt))receipts.set(f.receipt,JSON.parse(fs.readFileSync(f.receipt,'utf8')));
    const receipt=receipts.get(f.receipt);
    if(receipt.sourceSHA!==sourceSHA||receipt.extensionSHA!==f.report.sha256)continue;
    const began=Date.parse(receipt.at),ended=Date.parse(receipt.finished);
    for(const r of f.rows) {
      if(!measured(r,r.width))continue;
      const model=r.health?.model??r.model??f.report.model;
      if(model!==qaModel)continue;
      if(f.group==='stage5' && f.report.provider==='Google Gemini / production SDK'){
        for(const op of [...(r.realOperations??[]),...(r.modelTrace??[])]) {
          const wire=op.upstream,t=Date.parse(op.at);
          if(!Number.isFinite(t)||!(t>=began&&t<=ended))continue;
          if(wire?.http===200 && op.status==='available')lastSuccess=Math.max(lastSuccess,t+(op.elapsedMs??0));
          const limit=wire?.quota?.violations?.find(v=>v.window==='day' &&
            v.quotaId==='GenerateRequestsPerDayPerProjectPerModel-FreeTier' &&
            v.quotaMetric==='generativelanguage.googleapis.com/generate_content_free_tier_requests');
          const seconds=/^(\d+(?:\.\d{1,9})?)s$/.exec(wire?.quota?.retryDelay??'');
          if(!limit||wire.http!==429||wire.code!=='RESOURCE_EXHAUSTED'||!seconds||
             !(+seconds[1]>0&&+seconds[1]<=86400)||op.status!=='rate_limited'||
             !['intent','step'].includes(op.operation)||r.status!=='blocked'||r.diagnostic?.state!=='paused'||
             r.downloads!==0||r.attempts!==0||!Number.isFinite(op.elapsedMs)||op.elapsedMs<0||
             t+op.elapsedMs>ended+1000||!providerBlockReason(op,r.diagnostic.message))continue;
          const received=t+op.elapsedMs, until=received+Number(seconds[1])*1000;
          const result={path:f.path,executionReceipt:f.receipt,sourceSHA,fingerprint:f.report.sha256,
            model,observedScenario:r.name,observedWidth:r.width,operation:op.operation,
            code:wire.code,http:wire.http,violation:limit,retryDelay:wire.quota.retryDelay,
            receivedAt:new Date(received).toISOString(),retryAfter:new Date(until).toISOString()};
          if(!observations.some(x=>x.path===result.path&&x.receivedAt===result.receivedAt))observations.push(result);
        }
      }
      if(['stage7-guidance','stage7-explanations','stage7'].includes(f.group) && r.status==='pass' &&
         (f.group!=='stage7'||f.report.pairedProvider===true)){
        for(const op of r.operations??[])if(op.status==='available' && Number.isFinite(Date.parse(op.at)))
          lastSuccess=Math.max(lastSuccess,Date.parse(op.at));
        if(f.group==='stage7-explanations'&&r.operation?.status==='available'&&r.evidence){
          const observed=r.kind==='comparison'
            ?r.health?.recent?.findLast(x=>x.operation==='explain'&&x.status==='available')?.at
            :r.health?.operations?.[r.kind]?.at;
          lastSuccess=Math.max(lastSuccess,Date.parse(observed??r.at)||0);
        }
      }
    }
  }
  observations.sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt));
  const latest=observations.at(-1);
  if(!latest)return null;
  const received=Date.parse(latest.receivedAt),until=Date.parse(latest.retryAfter);
  const status=lastSuccess>received?'superseded_by_success':now>=until?'retry_window_expired':now<received?'not_yet_observed':'active';
  return {...latest,status,asOf:new Date(now).toISOString(),history:observations,
    ...(lastSuccess>received?{succeededAt:new Date(lastSuccess).toISOString()}: {})};
}
const genuineModelRequirement=tag=>
  /^[ln]:stage7-guidance\/(?:generic|wiki-guide|wiki-auto|wiki-transfer)$/.test(tag) ||
  /^l:stage5\/(?:mdn-(?:map-guide|map-auto|filter-auto)|python-(?:venv-guide|venv-auto|exceptions-guide))$/.test(tag) ||
  /^l:stage7\/download(?:Vlc|7)(?:Guide|Auto)$/.test(tag) ||
  /^l:stage7-explanations\/(?:website|download|seller|product|comparison)$/.test(tag);
function automatic(n) {
  return /auto|transfer|generic/i.test(n);
}
function validateLive(group, r, file) {
  if(group==='stage2') return r.kind==='live' && r.alreadyComplete===true &&
    r.installerRequests===0 && r.steps?.length===3 && r.steps.every(s=>s.aligned);
  if(group==='stage3') {
    const packageURL=r.officialDestination;
    return r.downloads===0 && r.installerAttempts===0 && (r.name==='vlc_windows_x64'
      ? packageURL?.host==='get.videolan.org' && /^\/vlc\/[\d.]+\/win64\/vlc-[\d.]+-win64\.exe$/.test(packageURL.path)
      : packageURL?.host==='github.com' && /^\/ip7z\/7zip\/releases\/download\/[\d.]+\/7z\d+-x64\.exe$/.test(packageURL.path));
  }
  if(group==='stage4') return r.downloads===0 && r.consequentialAttempts===0 && (r.name==='public-seller'
    ? r.observed?.subject?.market==='resell' && !!r.observed.subject.seller && !!r.observed.subject.listing
    : r.observed?.context?.market==='mozilla' && !!r.observed.context.catalog && !!r.filtered);
  if(group==='stage6' || group==='stage6-repairs') {
    const baseline=r.observations?.find(x=>x.baseline)?.baseline;
    if(!baseline?.url || r.downloads!==0 || r.consequentialAttempts!==0)return false;
    const url=new URL(baseline.url);
    if(r.name==='book')return url.hostname.endsWith('.resell.store') && r.observations.some(x=>x.status==='only_baseline'||x.status==='ready');
    if(r.name==='pen')return url.hostname.endsWith('.resell.store') && !!r.opened?.visible?.href;
    if(url.hostname!=='addons.mozilla.org')return false;
    if(r.name==='mozilla')return new URL(r.opened?.visible?.href??'about:blank').hostname==='addons.mozilla.org';
    return r.requests?.some(q=>q.host==='addons.mozilla.org' && q.fromExtension && q.http===200 &&
      q.query?.score==='1' && q.query?.page==='2') && !!r.filteredEvidence?.before?.catalog;
  }
  if (group === 'stage7-guidance')
    return (
      !!r.model &&
      (r.operations ?? []).some(
        (x) => x.operation === 'intent' && x.status === 'available',
      ) &&
      r.operations.some(
        (x) => x.operation === 'step' && x.status === 'available',
      ) &&
      r.final?.headingVisible &&
      !!r.final?.title &&
      r.final.url !== r.start && new URL(r.final.url).hostname===(r.name==='generic'?'localhost':'en.wikipedia.org') &&
      Array.isArray(r.websiteActionsByHarness) &&
      (automatic(r.name)
        ? r.websiteActionsByHarness.length === 0
        : r.websiteActionsByHarness.length > 0)
    );
  if (group === 'stage5')
    return (
      file.report.provider === 'Google Gemini / production SDK' &&
      r.health?.model &&
      ['intent', 'step'].every((k) =>
        r.modelTrace?.some(
          (x) =>
            x.operation === k &&
            x.status === 'available' &&
            x.upstream?.http === 200,
        ),
      ) &&
      typeof r.pageClicksByHarness === 'number' &&
      (!automatic(r.name) || r.pageClicksByHarness === 0) &&
      !!r.end &&
      r.downloads === 0
    );
  if (group === 'stage7-protection') {
    if (r.name === 'arrival')
      return (
        r.requests?.some(
          (q) =>
            q.method === 'POST' && q.service==='http://127.0.0.1:4317' && q.domain?.domain==='www.wayfair.com' &&
            Object.keys(q.domain ?? {}).join(',') === 'domain',
        ) &&
        r.observations?.some(
          (x) => x.status === 'reports' && x.caution && x.host==='www.wayfair.com' &&
            x.origin==='https://www.wayfair.com' && x.sources?.filter(s=>s.url?.startsWith('https://data.wa.gov/resource/fvrz-yz45.json?')).length>=2,
        ) &&
        r.badge === '!' &&
        r.screens?.length
      );
    if (r.name === 'amazon')
      return (
        r.observations?.some(
          (x) =>
            x.identity === 'amazon_us' && x.status === 'local' && !x.caution &&
            x.origin==='https://www.amazon.com' && x.host==='www.amazon.com',
        ) && r.badge !== undefined
      );
    return (
      !!r.sellerEvidence?.accountId &&
      !!r.sellerEvidence?.region &&
      !!r.sellerEvidence?.offerId &&
      Array.isArray(r.sellerEvidence?.sources) &&
      r.sellerEvidence.sources.length > 0
    );
  }
  if (group === 'stage7-explanations')
    return (
      !!r.health?.model &&
      r.operation?.status === 'available' &&
      !!r.evidence &&
      (!!r.health.operations?.[r.kind]?.verified ||
        (r.kind === 'comparison' && r.health.explain === true)) &&
      r.downloads === 0
    );
  if (group === 'stage7' && r.name?.startsWith('download'))
    return (
      file.report.pairedProvider === true && !!r.health?.model &&
      r.operations?.some((op) => op.operation === 'intent' && op.status === 'available') &&
      (!r.name.startsWith('downloadVlc') || r.operations.some((op) => op.operation === 'step' && op.status === 'available')) &&
      !!r.finalReview?.selected?.ref &&
      r.finalReview.selection.kind === 'download' &&
      (r.finalReview.steps > 0 ||
        (r.finalReview.steps === 0 && r.finalReview.path === '/download.html' &&
          r.finalReview.selection.profile === 'seven_zip_windows_x64_exe' && r.finalReview.selected.reason === 'publisher_7zip')) &&
      !!r.finalReview.stop &&
      r.fileAttempts === 0 &&
      r.downloads === 0 &&
      Array.isArray(r.manualPageClicks) &&
      (!automatic(r.name) || !r.manualPageClicks.length)
    );
  return false;
}
function caseAnnotation(r, id) {
  if (
    Array.isArray(r.sourceFixtureObservations) &&
    r.sourceFixtureObservations.includes(id) &&
    r.checks?.length
  )
    return {
      status: r.status,
      observation: 'Labelled source fixture: ' + summary(r),
    };
  if (
    Array.isArray(r.caseChecks) &&
    r.caseChecks.includes(id) &&
    r.checks?.length
  )
    return { status: r.status, observation: summary(r) };
  const notes = r.caseChecks?.[id];
  if (
    Array.isArray(notes) &&
    notes.length &&
    notes.every((x) => typeof x === 'string' && x.trim())
  )
    return { status: r.status, observation: notes.join(' ') };
  const item = (Array.isArray(r.caseChecks) ? r.caseChecks : []).find(
    (x) => x?.id === id,
  );
  if (item && statusSet.has(item.status) && item.observation) return item;
  if (Array.isArray(r.caseIds) && r.caseIds.includes(id) && r.checks?.length)
    return { status: r.status, observation: summary(r) };
  return null;
}
function observedProviderBlock(file,r) {
  const op=r.realOperations?.at(-1)??r.diagnostic?.trace?.at(-1)??r.modelTrace?.at(-1);
  return file.group==='stage5' && file.report.provider==='Google Gemini / production SDK' &&
    r.diagnostic?.state==='paused' && r.downloads===0 && !r.attempts && op
    ?providerBlockReason(op,r.diagnostic.message):null;
}
function nativeProof(ctx, tag, id, w) {
  const [prefix, val] = tag.split(':');
  const [group, scenario] = val.split('/');
  const all = ctx.runs
    .flatMap((file) => {
      if (
        file.report?.sha256 !== ctx.sha256 ||
        !/^builder/i.test(file.report.role ?? '') ||
        !file.report.bundle ||
        path.resolve(file.report.bundle) !== path.resolve(ctx.bundle)
      )
        return [];
      if (prefix !== 'c' && file.group !== group) return [];
      return file.rows
        .filter(
          (r) =>
            r.width === w &&
            (prefix === 'c'
              ? caseAnnotation(r, id)
              : normalize(r.name ?? r.site ?? r.kind ?? r.case) === scenario),
        )
        .filter(
          (r) =>
            prefix !== 'l' || (
              (file.group !== 'stage5' || file.report.provider === 'Google Gemini / production SDK') &&
              (file.group !== 'stage7' || file.report.pairedProvider === true)
            ),
        )
        .map((r) => ({
          file,
          r,
          ann: prefix === 'c' ? caseAnnotation(r, id) : null,
        }));
    })
    .sort((a, b) => Date.parse(a.file.at) - Date.parse(b.file.at));
  if (!all.length) return null;
  // A retry can end before the requested panel or build was reached. Preserve that
  // attempt, but only supersede a measured observation with another measured run.
  const eligible = all.filter(({ file, r }) => {
    if (file.historicalOnly || !measured(r, w) || !fs.existsSync(file.path)) return false;
    const installed = r.loaded?.path ?? r.dimensions?.enabledPath;
    if (installed) return path.resolve(installed) === path.resolve(ctx.bundle) && r.loaded?.enabled !== false;
    return !file.group.startsWith('stage7');
  });
  let last = eligible.at(-1);
  let laterBlockedAttempt=null;
  if(last && genuineModelRequirement(tag) &&
    (last.r.status==='blocked'||observedProviderBlock(last.file,last.r))){
    const lastDecisive=eligible.slice(0,-1).findLast(({r,file})=>
      r.status==='pass'||(r.status==='fail'&&!observedProviderBlock(file,r)));
    const verifiedBeforeDeferral=ctx.userDeferral && lastDecisive?.r.status==='pass' &&
      lastDecisive.file.sourceSHA===ctx.userDeferral.sourceSHA &&
      lastDecisive.file.receipt && validateLive(lastDecisive.file.group,lastDecisive.r,lastDecisive.file);
    if(lastDecisive?.r.status==='fail' || verifiedBeforeDeferral){
      laterBlockedAttempt=last.file.path;
      last=lastDecisive;
    }
  }
  const attempts = all.map(({ file, r }) => ({
    path: file.path,
    at: file.at,
    result: r.status ?? r.verdict?.status ?? r.observed ?? 'not_run',
    measured: eligible.some((x) => x.file === file && x.r === r),
    sourceSHA:file.sourceSHA??null,sourceDisposition:file.sourceDisposition??null,
    ...(r.error ? { error: r.error } : {}),
  }));
  if (!last) {
    const { file, r } = all.at(-1);
    return {
      path: file.path, method: 'Chrome setup attempt', width: w,
      height: w === 1440 ? 900 : 768, fingerprint: ctx.sha256,
      attempts, status: !file.historicalOnly && r.status === 'blocked' ? 'blocked' : 'not_run',
      observation: (file.historicalOnly?'Only the superseded service was exercised at this viewport. ':'No attempt confirmed the requested native viewport and installed candidate. ') +
        (r.error ?? 'See the raw attempt.'),
    };
  }
  const { file, r, ann } = last;
  const externalBlock=observedProviderBlock(file,r);
  const failed =
    ann?.status === 'fail' ||
    r.status === 'fail' ||
    r.matched === false ||
    r.verdict?.status === 'fail';
  const evidence = {
    path: file.path,
    method: file.group==='stage7-explanations' && r.kind==='comparison' ? 'installed Chrome, genuine Gemini on labelled comparison evidence' :
      file.group==='stage7-guidance' && r.name==='generic' ? 'installed Chrome, genuine Gemini on labelled public-page fixture' :
      (prefix === 'l' ? 'live ' : '') + 'installed Chrome' + (typeof r.source==='string' && r.source.startsWith('labelled') ? ' · '+r.source : ''),
    width: w,
    height: w === 1440 ? 900 : 768,
    fingerprint: ctx.sha256,
    sourceSHA:file.sourceSHA??null,sourceDisposition:file.sourceDisposition??null,executionReceipt:file.receipt??null,
    attempts,
    ...(laterBlockedAttempt?{laterBlockedAttempt,productRetest:'A subsequent provider block did not complete a retest of the observed '+r.status+' result.'}:{}),
  };
  if (externalBlock) return { ...evidence, status: 'blocked', reason:'observed_provider_response', observation: externalBlock + ' Raw driver status: ' + r.status + '.' };
  if (failed || r.status === 'blocked' || ann?.status === 'blocked')
    return {
      ...evidence,
      status: failed ? 'fail' : 'blocked',
      observation:
        r.error ??
        ann?.observation ??
        r.verdict?.observation ??
        summary(r) ??
        'Scenario failed',
    };
  const result =
    r.status ?? (r.matched && r.observed === 'pass' ? 'pass' : 'not_run');
  if (result !== 'pass') return null;
  if (prefix === 'l' && !validateLive(file.group, r, file)) return null;
  const observation =
    ann?.observation ||
    summary(r) ||
    r.steps?.map((s) => s.name).join(' → ') ||
    r.final?.title ||
    r.operation?.message ||
    r.recoveryStatus ||
    (r.case && r.matched ? 'Observed ' + r.observed + ' in ' + r.case : null);
  if (!observation && file.group !== 'stage7-explanations') return null;
  return {
    ...evidence,
    status: 'pass',
    observation:
      observation ||
      'Genuine ' +
        r.health.model +
        ' returned a validated ' +
        r.kind +
        ' explanation from the current evidence.',
  };
}
function unitProof(ctx, key) {
  const name = unitNames[key];
  const u = ctx.unit;
  if (
    !name ||
    u?.sha256 !== ctx.sha256 ||
    u.exit !== 0 ||
    !fs.existsSync(u.path)
  )
    return null;
  if (
    !fs
      .readFileSync(u.path, 'utf8')
      .split(/\r?\n/)
      .some(
        (l) =>
          l.includes('✔ ' + name) || (/^ok \d+ - /.test(l) && l.includes(name)),
      )
  )
    return null;
  return {
    status: 'pass',
    path: u.path,
    observation: name,
    method: 'development test',
    fingerprint: ctx.sha256,
  };
}
export function stage7CaseMatrix(ctx) {
  const { plan, sha256 } = ctx;
  const inventory = [
    ...plan.acceptance_cases,
    ...(plan.transferred_acceptance_cases ?? []),
  ];
  if (
    inventory.length !== 82 ||
    new Set(inventory.map((x) => x.id)).size !== 82
  )
    throw Error(
      'Original Stage 7 inventory must be fully preserved across active and explicitly transferred cases.',
    );
  return plan.acceptance_cases.map((row) => {
    const needs = stage7EvidenceRequirements[row.id];
    if (!needs) throw Error('Missing evidence map ' + row.id);
    const proof = [],
      missing = [];
    for (const tag of needs) {
      if (/^[nlc]:/.test(tag)) {
        for (const w of [1440, 1366]) {
          const p = nativeProof(ctx, tag, row.id, w);
          if (p) proof.push(p);
          else missing.push(tag + ' ' + w);
          if(ctx.userDeferral && genuineModelRequirement(tag) &&
             (!p||p.status==='not_run'||p.status==='blocked')){
            const d=ctx.userDeferral;
            proof.push({status:'blocked',reason:'user_deferred_gemini_testing',method:'user decision on further Gemini verification',
              path:d.path,fingerprint:ctx.sha256,sourceSHA:d.sourceSHA,provider:d.model,requiredEvidence:tag,
              requiredViewport:{width:w,height:w===1440?900:768},retestExecuted:false,resumption:d.resumption,
              observation:'Further genuine Gemini testing for this requirement and viewport is deferred at the user’s direction. Existing observations and the earlier provider response retain their recorded results.'});
          } else if((!p||p.status==='not_run') && ctx.providerQuota?.status==='active' && genuineModelRequirement(tag)){
            const q=ctx.providerQuota;
            proof.push({status:'blocked',reason:'provider_retry_window',method:'deferred genuine-model requirement',path:q.path,
              fingerprint:ctx.sha256,sourceSHA:q.sourceSHA,executionReceipt:q.executionReceipt,
              requiredEvidence:tag,requiredViewport:{width:w,height:w===1440?900:768},
              journeyExecuted:false,provider:q.model,retryAfter:q.retryAfter,
              observation:'This required journey has no qualifying execution on the current source at this viewport. Google returned a project/model daily-request limit during the separately recorded '+q.observedScenario+' '+q.operation+' request. Its retry window ends '+q.retryAfter+'.'});
          }
        }
      } else {
        const [kind, key] = tag.split(':');
        const p = kind === 'u' ? unitProof(ctx, key) : ctx.records[key];
        if (
          p &&
          statusSet.has(p.status) &&
          p.fingerprint === sha256 &&
          fs.existsSync(p.path) &&
          p.observation
        )
          proof.push(p);
        else missing.push(tag);
      }
    }
    // Supplemental observations must be individually anchored, identify their original role, and
    // describe the actual actions and expectations; a local record cannot substitute for live UI.
    const extra = ctx.supplemental?.[row.id] ?? [];
    for (const e of extra)
      if (
        e.fingerprint === sha256 &&
        statusSet.has(e.status) &&
        e.path &&
        fs.existsSync(e.path) &&
        e.observation
      )
        proof.push(e);
    const status = proof.some((x) => x.status === 'fail')
      ? 'fail'
      : proof.some((x) => x.status === 'blocked')
        ? 'blocked'
        : missing.length || proof.some((x) => x.status !== 'pass')
          ? 'not_run'
          : 'pass';
    return {
      ...row,
      status,
      sha256,
      required_evidence: needs,
      missing,
      evidence: proof,
    };
  });
}
