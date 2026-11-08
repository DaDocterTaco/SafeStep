import { localModule, planned } from './types';
import { workflows } from '../sites/profiles';
export default localModule(
  planned(
    'visual_guidance',
    1,
    'Visual task assistant',
    'A user states a supported goal and follows accurate, sequential highlights across the task, including a settings-navigation example.',
  ),
  ({ page,task }) => ({
    supported: !!page.guide && page.guide.result !== 'unsupported'||!!task?.adaptive&&task.documentId===page.context.documentId&&task.tabId===page.context.tabId,
    finding: page.guide ? workflows[page.guide.workflow].name + ': ' + page.guide.result : task?.adaptive?.status??'',
  }),
);
