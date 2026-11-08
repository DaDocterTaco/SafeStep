import { z } from 'zod';
import { CompareMode, ComparePriority, CompareSettings, uniqueCompareRules, type CompareView } from './comparison.js';
import { safeLabel } from './assist.js';
import { isPublicComparisonText } from './comparison-privacy.js';
const publicGoal = z.string().min(1).max(240).refine(isPublicComparisonText);
const identity = {
  session: z.uuid(),
  version: z.number().int().positive(),
  operationId: z.uuid(),
  bindingToken: z.uuid(),
};
export const CompareFact = z.strictObject({
  id: z.string().regex(/^f\d{1,2}$/),
  candidate: z.string().regex(/^c[0-3]$/),
  text: z.string().min(1).max(500).refine(isPublicComparisonText),
});
export const CompareAIInput = z.discriminatedUnion('kind', [
  z.strictObject({
    ...identity,
    kind: z.literal('intent'),
    settings: CompareSettings,
    goal: publicGoal,
  }),
  z.strictObject({
    ...identity,
    kind: z.literal('explain'),
    facts: z
      .array(CompareFact)
      .min(1)
      .max(18)
      .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length),
  }),
]);
export type CompareAIInput = z.infer<typeof CompareAIInput>;
const field = z.enum([
  'platform',
  'feature',
  'model',
  'edition',
  'condition',
  'nib',
  'format',
  'color',
  'size',
  'delivery',
  'brand',
  'accessories',
  'category',
  'version',
  'quantity',
  'purpose',
]);
export const CompareInterpretation = z.strictObject({
  mode: CompareMode,
  rules: z.array(z.strictObject({ field, value: publicGoal, exclude: z.boolean() })).max(12),
  allowed: z.array(field).max(10),
  priorities: z.array(ComparePriority).min(1).max(5),
  question: z.string().max(160).refine(safeLabel),
});
export const CompareSelection = z.strictObject({
  selected: z
    .array(z.strictObject({ candidate: CompareFact.shape.candidate, fact: CompareFact.shape.id }))
    .min(1)
    .max(4),
});
// Lock explicitly named platforms and excluded feature/variant values to their
// source text. The model can add supported rules, but cannot erase these.
function negativeClauses(goal: string) {
  return Array.from(goal.matchAll(/\b(?:exclude|excluding|without|avoid|not)\s+/gi), match => {
    const start = match.index! + match[0].length;
    const text = goal.slice(start).split(/[.;!?]|\b(?:but|prefer|instead|budget|(?:and\s+)?(?:require|must|need to|exclude|avoid|without|not))\b/i)[0]!.replace(/[\s,]+$/,'');
    return { text, start, end: start + text.length };
  }).filter(clause=>clause.text && !/^\s*(?:require[ds]?|need)\b/i.test(clause.text));
}
function preferenceMention(goal:string, index:number) {
  const clause=goal.slice(0,index).split(/[.,;!?]|\b(?:but|must|require(?:d)?|only|exclude|without)\b/i).at(-1) ?? '';
  return /\b(?:prefer|preferably|nice[- ]to[- ]have|ideally)\b/i.test(clause);
}
const namedAttributes=[
  {field:'condition',re:/\b(new|used|refurbished|mint)\b/gi},
  {field:'nib',re:/\b(extra[- ]fine|fine|medium|broad)(?= nib\b)/gi},
  {field:'edition',re:/\b(first|second|third|revised|limited) edition\b/gi},
  {field:'color',re:/\b(black|white|blue|green|red|brown|silver|gold|purple)\b/gi},
  {field:'format',re:/\b(hardcover|paperback|ebook)\b/gi},
] as const;
function namedRules(goal:string){
  return namedAttributes.flatMap(({field,re})=>Array.from(goal.matchAll(re),m=>{
    const before=goal.slice(0,m.index!).split(/[.,;!?]/).at(-1)??'',
      after=goal.slice(m.index!+m[0].length).split(/[.,;!?]/)[0]??'';
    return {field,value:m[0],at:m.index!,required:/\b(?:must(?: be| have)?|requires?|only)\b(?:\s+(?:an?|the))?\s*$/i.test(before)||
      /^(?:\s+nib)?\s+(?:(?:is|are)\s+)?required\b/i.test(after)};
  }));
}
type CompareRule = z.infer<typeof CompareInterpretation>['rules'][number];
function requirementText(text:string) {
  return text.trim().replace(/^(?:have|include|support|be)\s+/i,'').replace(/^(?:an?|the)\s+/i,'').replace(/^["“]([^"”]+)["”]$/u,'$1').trim();
}
function requiredRule(value:string):CompareRule {
  const known=namedRules(value).find(x=>[x.value,x.value+' '+x.field].some(v=>v.toLowerCase()===value.toLowerCase()));
  if(known)return {field:known.field,value:known.value,exclude:false};
  const platform=/^(Firefox|Chrome|Android|Windows|Linux|macOS)(?:\s+(?:support|compatibility))?$/i.exec(value);
  return {field:platform?'platform':'feature',value:platform?.[1]??value,exclude:false};
}
// Keep the user's literal requirement when the available sources have no typed attribute for it.
// A disjunction needs clarification because the comparison engine evaluates its rules together.
function mandatoryClauses(goal:string) {
  const rules:CompareRule[]=[];
  let choice:string|undefined;
  for(const m of goal.matchAll(/\b(?:must\s+(?:have|support|include|be)|require|requires)\s+/gi)) {
    const prefix=goal.slice(0,m.index!);
    if(/\b(?:not|never|don['’]t|doesn['’]t)\s+(?:(?:I|we|they|it)\s+)?$/i.test(prefix))continue;
    const clause=goal.slice(m.index!+m[0].length).split(/[.;!?]|\b(?:but|while|prefer|ideally|budget|without|avoid|exclud(?:e|ing)|(?:and\s+)?(?:must|require|not))\b/i)[0]!.replace(/[\s,]+$/,'');
    if(!clause || /^not\b/i.test(clause))continue;
    if(/\bor\b/i.test(clause)){choice??=clause;continue;}
    for(const part of clause.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)){
      const value=requirementText(part);
      if(value)rules.push(requiredRule(value));
    }
  }
  return {rules,choice};
}
export function explicitCompareRules(goal: string): z.infer<typeof CompareInterpretation>['rules'] {
  const rules: z.infer<typeof CompareInterpretation>['rules'] = [];
  const negatives = negativeClauses(goal);
  for (const m of goal.matchAll(/\b(?:Firefox|Chrome|Android|Windows|Linux|macOS)\b/gi)) {
    if(preferenceMention(goal,m.index!))continue;
    rules.push({
      field: 'platform',
      value: m[0],
      exclude: negatives.some(q => q.start <= m.index! && m.index! + m[0].length <= q.end),
    });
  }
  for(const x of namedRules(goal))
    if(x.required && !preferenceMention(goal,x.at) && !negatives.some(n=>n.start<=x.at&&x.at<n.end))
      rules.push({field:x.field,value:x.value,exclude:false});
  rules.push(...mandatoryClauses(goal).rules);
  for (const {text:clause} of negatives)
    for (const value of clause
      .split(/\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+/i)
      .map(requirementText)
      .filter(Boolean)) {
      if (rules.some((x) => x.exclude && x.value.toLowerCase() === value.toLowerCase())) continue;
      const typed = /^(.+?)\s+(nib|version|edition|model|format|color|size|condition)s?$/i.exec(
        value,
      );
      const known = requiredRule(value);
      rules.push({
        field: known.field!=='feature' ? known.field : typed
          ? (typed[2]!.toLowerCase() as
              'nib' | 'version' | 'edition' | 'model' | 'format' | 'color' | 'size' | 'condition')
          : 'feature',
        value: known.field!=='feature' ? known.value : typed ? typed[1]! : value,
        exclude: true,
      });
    }
  return uniqueCompareRules(rules);
}
export const CompareAIReply = z.strictObject({
  ...identity,
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
  explanation: z.union([CompareInterpretation, CompareSelection]).nullable(),
  elapsedMs: z.number().nonnegative(),
  tokens: z.number().nonnegative().nullable(),
});
export type CompareAIReply = z.infer<typeof CompareAIReply>;
export function compareFacts(v: CompareView) {
  const facts: z.infer<typeof CompareFact>[] = [];
  v.candidates.forEach((c, n) => {
    for (const t of [
      ...c.reasons.slice(0, 2),
      ...c.tradeoffs.slice(0, 2),
      ...c.matched.slice(0, 1),
    ])
      if (t && safeLabel(t))
        facts.push({ id: 'f' + (facts.length + 1), candidate: 'c' + (n + 1), text: t });
  });
  if (safeLabel(v.message) && v.message)
    facts.push({ id: 'f' + (facts.length + 1), candidate: 'c0', text: v.message });
  return facts;
}
function budgetInGoal(goal: string) {
  const m =
    /(?:under|below|budget(?: of)?|at most|up to|maximum(?: of)?)\s*(?:([a-z]{3})\s*|([$€£])\s*)?(\d+(?:\.\d+)?)(?:\s*([A-Z]{3})\b)?/i.exec(
      goal,
    );
  if (!m) return undefined;
  const code = (m[1] ?? m[4] ?? (m[2] === '€' ? 'EUR' : m[2] === '£' ? 'GBP' : '')).toUpperCase();
  const basis = /subtotal|total|including shipping|with shipping/i.test(goal)
    ? 'subtotal'
    : /item[ -]price|before shipping/i.test(goal)
      ? 'item'
      : null;
  if (!/^[A-Z]{3}$/.test(code) || !Intl.supportedValuesOf('currency').includes(code) || !basis)
    return null;
  return { amount: m[3]!, currency: code, basis } as const;
}
export function comparisonFromWords(settings:CompareSettings,goal:string):CompareSettings {
  const budget=budgetInGoal(goal);
  const platforms=Array.from(goal.matchAll(/\b(?:Firefox|Chrome|Android|Windows|Linux|macOS)\b/gi),m=>({field:'platform',value:m[0],at:m.index!}));
  const preferred=[...(settings.preferred??[])];
  for(const x of [...platforms,...namedRules(goal)])if(preferenceMention(goal,x.at)&&
    !preferred.some(p=>p.field===x.field&&p.value.toLowerCase()===x.value.toLowerCase())&&preferred.length<8)
    preferred.push({field:x.field,value:x.value});
  const quantity=/\b(?:quantity(?: of)?|pack of)\s+(\d{1,5})\b/i.exec(goal);
  const costFirst=/\b(?:cheaper|lower (?:price|cost)|lowest (?:price|cost)|least expensive)\b/i.test(goal);
  return {...settings,goal,hard:uniqueCompareRules([...settings.hard,...explicitCompareRules(goal)]),
    ...(preferred.length?{preferred}:{}),budget:settings.budget??budget??null,
    quantity:quantity && Number(quantity[1])>=1 && Number(quantity[1])<=10000?Number(quantity[1]):settings.quantity,
    priorities:costFirst?['cost',...settings.priorities.filter(p=>p!=='cost')]:settings.priorities};
}
export function comparisonQuestion(settings:CompareSettings):string|null{
  const mandatory=mandatoryClauses(settings.goal);
  if(mandatory.choice)return 'Which single requirement should apply, or do you want separate comparisons? Your goal allows “'+mandatory.choice+'”.';
  const missing=mandatory.rules.find(r=>!settings.hard.some(h=>!h.exclude && h.field.toLowerCase()===r.field.toLowerCase() && h.value.toLowerCase()===r.value.toLowerCase()));
  if(missing)return 'Your goal requires “'+missing.value+'”. Add the requirement to the reviewed search or clarify your goal before finding options.';
  const stated=budgetInGoal(settings.goal);
  if(stated===null&&!settings.budget)return 'Which currency and price basis should the budget use: item price or subtotal with shipping?';
  if(stated&&!settings.budget)return 'Your goal names a budget. Add its amount, currency and price basis to the reviewed requirements or edit the goal.';
  const amount=(s:string)=>s.includes('.')?s.replace(/0+$/,'').replace(/\.$/,''):s;
  if(stated && settings.budget && (stated.currency!==settings.budget.currency || stated.basis!==settings.budget.basis || amount(stated.amount)!==amount(settings.budget.amount)))
    return 'The budget in the goal differs from the reviewed budget. Which amount, currency and price basis should apply?';
  if(/\b(?:same|keep|preserve)\b[^.!?;]{0,28}\brequired features\b/i.test(settings.goal)&&
     !settings.hard.some(r=>!r.exclude && ['feature','model','edition','variant','nib','platform'].includes(r.field)))
    return 'Which features must stay the same? Add those as required attributes before searching.';
  return null;
}
export function validatedComparisonAI(raw: unknown, i: CompareAIInput) {
  if (i.kind === 'explain') {
    const p = CompareSelection.safeParse(raw);
    if (
      !p.success ||
      new Set(p.data.selected.map((s) => s.fact)).size !== p.data.selected.length ||
      p.data.selected.some(
        (s) => !i.facts.some((f) => f.id === s.fact && f.candidate === s.candidate),
      )
    )
      return null;
    return p.data;
  }
  const p = CompareInterpretation.safeParse(raw);
  if (!p.success || i.goal !== i.settings.goal) return null;
  const d = p.data,
    g = i.goal.toLowerCase();
  const exclusions = negativeClauses(g);
  function hasSignedMention(value: string, excluded: boolean) {
    const term=value.trim().toLowerCase();
    if (!term) return false;
    for (let at=g.indexOf(term); at!==-1; at=g.indexOf(term,at+term.length)) {
      const left=g[at-1]??'',right=g[at+term.length]??'';
      if((left && /[\p{L}\p{N}]/u.test(left))||(right && /[\p{L}\p{N}]/u.test(right)))continue;
      if (!preferenceMention(g,at) && exclusions.some(s => s.start <= at && at + term.length <= s.end) === excluded) return true;
    }
    return false;
  }
  if (
    d.rules.some(r => !hasSignedMention(r.value,r.exclude))
  )
    return null;
  if (
    !d.question &&
    (exclusions.some(s => !d.rules.some(r => r.exclude && s.text.includes(r.value.toLowerCase()))) ||
      explicitCompareRules(i.goal).some(anchor =>
        !d.rules.some(r => r.field===anchor.field && r.exclude===anchor.exclude &&
          r.value.toLowerCase()===anchor.value.toLowerCase())) ||
      (/\bsimilar\b/.test(g) && d.mode !== 'similar_products') ||
      (/\bsame product\b/.test(g) && d.mode !== 'same_product_other_sellers') ||
      comparisonQuestion({...comparisonFromWords(i.settings,i.goal),hard:uniqueCompareRules([...i.settings.hard,...d.rules])})!==null)
  )
    return null;
  if (
    d.allowed.some((f) => !g.includes(f.toLowerCase()) && !(f === 'model' && /\bsimilar\b/.test(g)))
  )
    return null;
  return {...d,rules:uniqueCompareRules(d.rules)};
}
export function applyComparisonIntent(
  s: CompareSettings,
  d: z.infer<typeof CompareInterpretation>,
) {
  const stated=comparisonFromWords(s,s.goal);
  const hard = uniqueCompareRules([...s.hard,...d.rules]);
  const budget = budgetInGoal(s.goal);
  if (s.budget && budget && comparisonQuestion(s)?.startsWith('The budget'))
    throw Error(
      'The stated budget differs from your current requirement. Clarify it before discovery.',
    );
  return CompareSettings.parse({
    ...stated,
    mode: d.mode,
    hard,
    quantity: stated.quantity,
    budget: budget ?? s.budget,
    allowedDifferences: [...new Set([...s.allowedDifferences, ...d.allowed])],
    // Existing user order is authoritative. Only an explicitly requested cheaper
    // item or an explicit priority can reorder the existing local criteria.
    priorities:(/\b(?:prioriti[sz]e|most important|matters most|priority)\b/i.test(s.goal)
      ? [...new Set([...d.priorities,...stated.priorities])].slice(0,5):stated.priorities),
  });
}
