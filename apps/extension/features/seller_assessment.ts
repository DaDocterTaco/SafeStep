import { planned } from './types';
import { shoppingModule } from './shopping-module';
export default shoppingModule(
  planned(
    'seller_assessment',
    5,
    'Seller reputation checks',
    'A supported seller page yields an evidence-linked summary of seller feedback, history and other listings, with identity and coverage clear.',
  ),
  'seller',
);
