import { FeatureResult, type ShoppingData, type Subject } from '@safestep/contracts';
import type { FeatureModule } from './types';
export function shoppingEvidence(d: ShoppingData, subject: Subject) {
  const source =
    d.context.market === 'resell'
      ? 'Resell.store'
      : d.context.market === 'mozilla'
        ? 'Mozilla Add-ons'
        : 'Practice';
  return d.records
    .slice(0, 16)
    .map((r) => ({
      id: r.id,
      subject,
      source,
      sourceUrl: d.context.market === 'practice' ? null : d.source,
      retrievedAt: d.captured,
      expiresAt: new Date(Date.parse(d.captured) + 300000).toISOString(),
      freshness: 'Five-minute current-view capture',
      availability: 'partial' as const,
      finding: (r.text || 'No readable text in this record.').slice(0, 320),
      coverage: d.scope,
    }));
}
export function shoppingModule(base: FeatureModule, kind: 'seller' | 'product'): FeatureModule {
  return {
    ...base,
    status: 'implemented',
    run({ page, subject, shopping: d }) {
      const id = kind === 'seller' ? d?.context.seller : (d?.context.catalog ?? d?.context.listing);
      const expectedMarket =
        d?.context.market === 'resell'
          ? 'resell.store'
          : d?.context.market === 'mozilla'
            ? 'addons.mozilla.org'
            : null;
      const match =
        !!d &&
        d.kind === kind &&
        d.binding.documentId === page.context.documentId &&
        d.binding.tabId === page.context.tabId &&
        d.binding.origin === page.context.origin &&
        (subject.kind === 'seller_reputation' || subject.kind === 'product_feedback') &&
        subject.kind === (kind === 'seller' ? 'seller_reputation' : 'product_feedback') &&
        id === subject.publicId &&
        subject.market === expectedMarket;
      return FeatureResult.parse({
        featureId: base.id,
        subject,
        availability: match ? 'partial' : 'unsupported',
        finding: match ? d.status.replaceAll('_', ' ') : 'No matching public shopping source.',
        explanation: base.delivery,
        evidence: match ? shoppingEvidence(d, subject) : [],
        limitations: [match ? d.scope : 'A matching public seller or product is required.'],
        nextStep: 'Review the evidence and its capture time.',
      });
    },
  };
}
