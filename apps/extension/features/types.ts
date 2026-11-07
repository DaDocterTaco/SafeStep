import { FeatureResult, type Features, type PageSnapshot, type Subject } from '@safestep/contracts';
export type FeatureKey = (typeof Features)[number];
export interface FeatureInput {
  page: PageSnapshot;
  subject: Subject;
}
export interface SiteAdapter {
  id: string;
  supports(origin: string, feature: FeatureKey): boolean;
}
export interface FeatureModule {
  id: FeatureKey;
  rank: number;
  name: string;
  delivery: string;
  status: 'unimplemented' | 'implemented';
  run(input: FeatureInput, adapter?: SiteAdapter): FeatureResult;
}
export function localModule(
  base: FeatureModule,
  result: (input: FeatureInput) => { supported: boolean; finding: string },
): FeatureModule {
  return {
    ...base,
    status: 'implemented',
    run(input, adapter) {
      const r = result(input);
      const supported =
        r.supported && (!adapter || adapter.supports(input.page.context.origin, base.id));
      return FeatureResult.parse({
        featureId: base.id,
        subject: input.subject,
        availability: supported ? 'available' : 'unsupported',
        finding: supported ? r.finding : 'No supported local observation for this page.',
        explanation: base.delivery,
        evidence: [],
        limitations: [
          'This is a local observation of the current document. No external provider or safety verdict.',
        ],
        nextStep: 'View the current step or address details in SafeStep.',
      });
    },
  };
}
export function planned(
  id: FeatureKey,
  rank: number,
  name: string,
  delivery: string,
): FeatureModule {
  return {
    id,
    rank,
    name,
    delivery,
    status: 'unimplemented',
    run({ page, subject }, adapter) {
      const unsupported = !!adapter && !adapter.supports(page.context.origin, id);
      return FeatureResult.parse({
        featureId: id,
        subject,
        availability: unsupported ? 'unsupported' : 'unimplemented',
        finding: unsupported
          ? 'This site has no supported workflow.'
          : 'This feature has not been built.',
        explanation: delivery,
        evidence: [],
        limitations: ['No assessment or action was performed.'],
        nextStep: 'Use the page inspector for a manual highlight.',
      });
    },
  };
}
