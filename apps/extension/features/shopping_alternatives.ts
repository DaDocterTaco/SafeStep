import { localModule,planned } from './types';
export default localModule(planned(
  'shopping_alternatives',
  9,
  'Compare better products and sellers',
  'Available comparable options display observed prices, seller and product evidence, reasons for comparison and usable source links.',
),({comparison})=>({supported:!!comparison?.baseline&&['ready','partial','needs_checking','only_baseline','no_matches'].includes(comparison.status),finding:comparison?.message??''}));
