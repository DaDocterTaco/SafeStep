import { AsyncLocalStorage } from 'node:async_hooks';

export const providerOperation = new AsyncLocalStorage();
export function providerBlockReason(operation, panelMessage) {
  if (operation.status === 'rate_limited' && operation.upstream?.http === 429 &&
      operation.upstream.code === 'RESOURCE_EXHAUSTED' &&
      ['AI request limit reached. Retry later.', 'Gemini reported a provider quota limit. Local controls are still available.'].includes(panelMessage)) {
    return 'Google returned HTTP 429 RESOURCE_EXHAUSTED for this paused operation.';
  }
  if (operation.status === 'unavailable' && operation.upstream?.http === 503 &&
      panelMessage === 'AI service unavailable. Retry or take over.') {
    return 'Google returned HTTP 503 for this paused operation.';
  }
  return null;
}
export function quotaDetails(error) {
  const violations = [];
  let retryDelay = null;
  const metric = /^generativelanguage\.googleapis\.com\/generate_content_(?:(?:free|paid)_tier_)?(?:requests|request_count|input_token_count|output_token_count|token_count)$/;
  const id = /^Generate(?:Content)?(?:Requests|InputTokens?|OutputTokens?|Tokens?|Calls)(?:Per(?:Minute|Day|Hour|Second|Project|Model|User|Region|Location)){1,6}(?:-(?:FreeTier|PaidTier))?$/;
  for (const detail of Array.isArray(error?.details) ? error.details.slice(0, 12) : []) {
    if (detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' &&
        typeof detail.retryDelay === 'string' && /^\d{1,7}(?:\.\d{1,9})?s$/.test(detail.retryDelay)) {
      retryDelay = detail.retryDelay;
    }
    if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.QuotaFailure' ||
        !Array.isArray(detail.violations)) continue;
    for (const item of detail.violations.slice(0, 6)) {
      const quotaMetric = typeof item?.quotaMetric === 'string' && metric.test(item.quotaMetric)
        ? item.quotaMetric : null;
      const quotaId = typeof item?.quotaId === 'string' && id.test(item.quotaId) ? item.quotaId : null;
      const window = quotaId?.match(/Per(Day|Hour|Minute|Second)/)?.[1]?.toLowerCase() ?? null;
      if (quotaMetric || quotaId) violations.push({ quotaMetric, quotaId, window });
    }
  }
  return { violations, retryDelay };
}
export function sentProviderMenu(raw) {
  try {
    const body = JSON.parse(raw);
    const pageRequest = JSON.parse(body.contents[0].parts[0].text);
    const { page, eligible, lookupTerms } = pageRequest;
    const ids = (records) =>
      new Set(records.map((item) => item.ref).filter((id) => /^r[1-9]\d*$/.test(id)));
    return {
      eligible: ids(eligible),
      citations: ids([...page.controls, ...page.headings]),
      terms: new Set(lookupTerms),
    };
  } catch {
    return null;
  }
}
export function providerProposal(value, menu) {
  return {
    kind: [
      'next_candidate',
      'completion_candidate',
      'need_more_controls',
      'clarify',
      'cannot_continue',
    ].includes(value.kind)
      ? value.kind
      : null,
    reason: ['missing_target', 'unsupported', 'manual_action_required', 'unclear_goal'].includes(
      value.reason,
    )
      ? value.reason
      : null,
    known_ref: menu && typeof value.ref === 'string' ? menu.eligible.has(value.ref) : null,
    known_citations:
      menu && Array.isArray(value.citations)
        ? value.citations.length > 0 && value.citations.every((id) => menu.citations.has(id))
        : null,
    terms:
      Array.isArray(value.terms) && menu
        ? value.terms
            .filter((term) => menu.terms.has(term) && /^[\p{L}\p{N} _.-]{1,65}$/u.test(term))
            .slice(0, 3)
        : undefined,
  };
}
