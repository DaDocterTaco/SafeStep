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
      'Open Tools on the article.',
      'Choose Cite this page in Tools.',
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
export function profileFor(origin: string) {
  return workflowIds.find((id) => origin === 'https://' + workflows[id].host);
}
export function resolveGoal(input: string): WorkflowId | 'clarify' | 'unsupported' {
  const g = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Match bounded local requests; don't turn unrelated actions into a supported task.
  const wiki = /\b(cite|citation|apa)\b/.test(g),
    video = /\bwindows\b/.test(g) && /\b(vlc|download|videolan)\b/.test(g);
  if (wiki && video) return 'clarify';
  if (
    /\b(buy|pay|install|uninstall|delete|submit|upload|edit|mla|chicago|bibtex|harvard|linux|macos|android)\b/.test(
      g,
    )
  )
    return 'unsupported';
  if (wiki && /\b(apa|cite|article|page)\b/.test(g)) return 'wikipedia_cite_apa';
  if (video) return 'videolan_windows_page';
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
