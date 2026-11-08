import { localModule, planned } from './types';
export default localModule(
  planned(
    'site_trust',
    3,
    'Website trust popup',
    'A supported website displays a trust summary using local findings and available external evidence, with sources and an explicit missing-data state.',
  ),
  ({ review, page, subject }) => ({
    supported:
      !!review &&
      review.selection.kind === 'website' &&
      review.binding.documentId === page.context.documentId &&
      subject.kind === 'website_risk' &&
      subject.domain === review.address.host,
    finding: review?.status.replaceAll('_', ' ') ?? '',
  }),
);
