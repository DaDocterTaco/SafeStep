import { Fault, permittedOrigin, type Preferences } from '@safestep/contracts';
import type { RecordState } from './state';

export const bridgeFile = 'content-scripts/bridge.js';
export const protectionFile = 'content-scripts/protection.js';
export const allWeb = ['http://*/*','https://*/*'];
export const pattern = (site: string) =>
  new URL(site).protocol + '//' + new URL(site).hostname + '/*';
export function removedOrigin(site: string, patterns: string[]) {
  const u = new URL(site);
  return patterns.some((p) => {
    if (p === '<all_urls>') return true;
    const m = /^(\*|http|https):\/\/([^/]+)\//.exec(p);
    return (
      !!m &&
      (m[1] === '*' || m[1] + ':' === u.protocol) &&
      (m[2] === '*' ||
        m[2] === u.hostname ||
        (m[2]?.startsWith('*.') &&
          (u.hostname === m[2].slice(2) || u.hostname.endsWith(m[2].slice(1)))))
    );
  });
}
export async function access(s: RecordState, prefs: Preferences, t: chrome.tabs.Tab) {
  const site = permittedOrigin(t.url);
  if (!site) {
    if (t.url || s.cp.issue === 'unsupported_page') throw new Fault('unsupported_page');
    throw new Fault(
      s.cp.issue === 'permission_revoked' ? 'permission_revoked' : 'permission_required',
    );
  }
  if (
    prefs.sites.includes(site) &&
    (await chrome.permissions.contains({ origins: [pattern(site)] }))
  )
    return { site, access: 'site' as const };
  if (s.cp.invokedOrigin === site) return { site, access: 'temporary' as const };
  throw new Fault(
    s.cp.issue === 'permission_revoked' ? 'permission_revoked' : 'permission_required',
  );
}
export async function probe(tabId: number, site: string) {
  let result: chrome.scripting.InjectionResult<string>[];
  try {
    result = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => location.origin,
    });
  } catch {
    throw new Fault('permission_required');
  }
  const top = result.find((r) => r.frameId === 0);
  if (!top?.documentId || top.result !== site) throw new Fault('stale_document');
  return top.documentId;
}
export async function syncRegistrations(prefs: Preferences) {
  const patterns = [...new Set(prefs.sites.map(pattern))].sort();
  const auto = prefs.protection;
  const protectedSites = auto?.scope === 'all' ? allWeb : auto?.scope === 'selected' ? [...new Set(auto.sites.map(pattern))] : [];
  await Promise.all([
    register('safestep-enabled', patterns, bridgeFile),
    register('safestep-protection', protectedSites, protectionFile),
  ]);
}
async function register(id: string, patterns: string[], file: string) {
  const current = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const permitted: string[] = [];
  for (const p of patterns)
    if (await chrome.permissions.contains({ origins: [p] })) permitted.push(p);
  if (!permitted.length) {
    if (current.length)
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    return;
  }
  const reg = {
    id,
    matches: permitted,
    js: [file],
    allFrames: false,
    persistAcrossSessions: true,
    runAt: 'document_idle' as const,
  };
  if (current.length) await chrome.scripting.updateContentScripts([reg]);
  else await chrome.scripting.registerContentScripts([reg]);
}
