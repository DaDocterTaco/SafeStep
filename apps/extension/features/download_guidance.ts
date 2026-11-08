import { localModule, planned } from './types';
export default localModule(
  planned(
    'download_guidance',
    4,
    'Download button protection',
    'The extension compares inspectable destinations on a supported download page, explains a misleading button, and highlights the intended route.',
  ),
  ({ review, page }) => ({
    supported:
      !!review &&
      review.selection.kind === 'download' &&
      review.binding.documentId === page.context.documentId &&
      review.fileState !== 'unsupported',
    finding: review?.fileState ?? '',
  }),
);
