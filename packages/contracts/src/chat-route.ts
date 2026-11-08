import { z } from 'zod';
import { FeatureId } from './features.js';
import { FileProfile, isWinSCP } from './review.js';
import { winSCPRequest } from './winscp.js';
import { CompareMode } from './comparison.js';
import { publicPath, profileForPage, shareablePathShape } from './assist.js';
import { isPublicComparisonText } from './comparison-privacy.js';
import {
  mozillaReviewScope,
  resellStorefrontAccount,
  resellStorefrontRoute,
} from './source-scope.js';
import { ExplainStatus, GenerationLimit } from './explanation.js';

export const chatRouteVersion = 1 as const;
const subjectRef = z.string().regex(/^s[1-8]$/);
export function safeChatText(value: string) {
  return (
    value.trim().length > 0 &&
    isPublicComparisonText(value) &&
    !/\b(?:cookies?|set-cookie|authorization|session[_-]?token)\s*[:=]\s*\S/i.test(value)
  );
}
const safe = (max: number) => z.string().min(1).max(max).refine(safeChatText);
const subjectKind = z.enum(['site', 'seller', 'product', 'offer', 'comparison', 'goal']);
const subject = z.strictObject({ ref: subjectRef, kind: subjectKind, label: safe(100) });
const mode = z.enum(['guide', 'automatic']).nullable();

// Only declared practice pages may send loopback context. Public URL queries and
// fragments never enter the model input, including on supported review filters.
export function chatRouteSite(raw: string): { origin: string; path: string | null } | null {
  if (raw.length > 2048 || !URL.canParse(raw)) return null;
  const u = new URL(raw);
  if (u.username || u.password) return null;
  const fixture =
    u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (fixture) {
    const guidePath = publicPath(u, profileForPage(u));
    if (guidePath !== null) return { origin: u.origin, path: guidePath.split('#')[0]! };
    const localEvidence =
      /^\/(?:trust-lab|shopping-lab\/(?:listing|product|seller|amazon-us)|comparison-lab\/(?:original|better|lower|alternative))\/?$/;
    return !u.search && !u.hash && localEvidence.test(u.pathname)
      ? { origin: u.origin, path: u.pathname }
      : null;
  }
  if (
    u.protocol !== 'https:' ||
    u.port ||
    /^(?:login|auth|accounts?|mail|admin|internal|intranet|banking)\./i.test(u.hostname)
  )
    return null;
  if (
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(u.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|arpa|home|lan|corp)$/i.test(
      u.hostname,
    )
  )
    return null;
  const canonical = new URL(u.href);
  if (canonical.hash === '#review-sample-start') canonical.hash = '';
  if (mozillaReviewScope(canonical)) return { origin: u.origin, path: u.pathname };
  if (resellStorefrontAccount(u)) {
    if (u.search || u.hash || !resellStorefrontRoute(u)) return null;
    const slug = u.pathname.replace(/^\/|\/$/g, '');
    if (
      /(?:^|-)(?:user|users|account|private|password|apikey|token|cookie|session|secret|bearer|confirm|order|cart|checkout|billing|payment|admin|auth|login|logout)(?:-|$)/i.test(
        slug,
      ) ||
      /(?:^|-)\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b(?:-|$)|[a-f0-9]{16,}/i.test(
        slug,
      )
    )
      return null;
    if (shareablePathShape(u, 'experimental') !== null) return { origin: u.origin, path: u.pathname };
    // A descriptive public listing name may trip the generic opaque-segment
    // guard. Never transmit that name. Check its segments against the same
    // private/control-path policy, then expose only the storefront origin.
    const words = slug.split('-');
    if (words.length < 2 || words.some((word) => !/^(?:[a-z]{1,18}|[0-9]{1,4})$/.test(word)))
      return null;
    const split = new URL(u);
    split.pathname = '/' + words.join('/');
    if (shareablePathShape(split, 'experimental') === null) return null;
    return { origin: u.origin, path: null };
  }
  const path = publicPath(u, profileForPage(u));
  if (path === null) return null;
  return { origin: u.origin, path: path.split('#')[0]! };
}

