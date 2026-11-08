import type { WorkflowId } from '@safestep/contracts';
export const workflows: Record<
  WorkflowId,
  {
    host: string;
    name: string;
    goal: string;
    steps: readonly string[];
    done: string;
    start: string;
  }
> = {
  wikipedia_cite_apa: {
    host: 'en.wikipedia.org',
    name: 'Wikipedia · APA citation',
    goal: 'Help me find the APA citation for this article.',
    steps: [
      'Open Tools on the Phishing article.',
      'Choose Cite this page in the Tools menu.',
      'Choose APA to jump to the citation.',
    ],
    done: 'The APA citation for Phishing is visible.',
    start: 'https://en.wikipedia.org/wiki/Phishing',
  },
  videolan_windows_page: {
    host: 'www.videolan.org',
    name: 'VideoLAN · VLC for Windows',
    goal: 'Help me find VLC for Windows.',
    steps: [
      'Open the VLC menu.',
      'Choose Download in the VLC menu.',
      'Choose Windows under Official Downloads.',
    ],
    done: 'You reached the VLC for Windows page. No installer is needed for this task.',
    start: 'https://www.videolan.org/',
  },
};
export const workflowIds = Object.keys(workflows) as WorkflowId[];
export function fixedGuideCaption(workflow:WorkflowId,step:number) {
  return (workflow === 'wikipedia_cite_apa' ? ['Open Tools','Choose Cite this page','Find APA style']
    : ['Open VLC','Choose Download','Choose Windows'])[step-1];
}
export function requestsPrivateAccountChange(text:string) {
  return /^(?:please\s+)?(?:(?:help me|can you)\s+)?(?:change|reset|set|submit|save)\b[^.!?;]*\b(?:password|passcode|payment details|bank details)\b/i.test(text.trim());
}
export function profileFor(origin: string) {
  return workflowIds.find((id) => origin === 'https://' + workflows[id].host);
}
// The two local choices are appropriate for an unsupported Wikipedia citation
// request. Mentioning a citation, HTML element, or excluded section is not one.
export function needsCitationChoice(origin: string, goal: string) {
  if (origin !== 'https://' + workflows.wikipedia_cite_apa.host) return false;
  const request = goal.normalize('NFKC').toLowerCase().trim()
    .replace(/^(?:please\s+)?(?:help me\s+|can you\s+)?/, '');
  return /^(?:how (?:can|do) i cite\b|(?:find|show)(?: me)? (?:an? |the )?(?:(?:apa|mla|chicago) (?:citation|reference)\b|citation (?:for|of)\b))/.test(request);
}
export function resolveGoal(input: string): WorkflowId | 'clarify' | 'unsupported' {
  const g = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Match the whole request. An unrecognized named subject, action or qualifier
  // cannot be dropped while choosing one of our two available tasks.
  const request = g.replace(/^(?:please )?(?:help me |can you )?/, '').replace(/ please$/, '');
  if (
    /^(?:how do i cite (?:this (?:page|article)|phishing)|(?:find|show)(?: me)? (?:an? |the )?(?:apa citation(?: for (?:this (?:article|page)|(?:the )?phishing(?: article)?))?|article citation))$/.test(
      request,
    )
  )
    return 'wikipedia_cite_apa';
  if (
    /^(?:(?:find|show)(?: me)? (?:the )?(?:official )?(?:vlc(?: media player)? for windows|windows vlc (?:download )?page)|where is the windows download page)$/.test(
      request,
    )
  )
    return 'videolan_windows_page';
  if (/\b(?:cite|citation|apa)\b/.test(request) && /\bvlc\b/.test(request)) return 'clarify';
  return !g ||
    /^(help( me)?|guide( me)?|download|vlc|windows|citation|find (it|a page)|what can you do)$/.test(
      g,
    )
    ? 'clarify'
    : 'unsupported';
}
// Accept only allowlisted public facts. Nothing here serializes URL queries or fragments.
export function citationView(u: URL) {
  return (
    u.pathname === '/w/index.php' &&
    u.searchParams.getAll('title').length === 1 &&
    u.searchParams.get('title') === 'Special:CiteThisPage' &&
    u.searchParams.getAll('page').length === 1 &&
    u.searchParams.get('page') === 'Phishing'
  );
}
export function expectedNavigation(workflow: WorkflowId, step: number, raw?: string) {
  try {
    const u = new URL(raw ?? '');
    if (u.origin !== 'https://' + workflows[workflow].host || u.username || u.password)
      return false;
    return workflow === 'wikipedia_cite_apa'
      ? citationView(u) &&
          !u.searchParams.has('action') &&
          (step === 2 || (step === 3 && u.hash === '#APA_style'))
      : !u.search &&
          !u.hash &&
          ((step === 2 && u.pathname === '/vlc/') ||
            (step === 3 && u.pathname === '/vlc/download-windows.html'));
  } catch {
    return false;
  }
}
