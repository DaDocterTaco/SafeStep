import { z } from 'zod';
import { ShoppingKind, type ShoppingData, type ShopRecord } from './shopping.js';

export function publicExcerpt(raw: unknown) {
  if (typeof raw !== 'string') return '';
  const text = raw.slice(0, 800).replace(/\s+/g, ' ').trim();
  // A passage containing contact, private routing or address data can be omitted in full.
  if (
    /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+|@[a-z0-9_]+|(?:\d[\s().+-]*){5,}|<[^>]*>|\bprivate_|\b(?:address|postal|zip code|tracking number|order number)\b|\b\d+\s+\w+(?:\s+\w+){0,2}\s+(?:st(?:reet)?|ave(?:nue)?|road|lane|drive)\b)/i.test(
      text,
    )
  )
    return '';
  return text.slice(0, 400);
}
export function textGroup(r: ShopRecord) {
  return r.text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const sellerRules = {
  delivery: [
    /\b(fast|quick|prompt|on time|early|speedy)\b.{0,28}\b(ship|deliver|dispatch|arriv)|\b(ship|deliver|dispatch|arriv)\w*.{0,20}\b(fast|quickly|promptly|on time|early)\b/i,
    /\b(late|slow|delayed|missing)\b.{0,25}\b(delivery|shipping|package)|\b(arrived|delivery|shipping)\b.{0,15}\b(late|slow|delayed)\b/i,
  ],
  packaging: [
    /\b(well|carefully|securely|nicely|safely)\s+(packed|packaged|wrapped)|\b(great|excellent|secure) packaging/i,
    /\b(poor|damaged|bad|flimsy) packaging|poorly (wrapped|packed)/i,
  ],
  accuracy: [
    /\b(exactly |just )?as described|matched the description/i,
    /\bmisdescribed\b|different from the description/i,
  ],
  communication: [
    /\b(clear|great|prompt|good) communication|responded quickly/i,
    /\b(poor|bad|slow) communication|unanswered messages/i,
  ],
  returns: [
    /\b(easy|prompt|quick) (return|refund)/i,
    /\b(refund|return) (refused|denied|delayed)|refused (a |the )?refund/i,
  ],
  'item condition': [
    /\b(?:arrived|received) (?:the item )?(?:in )?(?:excellent|good|perfect) condition\b/i,
    /\b(?:arrived|received) (?:the item )?(?:damaged|broken|in poor condition)\b/i,
  ],
};
const productRules = {
  quality: [
    /\b(well made|solid build|durable|excellent quality|high quality)\b/i,
    /\b(flimsy|poor quality|breaks easily)\b/i,
  ],
  usability: [
    /\b(easy to use|easy to read|clear instructions|intuitive)\b/i,
    /\b(hard to use|hard to read|confusing interface)\b/i,
  ],
  performance: [
    /\b(works great|works well|fast performance|blocks ads|runs smoothly)\b/i,
    /\b(crashes|keeps freezing|slow performance|stopped working)\b/i,
  ],
  content: [
    /\b(well written|engaging story|great story|clear prose)\b/i,
    /\b(repetitive story|confusing plot|poorly written)\b/i,
  ],
  compatibility: [
    /\b(?:compatible with|works (?:well )?(?:with|on)) (?:Firefox|Windows|Linux|macOS|Android)\b/i,
    /\b(?:incompatible with|unsupported (?:on|by)) (?:Firefox|Windows|Linux|macOS|Android)\b/i,
  ],
  durability: [
    /\b(?:long[- ]lasting|still works after|held up (?:well|for))\b/i,
    /\b(?:broke after|wore out|failed after|stopped working after)\b/i,
  ],
};
export type Theme = { label: string; tone: 'strength' | 'concern'; ids: string[] };
export function shoppingThemes(kind: ShoppingKind, records: ShopRecord[]): Theme[] {
  const rules = kind === 'seller' ? sellerRules : productRules;
  const groups = new Map<string, { id: string; text: string }>();
  for (const r of records) {
    if (
      !r.text ||
      r.automated ||
      (kind === 'seller') !== (r.channel === 'seller_received_feedback')
    )
      continue;
    const group = textGroup(r);
    if (group && !groups.has(group)) groups.set(group, { id: r.id, text: r.text });
  }
  const themes: Theme[] = [];
  for (const [label, patterns] of Object.entries(rules)) {
    const hits: [string[], string[]] = [[], []];
    for (const { id, text } of groups.values()) {
      const parts = text
        .normalize('NFKC')
        .replace(/[’‘ʼ]/g, "'")
        .split(/[.!?;]/)
        .filter(
          (p) =>
            !/\b(no|not|never|hardly|\w+n't|cannot|but|however)\b/i.test(p) &&
            (kind !== 'product' ||
              !/\b(shipping|seller|dispatch|delivery|packaging|refund|used copy)\b/i.test(p)),
        );
      const matched = patterns.map((regex: RegExp) => parts.some((p) => regex.test(p)));
      if (matched[0] !== matched[1]) hits[matched[0] ? 0 : 1].push(id);
    }
    for (const [i, ids] of hits.entries())
      if (ids.length) themes.push({ label, tone: i === 0 ? 'strength' : 'concern', ids });
  }
  return themes;
}
/** Local sample groupings describe the inspected records, never a source rating period. */
export function shoppingInsights(d: ShoppingData, request = '') {
  const themes = shoppingThemes(d.kind,d.records);
  const written = d.records.filter(r=>r.text && !r.automated);
  const unique = new Set(written.map(textGroup)).size;
  const recent: string[] = [], older: string[] = [], undated: string[] = [];
  const captured = Date.parse(d.captured);
  for(const r of d.records) {
    const when = r.published && ['instant','date'].includes(r.precision) ? Date.parse(r.published) : NaN;
    if (!Number.isFinite(when) || when > captured) undated.push(r.id);
    else (captured - when <= 90 * 86400000 ? recent : older).push(r.id);
  }
  const mixed = themes.filter(t=>t.tone==='strength' && themes.some(other=>other.label===t.label&&other.tone==='concern')).map(t=>t.label);
  const versions=d.kind==='product' && d.context.variant ? {
    same:d.records.filter(r=>r.version===d.context.variant).map(r=>r.id),
    other:d.records.filter(r=>r.version!==null&&r.version!==d.context.variant).map(r=>r.id),
    unstated:d.records.filter(r=>!r.version).map(r=>r.id),
  } : null;
  let requirement: string | null=null;
  if(d.kind==='product' && /\b(?:compatib\w*|support\w*|works? (?:on|with)|for Firefox)\b/i.test(request)){
    if(d.context.market==='mozilla' && d.context.format==='Firefox add-on' && d.context.catalog && d.source && /\bFirefox\b/i.test(request))
      requirement='Mozilla identifies this exact catalogue product as a Firefox add-on. Compatibility with a particular Firefox release, another browser, operating system or device is unconfirmed here.';
    else requirement='This source does not establish the requested compatibility for this item or version.';
  }
  const topics = [
    {name:'durability',when:/\b(?:durable|durability|long[- ]lasting|wear|lasting)\b/i},
    {name:'usability',when:/\b(?:usability|easy to use|ease of use|hard to use|intuitive)\b/i},
    {name:'performance',when:/\b(?:performance|crashes|blocks? ads|ad blocking|freezing)\b/i},
    {name:'quality',when:/\b(?:build quality|well made|quality)\b/i},
  ];
  const onlyCurrent=/\b(?:current|selected|this) (?:version|edition)\b/i.test(request);
  const textScope=onlyCurrent?'reviews naming the selected version or edition':'the inspected product reviews';
  const eligible=onlyCurrent ? d.records.filter(r=>d.context.variant && r.version===d.context.variant):d.records;
  const relevantThemes=d.kind==='product'&&onlyCurrent?shoppingThemes('product',eligible):themes;
  const requested=d.kind==='product'?topics.filter(t=>t.when.test(request)).map(t=>({
    label:t.name,scope:textScope,
    strengths:relevantThemes.find(x=>x.label===t.name&&x.tone==='strength')?.ids??[],
    concerns:relevantThemes.find(x=>x.label===t.name&&x.tone==='concern')?.ids??[],
  })):[];
  const conditionLimit=d.kind==='product' && /\b(?:condition|damage|wear)\b/i.test(request) && d.context.listing
    ? 'The listing reports '+(d.context.condition?'the condition as '+d.context.condition:'no condition')+'. Catalog reviews cannot verify the condition of this individual item.' : null;
  return {themes,unique,repeated:written.length-unique,recent,older,undated,mixed,versions,requirement,requested,conditionLimit};
}
export const ShopAIInput = z
  .strictObject({
    operationId: z.uuid(),
    bindingToken: z.uuid(),
    kind: ShoppingKind,
    scope:z.strictObject({
      market:z.enum(['resell','mozilla','practice','unsupported']),
      channel:z.enum(['seller_account','catalog_versions','listing']),
      captured:z.iso.datetime(), datedRecent:z.number().int().min(0).max(20),
      datedOlder:z.number().int().min(0).max(20), dateUnknown:z.number().int().min(0).max(20),
      versionMatch:z.number().int().min(0).max(20).nullable(),
    }).optional(),
    evidence: z
      .array(
        z.strictObject({
          id: z.string().regex(/^r(?:[1-9]|1[0-9]|20)$/),
          channel: z.enum([
            'seller_received_feedback',
            'catalog_product_review',
            'listing_product_review',
          ]),
          group: z.number().int().min(1).max(20),
          themes: z
            .array(
              z.enum([
                'delivery',
                'packaging',
                'accuracy',
                'communication',
                'returns',
                'item condition',
                'quality',
                'usability',
                'performance',
                'content',
                'compatibility',
                'durability',
              ]),
            )
            .max(8),
          tone: z.enum(['strength', 'concern', 'mixed', 'unclassified']),
          automated: z.boolean(),
        }),
      )
      .max(20),
    coverage: z.enum(['sparse', 'bounded', 'empty']),
  })
  .superRefine((r, c) => {
    const rules = r.kind === 'seller' ? sellerRules : productRules;
    if(r.scope && ((r.kind==='seller')!==(r.scope.channel==='seller_account') ||
       r.scope.datedRecent+r.scope.datedOlder+r.scope.dateUnknown!==r.evidence.length ||
       (r.scope.versionMatch!==null && (r.scope.versionMatch>r.evidence.length || r.kind==='seller'))))
      c.addIssue({code:'custom',message:'Sample coverage is inconsistent with the evidence'});
    if (
      new Set(r.evidence.map((e) => e.id)).size !== r.evidence.length ||
      (r.coverage === 'empty') !== (r.evidence.length === 0) ||
      r.evidence.some(
        (e) =>
          (r.kind === 'seller') !== (e.channel === 'seller_received_feedback') ||
          e.themes.some((t) => !(t in rules)) ||
          (e.automated && e.themes.length),
      )
    )
      c.addIssue({ code: 'custom', message: 'Wrong evidence channel' });
  });
export type ShopAIInput = z.infer<typeof ShopAIInput>;
export function shoppingInput(d: ShoppingData): ShopAIInput {
  const insights=shoppingInsights(d);
  const groups = new Map<string, number>();
  const evidence = d.records.map((r) => {
    const g = textGroup(r) || r.id;
    if (!groups.has(g)) groups.set(g, groups.size + 1);
    const t = shoppingThemes(d.kind, [r]),
      tones = new Set(t.map((x) => x.tone));
    return {
      id: r.id,
      channel: r.channel,
      group: groups.get(g)!,
      themes: t.map((x) => x.label),
      tone: tones.size > 1 ? 'mixed' : (t[0]?.tone ?? 'unclassified'),
      automated: r.automated,
    };
  });
  return ShopAIInput.parse({
    operationId: d.binding.operationId,
    bindingToken: d.binding.revision,
    kind: d.kind,
    scope:{market:d.context.market,channel:d.kind==='seller'?'seller_account':d.context.catalog?'catalog_versions':'listing',
      captured:d.captured,datedRecent:insights.recent.length,datedOlder:insights.older.length,dateUnknown:insights.undated.length,
      versionMatch:insights.versions?.same.length??null},
    evidence,
    coverage:
      d.records.length === 0 ? 'empty' : d.status === 'reviews_available' ? 'bounded' : 'sparse',
  });
}
const point = z.strictObject({
  theme: z.string().max(32),
  ids: z.array(z.string().max(3)).min(1).max(3),
});
export const ShoppingExplanation = z.strictObject({
  summary: z.string().max(150),
  strengths: z.array(point).max(3),
  concerns: z.array(point).max(3),
  limit: z.string().max(160),
});
export function shoppingChoices(i: ShopAIInput) {
  const summary =
    i.coverage === 'empty'
      ? 'No written feedback was available in this view.'
      : i.coverage === 'sparse'
        ? 'Only a small sample supports this summary.'
        : 'This summary describes the inspected sample.';
  const limit =
    i.kind === 'seller'
      ? 'Service feedback applies to this seller and the observed transactions.'
      : 'Product feedback applies to the catalog or edition shown by its source.';
  const options = (tone: 'strength' | 'concern') => {
    const themes = new Map<string, Map<number, string>>();
    for (const e of i.evidence)
      if (!e.automated && e.tone === tone)
        for (const theme of e.themes) {
          const groups = themes.get(theme) ?? new Map<number, string>();
          if (!groups.has(e.group)) groups.set(e.group, e.id);
          themes.set(theme, groups);
        }
    return [...themes].map(([theme, g]) => ({ theme, ids: [...g.values()].slice(0, 3) }));
  };
  return { summary, limit, strengths: options('strength'), concerns: options('concern') };
}
export function validatedShoppingExplanation(raw: unknown, input: ShopAIInput) {
  const r = ShoppingExplanation.safeParse(raw);
  if (!r.success) return null;
  const d = r.data,
    choices = shoppingChoices(input);
  if (d.summary !== choices.summary || d.limit !== choices.limit) return null;
  for (const k of ['strengths', 'concerns'] as const) {
    if (
      new Set(d[k].map((p) => p.theme)).size !== d[k].length ||
      d[k].some(
        (p) =>
          !choices[k].some(
            (q) =>
              p.theme === q.theme &&
              p.ids.length === q.ids.length &&
              p.ids.every((id, n) => id === q.ids[n]),
          ),
      )
    )
      return null;
  }
  return d;
}
export const ShopAIReply = z
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
    explanation: ShoppingExplanation.nullable(),
    elapsedMs: z.number().nonnegative().int(),
    tokens: z.number().nonnegative().int().nullable(),
  })
  .refine((x) => (x.status === 'available') === !!x.explanation);
