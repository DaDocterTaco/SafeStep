import {
  Fault,
  FeatureResult,
  Providers,
  providerSubject,
  type Health,
  type Lookup,
  type ProviderId,
  type Subject,
} from '@safestep/contracts';

const specs = {
  intent: ['GEMINI_API_KEY', 'visual_guidance'],
  url_threat: ['WEB_RISK_API_KEY', 'site_trust'],
  website_reputation: ['TRUSTPILOT_API_KEY', 'site_trust'],
  seller_feedback: ['MARKETPLACE_SELLER_TOKEN', 'seller_assessment'],
  product_feedback: ['PRODUCT_REVIEWS_TOKEN', 'product_assessment'],
  shopping_comparison: ['MARKETPLACE_BROWSE_TOKEN', 'shopping_alternatives'],
} as const;
// Only a connector implemented on the server may turn a normalized subject into a fixed upstream request.
export interface Provider {
  id: ProviderId;
  // A threat connector opts in only for a confirmed positive match with its provider expiry.
  positiveThreatExpiry?: (result: FeatureResult) => number | null;
  lookup(
    subject: Subject,
    options: { credential: string; signal: AbortSignal },
  ): Promise<FeatureResult>;
}
export class ProvidersService {
  private cache = new Map<string, { until: number; result: FeatureResult }>();
  private credentials = new Map<ProviderId, string>();
  private connectors = new Map<ProviderId, Provider>();
  constructor(env: NodeJS.ProcessEnv, connectors: Provider[] = []) {
    for (const id of Providers) {
      const value = env[specs[id][0]]?.trim();
      if (value) this.credentials.set(id, value);
    }
    for (const connector of connectors) this.connectors.set(connector.id, connector);
  }
  readiness(): Health {
    return {
      service: 'safestep-local',
      version: 1,
      providers: Providers.map((provider) => ({
        provider,
        credentialPresent: this.credentials.has(provider),
        status: !this.credentials.has(provider)
          ? 'not_configured'
          : !this.connectors.has(provider)
            ? 'connector_unavailable'
            : 'ready',
      })),
    };
  }
  async lookup(input: Lookup, client: AbortSignal) {
    const { provider, subject } = input,
      featureId = specs[provider][1],
      key = JSON.stringify(input);
    const missing = (code: 'provider_not_configured' | 'provider_unavailable' | 'timeout') => ({
      provider,
      code,
      result: {
        featureId,
        subject,
        availability: 'unavailable' as const,
        finding: 'No verified finding.',
        explanation:
          code === 'provider_not_configured'
            ? 'The source is not configured.'
            : code === 'timeout'
              ? 'The source did not respond in time.'
              : 'An authorized connector or usable response is unavailable.',
        evidence: [],
        limitations: ['No source coverage was established.'],
        nextStep: 'Check access and identity before using this source.',
      },
    });
    const credential = this.credentials.get(provider),
      connector = this.connectors.get(provider);
    if (!credential) return missing('provider_not_configured');
    if (!connector) return missing('provider_unavailable');
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return { provider, code: null, result: hit.result };
    const signal = AbortSignal.any([client, AbortSignal.timeout(3500)]);
    try {
      signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Fault('timeout')), { once: true }),
      );
      const raw = await Promise.race([connector.lookup(subject, { credential, signal }), aborted]);
      const r = FeatureResult.parse(raw);
      if (
        r.featureId !== featureId ||
        r.subject.kind !== providerSubject[provider] ||
        JSON.stringify(r.subject) !== JSON.stringify(subject) ||
        !r.evidence.length ||
        !['available', 'partial'].includes(r.availability)
      )
        return missing('provider_unavailable');
      if (
        !r.evidence.some((e) => ['available', 'partial'].includes(e.availability)) ||
        r.evidence.some(
          (e) =>
            Date.parse(e.retrievedAt) > Date.now() + 30000 ||
            (e.expiresAt && Date.parse(e.expiresAt) <= Date.now()),
        )
      )
        return missing('provider_unavailable');
      const policyExpiry =
        provider === 'url_threat' ? (connector.positiveThreatExpiry?.(r) ?? 0) : Date.now() + 60000;
      const expiry = Math.min(
        policyExpiry,
        ...r.evidence.map((e) => (e.expiresAt ? Date.parse(e.expiresAt) : Date.now())),
      );
      if (expiry > Date.now()) {
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { until: expiry, result: r });
      }
      return { provider, code: null, result: r };
    } catch {
      return missing(signal.aborted ? 'timeout' : 'provider_unavailable');
    }
  }
}
