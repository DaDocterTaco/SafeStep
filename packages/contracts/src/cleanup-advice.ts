import { z } from 'zod';

export const CleanupReason = z.enum(['advertisement', 'promotion', 'promo_pair']);
type Reason=z.infer<typeof CleanupReason>;
/** A model can narrow this set, never reintroduce a class the user excluded. */
export function cleanupScope(goal:string){
  const text=goal.toLowerCase().replace(/[’‘]/g,"'");
  const all:Reason[]=['advertisement','promotion','promo_pair'];
  const classes=(s:string):Reason[]=>[
    ...(/\bads?\b|\badvert(?:isement|ising)s?\b|\bsponsored\b/.test(s)?['advertisement' as const]:[]),
    ...(/\bpromo(?:tion)?s?\b|\bpromotional\b/.test(s)?['promotion' as const,'promo_pair' as const]:[]),
    ...(/\bbanners?\b/.test(s)?['promotion' as const]:[]),
    ...(/\bpop[ -]?ups?\b|\bdialogs?\b/.test(s)?['promo_pair' as const]:[]),
  ];
  const kept=new Set<Reason>();
  let unclear=false,hasKeep=false;
  const rest=text.replace(/\b(?:keep|preserve|leave|except|excluding|never (?:hide|remove)|do not (?:hide|remove)|don't (?:hide|remove)|without (?:hiding|removing)|not)\s+([^.;!?]+?)(?=[.;!?]|,|\bbut\b|\bwhile\s+(?:hiding|removing)\b|\band\s+(?:hide|remove|keep|leave)\b|$)/g,(_whole,clause:string)=>{
    hasKeep=true;
    const named=classes(clause);
    for(const x of named)kept.add(x);
    if(/\b(?:anything|everything|all content)\b/.test(clause))all.forEach(x=>kept.add(x));
    else if(!named.length&&!/\b(?:forms?|warnings?|consent|seller|reviews?|navigation|privacy|checkout|payment)\b/.test(clause))unclear=true;
    return ' ';
  });
  const positive=new Set(classes(rest));
  const restricted=!!positive.size||hasKeep;
  const general=/\b(?:clean(?:up)?|clear|tidi?y|distractions?|clutter)\b/.test(rest);
  const allowed=unclear || (hasKeep && !general && !positive.size) ? [] :
    all.filter(k=>(!positive.size||positive.has(k))&&!kept.has(k));
  return {allowed,restricted,unclear};
}
export const CleanupSignal = z.enum([
  'labelled_advertisement',
  'publisher_ad_frame',
  'labelled_sponsored',
  'labelled_promotion',
  'recognized_banner',
  'recognized_popup_pair',
]);
export const CleanupSelection = z
  .strictObject({
    operationId: z.uuid(),
    revision: z.uuid(),
    ids: z.array(z.uuid()).min(1).max(30),
  })
  .refine((s) => new Set(s.ids).size === s.ids.length, 'Duplicate cleanup selection');
export const cleanupDescriptions: Record<z.infer<typeof CleanupSignal>, string> = {
  labelled_advertisement: 'Region explicitly marked as an advertisement',
  publisher_ad_frame: 'Publisher-labelled advertisement containing a separately hosted ad frame',
  labelled_sponsored: 'Region explicitly marked as sponsored content',
  labelled_promotion: 'Sidebar explicitly marked as a promotion',
  recognized_banner: 'Marked promotional banner',
  recognized_popup_pair: 'Recognized practice promotion and its paired backdrop',
};
export const CleanAdviceInput = z
  .strictObject({
    operationId: z.uuid(),
    bindingToken: z.uuid(),
    candidates: z
      .array(z.strictObject({ id: z.uuid(), reason: CleanupReason, signal: CleanupSignal }))
      .min(1)
      .max(30),
  })
  .refine(
    (i) =>
      new Set(i.candidates.map((c) => c.id)).size === i.candidates.length &&
      i.candidates.every(
        (c) =>
          (c.reason === 'advertisement' &&
            ['labelled_advertisement', 'labelled_sponsored', 'publisher_ad_frame'].includes(c.signal)) ||
          (c.reason === 'promotion' &&
            ['labelled_promotion', 'recognized_banner'].includes(c.signal)) ||
          (c.reason === 'promo_pair' && c.signal === 'recognized_popup_pair'),
      ),
    'Invalid cleanup candidate facts',
  );
export type CleanAdviceInput = z.infer<typeof CleanAdviceInput>;
export const CleanAdvice = z.strictObject({
  regions: z
    .array(z.strictObject({ id: z.uuid(), choice: z.enum(['offer_hide', 'keep_visible']) }))
    .min(1)
    .max(30),
});
export function checkedCleanAdvice(raw: unknown, input: CleanAdviceInput) {
  const out = CleanAdvice.safeParse(raw);
  if (
    !out.success ||
    out.data.regions.length !== input.candidates.length ||
    new Set(out.data.regions.map((r) => r.id)).size !== input.candidates.length ||
    out.data.regions.some((r) => !input.candidates.some((c) => c.id === r.id))
  )
    return null;
  return out.data;
}
export const CleanAdviceReply = z
  .strictObject({
    operationId: z.uuid(),
    bindingToken: z.uuid(),
    status: z.enum([
      'available',
      'not_configured',
      'unauthorized',
      'rate_limited',
      'timeout',
      'unavailable',
      'invalid_response',
      'cancelled',
    ]),
    explanation: CleanAdvice.nullable(),
    elapsedMs: z.number().nonnegative(),
    tokens: z.number().nonnegative().nullable(),
  })
  .refine((r) => (r.status === 'available') === !!r.explanation);