const site = z
  .strictObject({ origin: z.string().max(260), path: z.string().min(1).max(220).nullable() })
  .refine((s) => {
    const normalized = chatRouteSite(s.origin + (s.path ?? '/'));
    return normalized?.origin === s.origin && (s.path === null || s.path === normalized.path);
  });
export const ChatRouteInput = z.strictObject({
  version: z.literal(chatRouteVersion),
  operationId: z.uuid(),
  bindingToken: z.uuid(),
  conversationId: z.uuid(),
  turnId: z.uuid(),
  contextKey: z.uuid(),
  text: safe(240),
  history: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), text: safe(240) }))
    .max(6)
    .refine((xs) => xs.reduce((sum, x) => sum + x.text.length, 0) <= 1600),
  site,
  subjects: z
    .array(subject)
    .max(8)
    .refine((xs) => new Set(xs.map((s) => s.ref)).size === xs.length),
  available: z
    .array(FeatureId)
    .max(9)
    .refine((xs) => new Set(xs).size === xs.length),
  mode,
});
export type ChatRouteInput = z.infer<typeof ChatRouteInput>;

const refSlots = z.strictObject({ subjectRef: subjectRef.nullable() });
const emptySlots = z.strictObject({});
const routed = <F extends FeatureId, S extends z.ZodType>(feature: F, slots: S) =>
  z.strictObject({
    kind: z.literal('routed'),
    feature: z.literal(feature),
    reason: safe(160),
    slots,
  });
const Routed = z.discriminatedUnion('feature', [
  routed('visual_guidance', refSlots),
  routed('url_identity', z.strictObject({ expected: z.literal('amazon.com').nullable() })),
  routed('site_trust', emptySlots),
  routed('download_guidance', z.strictObject({ profile: FileProfile.nullable() })),
  routed('seller_assessment', refSlots),
  routed('product_assessment', refSlots),
  routed('automatic_navigation', refSlots),
  routed('page_cleanup', emptySlots),
  routed(
    'shopping_alternatives',
    z.strictObject({ subjectRef: subjectRef.nullable(), mode: CompareMode.nullable() }),
  ),
]);
export const ChatRouteDecision = z.union([
  Routed,
  z.strictObject({
    kind: z.literal('clarify'),
    question: safe(160),
    choices: z.array(safe(80)).max(3),
  }),
  z.strictObject({
    kind: z.literal('unsupported'),
    reason: safe(160),
    suggestions: z.array(FeatureId).max(3),
  }),
]);
export type ChatRouteDecision = z.infer<typeof ChatRouteDecision>;

