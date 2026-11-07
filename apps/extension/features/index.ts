import visual_guidance from './visual_guidance';
import url_identity from './url_identity';
import site_trust from './site_trust';
import download_guidance from './download_guidance';
import seller_assessment from './seller_assessment';
import product_assessment from './product_assessment';
import automatic_navigation from './automatic_navigation';
import page_cleanup from './page_cleanup';
import shopping_alternatives from './shopping_alternatives';
export const registry = [
  visual_guidance,
  url_identity,
  site_trust,
  download_guidance,
  seller_assessment,
  product_assessment,
  automatic_navigation,
  page_cleanup,
  shopping_alternatives,
] as const;
