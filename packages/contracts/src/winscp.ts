import type { FileProfile } from './review.js';

// The package purpose comes from the request, not from the browser's OS.
// Keep negative clauses out of the positive package match and fail closed on
// other product, platform, architecture, release or unrecognized constraints.
export function winSCPRequest(text: string): FileProfile | 'clarify' | 'unsupported' {
  let unknownExclusion = false;
  const excluded: string[] = [];
  const positive = text.toLowerCase().replace(/\b(?:do not|don't|not|without|except|excluding|avoid|never)\s+([^,.;!?]+)/g, (_m, clause: string) => {
    excluded.push(clause);
    if (clause.replace(/\b(?:download(?:ing)?|activate|open|click|install|it|the|file|any|a|and|or|putty|source|code|portable|setup|installer|msi|automation|experimental|x64|package|zip|exe|ads?)\b/g, '').trim()) unknownExclusion = true;
    return ' ';
  });
  if (unknownExclusion || !/\b(?:download|installer|setup|portable|package|executable)\b/.test(positive)) return 'clarify';
  if (/\b(?:putty|source|msi|experimental|automation|beta|linux|macos|mac|android|x64|arm64|x86|32-bit|64-bit)\b/.test(positive) ||
      /^(?:please\s+)?(?:install|download|run)\s+/.test(positive.trim())) return 'unsupported';
  const words = positive.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(w => !/^(?:i|me|my|we|can|could|you|would|like|want|need|please|help|show|find|locate|identify|point|guide|take|bring|get|go|where|which|is|are|to|the|a|an|on|this|site|page|for|of|and|but|do|correct|right|standard|normal|regular|official|latest|current|windows|winscp|installer|installation|setup|exe|portable|zip|package|download|downloads|version|executables?|link|button|control|from|files?)$/.test(w))) return 'clarify';
  const portable = /\bportable\b/.test(positive);
  if (portable && /\b(?:standard|setup|installer|exe)\b/.test(positive)) return 'clarify';
  if (excluded.some(s => /\bwinscp\b/.test(s) || (portable ? /\b(?:portable|zip)\b/ : /\b(?:setup|installer|exe)\b/).test(s))) return 'clarify';
  if (!portable && /\bzip\b/.test(positive)) return 'clarify';
  return portable ? 'winscp_portable' : 'winscp_windows_setup';
}