// A URL path, article title or prior unrelated user turn is not a merchant
// expectation. The extension evaluates the actual hostname independently.
export function chatExpectsAmazon(text: string) {
  const words = text
    .replace(/https?:\/\/[^\s<>]+/gi, ' ')
    .replace(/\b(?:not|without|except|excluding|exclude|ignore|skip|avoid)\s+(?:an?\s+|the\s+)?amazon(?:\.com)?\b/gi, ' ')
    .replace(/\b(?:do not|don['’]t|never)\s+(?:check|expect|compare|match|assume)\b[^,;!?]{0,45}\bamazon(?:\.com)?\b/gi, ' ');
  return /\b(?:expect(?:ed|ing)?|against|match(?:es)?|on|from|for|belongs? to|points? to|go(?:es)? to)\s+(?:the\s+|an?\s+)?(?:official\s+)?amazon(?:\.com)?\b/i.test(words) ||
    /\b(?:is|check|verify)\s+(?:(?:this|that|it|the|really|actually|an?|official|site|address|domain|link|website)\s+){0,5}amazon(?:\.com)?\b/i.test(words) ||
    /\bamazon(?:\.com)?\s+(?:us\s+)?(?:address|link|domain|website|site|url)\b/i.test(words);
}

export function validatedChatRoute(raw: unknown, input: ChatRouteInput): ChatRouteDecision | null {
  const parsed = ChatRouteDecision.safeParse(raw);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (result.kind === 'clarify')
    return new Set(result.choices).size === result.choices.length ? result : null;
  if (result.kind === 'unsupported') {
    return result.suggestions.every((f) => input.available.includes(f)) &&
      new Set(result.suggestions).size === result.suggestions.length
      ? result
      : null;
  }
  if (!input.available.includes(result.feature)) return null;
  if ('subjectRef' in result.slots && result.slots.subjectRef) {
    const selectedRef = result.slots.subjectRef;
    const current = input.subjects.find((s) => s.ref === selectedRef);
    const permitted =
      result.feature === 'seller_assessment'
        ? ['seller', 'offer']
        : result.feature === 'product_assessment'
          ? ['product', 'offer']
          : result.feature === 'shopping_alternatives'
            ? ['product', 'offer', 'comparison']
            : ['goal', 'site'];
    if (!current || !permitted.includes(current.kind)) return null;
  }
  // Package picks must be supported by user-supplied product terms. A picked
  // profile never provides permission for a file, platform, or architecture.
  if (result.feature === 'download_guidance' && result.slots.profile) {
    if (isWinSCP(result.slots.profile)) {
      if (input.site.origin !== 'https://winscp.net' || winSCPRequest(input.text) !== result.slots.profile) return null;
    } else {
    const product =
      result.slots.profile === 'vlc_windows_x64' ? /\b(?:vlc|videolan)\b/i : /\b7[ -]?zip\b/i;
    const words = input.text.toLowerCase();
    // A package hint represents the complete Windows x64 EXE profile. A vague
    // request must still go through the existing package chooser.
    if (
      !product.test(words) ||
      !/\b(?:windows|win64)\b/.test(words) ||
      !/\b(?:x64|win64|64[ -]?bit)\b/.test(words) ||
      /\b(?:not|never|without|exclude|avoid|macos|linux|arm|arm64|x86|32[ -]?bit|portable|msi)\b/.test(
        words,
      )
    )
      return null;
    }
  }
  if (result.feature === 'url_identity' && result.slots.expected && !chatExpectsAmazon(input.text)) {
    const previous = [...input.history].reverse().find((t) => t.role === 'user' && t.text !== input.text);
    if (!previous || !/\b(?:that (?:site|domain|address)|same (?:site|domain|address)|again)\b/i.test(input.text) ||
        !chatExpectsAmazon(previous.text)) return null;
  }
  if (
    result.feature === 'automatic_navigation' &&
    /\b(?:not|never|without|avoid|don't|do not)\s+(?:use\s+|start\s+)?(?:automatic(?:ally)?|auto(?:mated)?\b|tak(?:e|ing) me)/i.test(
      input.text,
    )
  )
    return null;
  if (result.feature === 'shopping_alternatives') {
    const negative =
      input.text.match(
        /\b(?:not|never|without|except|exclude|excluding|avoid|instead of)\s+[^,;.!?—]+/gi,
      ) ?? [];
    let positive = input.text;
    for (const clause of negative) positive = positive.replace(clause, ' ');
    const modes: [z.infer<typeof CompareMode>, RegExp][] = [
      ['compare_selected', /\b(?:compare selected|selected (?:offers?|items?|listings?))\b/i],
      ['similar_products', /\b(?:similar|different) (?:products?|models?|items?)\b/i],
      ['same_product_other_sellers', /\b(?:the )?same (?:item|product|edition|model)\b/i],
    ];
    for (const [value, words] of modes) {
      if (words.test(positive) && result.slots.mode !== value) return null;
      if (result.slots.mode === value && negative.some((clause) => words.test(clause))) return null;
    }
  }
  return result;
}

export const ChatRouteReply = z
  .strictObject({
    operationId: z.uuid(),
    bindingToken: z.uuid(),
    status: ExplainStatus,
      limitReason: GenerationLimit.optional(),
    decision: ChatRouteDecision.nullable(),
    elapsedMs: z.number().nonnegative(),
    tokens: z.number().nonnegative().nullable(),
  })
  .refine((r) => (r.status === 'available') === (r.decision !== null) && (!r.limitReason || r.status === 'rate_limited'));
export type ChatRouteReply = z.infer<typeof ChatRouteReply>;
export const ChatRouteHealth = z.strictObject({
  provider: z.literal('Gemini'),
  model: z.string().max(80).nullable(),
  configured: z.boolean(),
  verified: z.boolean(),
  lastStatus: ExplainStatus.nullable(),
  perMinute: z.literal(6),
  perSession: z.literal(30),
});
export type ChatRouteHealth = z.infer<typeof ChatRouteHealth>;
