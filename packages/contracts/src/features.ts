import { z } from 'zod';

export const Features = [
  'visual_guidance',
  'url_identity',
  'site_trust',
  'download_guidance',
  'seller_assessment',
  'product_assessment',
  'automatic_navigation',
  'page_cleanup',
  'shopping_alternatives',
] as const;
export const FeatureId = z.enum(Features);
export type FeatureId = z.infer<typeof FeatureId>;
