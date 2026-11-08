import { planned,localModule } from './types';
export default localModule(planned(
  'page_cleanup',
  8,
  'Hide distracting ads and popups',
  'A toggle hides identified distractions on a supported page and a restore action returns them without breaking essential controls.',
),({page,cleanup})=>({supported:!!cleanup&&cleanup.binding.documentId===page.context.documentId&&cleanup.binding.tabId===page.context.tabId,finding:cleanup?cleanup.hidden+' regions hidden on this document.':''}));
