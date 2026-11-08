import { z } from 'zod';
import { FileProfile, Signal, signalText, type ReviewData } from './review.js';
import { activeThreat, threatCategories, type ThreatReply } from './threat.js';
const eid = z.string().regex(/^e(?:[1-9]|1[0-6])$/);
const item = z.strictObject({ id: eid, code: z.union([Signal,z.literal('url_lookup')]) });
const urlFact=z.strictObject({
  scope:z.enum(['page','root']),
  status:z.enum(['match','no_match']),
  categories:z.array(z.enum(threatCategories)).max(3),
}).refine(x=>x.status==='match'?x.categories.length>0:x.categories.length===0);
const compactCandidate = z.strictObject({ id: z.uuid(), reason: Signal });
export const ExplanationInput = z
  .strictObject({
    operationId: z.uuid(),
    bindingToken: z.uuid(),
    kind: z.enum(['website', 'download']),
    profile: FileProfile.nullable(),
    platform: z.literal('Windows').nullable(),
    architecture: z.literal('x64').nullable(),
    selected: compactCandidate.nullable(),
    alternatives: z.array(compactCandidate).max(2),
    evidence: z.array(item).min(1).max(12),
    reviewCoverage: z.enum(['unavailable', 'fixture']),
    threatCoverage: z.enum(['unavailable', 'fixture','source']),
    urlLookup:urlFact.optional(),
    limited: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (
      (r.threatCoverage==='source')!==!!r.urlLookup ||
      r.evidence.filter(e=>e.code==='url_lookup').length!==(r.urlLookup?1:0) ||
      new Set(r.evidence.map((e) => e.id)).size !== r.evidence.length ||
      (r.kind === 'website'
        ? !!(r.profile || r.platform || r.architecture || r.selected || r.alternatives.length)
        : !(r.profile && r.platform && r.architecture))
    )
      ctx.addIssue({ code: 'custom', message: 'Conflicting evidence context' });
  });
