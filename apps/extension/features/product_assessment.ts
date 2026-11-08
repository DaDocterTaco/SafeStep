import { planned } from './types';
import { shoppingModule } from './shopping-module';
export default shoppingModule(
  planned(
    'product_assessment',
    6,
    'Product review checks',
    'A supported product page yields a summary of product-specific reviews and recurring concerns, separated from seller findings.',
  ),
  'product',
);
