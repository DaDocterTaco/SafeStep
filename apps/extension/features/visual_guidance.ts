import { localModule, planned } from './types';
import { workflows } from '../sites/profiles';
export default localModule(
  planned(
    'visual_guidance',
    1,
    'Visual task assistant',
    'A user states a supported goal and follows accurate, sequential highlights across the task, including a settings-navigation example.',
  ),
  ({ page }) => ({
    supported: !!page.guide && page.guide.result !== 'unsupported',
    finding: page.guide ? workflows[page.guide.workflow].name + ': ' + page.guide.result : '',
  }),
);
