import { localModule, planned } from './types';
import { explainAddress } from '../sites/address-copy';
export default localModule(
  planned(
    'url_identity',
    2,
    'Website address verification',
    'Expected domains, lookalikes and misleading subdomains produce appropriate findings based on the actual URL.',
  ),
  ({ page, subject }) => ({
    supported:
      !!page.address && subject.kind === 'website_identity' && subject.domain === page.address.host,
    finding: page.address ? explainAddress(page.address) : '',
  }),
);
