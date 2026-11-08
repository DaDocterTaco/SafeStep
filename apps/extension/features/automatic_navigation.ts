import { planned,localModule } from './types';
export default localModule(planned(
  'automatic_navigation',
  7,
  'Automatic task navigation',
  'A user-approved supported navigation task runs in the existing session, with progress, pause and cancel, stopping for any consequential final action.',
),({page,task})=>({supported:!!task?.adaptive&&task.mode==='automatic'&&task.tabId===page.context.tabId&&task.documentId===page.context.documentId,finding:task?.adaptive?.status??''}));