export type ExplanationInput = z.infer<typeof ExplanationInput>;
export function explanationInput(d: ReviewData, receipt?:ThreatReply): ExplanationInput {
  const candidates = d.candidates.map((c) => ({ id: c.ref, reason: c.reason }));
  const present=receipt && (activeThreat(receipt) || receipt.status==='no_match');
  const evidence:ExplanationInput['evidence']=d.observations.slice(0,present?11:12).map(({id,code})=>({id,code}));
  if(present){
    const id=Array.from({length:16},(_,i)=>'e'+(i+1)).find(id=>!evidence.some(e=>e.id===id))!;
    evidence.push({id,code:'url_lookup'});
  }
  return ExplanationInput.parse({
    operationId: d.binding.operationId,
    bindingToken: d.binding.revision,
    kind: d.selection.kind,
    profile: d.selection.kind === 'download' ? d.selection.profile : null,
    platform: d.selection.kind === 'download' ? 'Windows' : null,
    architecture: d.selection.kind === 'download' ? 'x64' : null,
    selected: candidates.find((c) => c.id === d.selected) ?? null,
    alternatives: candidates.filter((c) => c.id !== d.selected).slice(0, 2),
    evidence,
    reviewCoverage: d.sources[0].source === 'labelled_fixture' ? 'fixture' : 'unavailable',
    threatCoverage: present?'source':d.sources[1].source === 'labelled_fixture' ? 'fixture' : 'unavailable',
    ...(present?{urlLookup:{scope:receipt.scope,status:receipt.status,categories:receipt.categories}}:{}),
    limited: d.limited || d.frames,
  });
}
export const Explanation = z.strictObject({
  summary: z.string().min(1).max(480),
  reasons: z
    .array(z.strictObject({ evidenceId: eid, text: z.string().min(1).max(200) }))
    .min(1)
    .max(3),
  nextStep: z.string().min(1).max(180),
  coverageLimits: z.array(z.string().min(1).max(160)).min(1).max(3),
});
export type Explanation = z.infer<typeof Explanation>;
export function explanationChoices(r: ExplanationInput) {
  const download = r.kind === 'download';
  const summary = download
    ? r.selected
      ? 'A publisher-linked control was identified for the selected Windows package.'
      : 'The requested package has no confirmed unique control.'
    : 'This check describes observations from the current website.';
  const gloss: Partial<Record<keyof typeof signalText, string>> = {
    label_mismatch:
      'Compare the displayed website with the link’s actual host before following it.',
    urgent_dialog:
      'The dialog pairs a device warning with a demand to act. You can review the request before doing anything.',
    sponsored:
      'The page labels this option as advertising. Its placement alone does not identify the publisher.',
    publisher_vlc:
      'The Windows package matches the version shown on the VLC page and the specified VideoLAN distributor.',
    publisher_7zip:
      'The installer belongs to the current Windows x64 EXE row and the matching ip7z/7zip release.',
    publisher_winscp: 'The current WinSCP release, package label and publisher-hosted filename agree.',
    other_option: 'Another control points to a different option from the package you selected.',
    unknown_link: 'A static address is unavailable for this control.',
    http: 'This HTTP connection does not encrypt traffic between the browser and website.',
    wrong_destination:
      'The host or package path fails the publisher rule for the selected product.',
    self_claim: 'The review claim comes from the inspected page itself.',
  };
  const reasons = r.evidence.flatMap((e) => {
    if(e.code==='url_lookup' && r.urlLookup) {
      const scope=r.urlLookup.scope==='root'?'this homepage':'the checked URL';
      const terms={MALWARE:'malware',SOCIAL_ENGINEERING:'phishing',UNWANTED_SOFTWARE:'unwanted software'};
      const fact=r.urlLookup.status==='match'?'Google Web Risk reported possible '+r.urlLookup.categories.map(c=>terms[c]).join(' and ')+' for '+scope+'.':
        'Google Web Risk returned no listing for '+scope+' at the time of the check.';
      return [{evidenceId:e.id,text:fact}];
    }
    if(e.code==='url_lookup')return [];
    return [signalText[e.code], gloss[e.code]]
      .filter((x): x is string => !!x)
      .map((text) => ({ evidenceId: e.id, text }));
  });
  return {
    summary,
    summaries: [summary, ...reasons.map((x) => x.text)],
    nextStep: download
      ? r.selected
        ? 'Review the indicated control and its destination.'
        : 'Inspect the candidates again after checking the page and package.'
      : 'Review the observations and their source coverage.',
    limits: download
      ? [
          'Later redirects and file contents were not checked.',
          'Only the visible candidates in this check were compared.',
        ]
      : [
          'Local observations cannot establish overall website safety.',
          'Outside review and threat coverage are shown separately.',
        ],
    reasons,
  };
}
export function validatedExplanation(raw: unknown, r: ExplanationInput) {
  const parsed = Explanation.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data,
    choices = explanationChoices(r);
  if (
    !choices.summaries.includes(a.summary) ||
    a.nextStep !== choices.nextStep ||
    a.coverageLimits.some((l) => !choices.limits.includes(l)) ||
    new Set(a.reasons.map((e) => e.evidenceId)).size !== a.reasons.length ||
    a.reasons.some(
      (e) => !choices.reasons.some((c) => c.evidenceId === e.evidenceId && c.text === e.text),
    )
  )
    return null;
  return a;
}
export const GenerationLimit = z.enum(['minute', 'session', 'busy', 'provider']);
export const generationLimitMessage = (why: z.infer<typeof GenerationLimit>) => ({
  minute: 'Six AI requests in one minute. Wait a minute, then try once.',
  session: 'This local AI process used its 30 requests. Waiting a minute will not reset it. You can take over.',
  busy: 'Another AI request is still in progress. Wait for it to finish.',
  provider: 'Gemini reported a provider quota limit. Local controls are still available.',
})[why];
export const ExplainStatus = z.enum([
  'available',
  'not_configured',
  'unauthorized',
  'rate_limited',
  'timeout',
  'unavailable',
  'invalid_response',
  'cancelled',
]);
export type ExplainStatus = z.infer<typeof ExplainStatus>;
export const ExplainReply = z
  .strictObject({
    operationId: z.uuid(),
    bindingToken: z.uuid(),
    status: ExplainStatus,
    explanation: Explanation.nullable(),
    elapsedMs: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative().nullable(),
  })
  .refine((r) => (r.status === 'available') === !!r.explanation);
export const ExplainHealth = z.strictObject({
  provider: z.literal('Gemini'),
  model: z.string().max(80).nullable(),
  credentialPresent: z.boolean(),
  state: z.enum(['not_configured', 'configured_unverified', 'verified_this_session']),
  connected: z.boolean(),
});
