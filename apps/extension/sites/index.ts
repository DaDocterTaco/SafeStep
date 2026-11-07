import type { SiteAdapter, FeatureKey } from '../features/types';
import { workflows, workflowIds } from './profiles';
export const adapters: readonly SiteAdapter[] = workflowIds.map((id) => ({
  id,
  supports: (origin, feature) =>
    origin === 'https://' + workflows[id].host &&
    (feature === 'visual_guidance' || feature === 'url_identity'),
}));
export function adapterFor(origin: string, feature: FeatureKey) {
  return adapters.find((a) => a.supports(origin, feature));
}
