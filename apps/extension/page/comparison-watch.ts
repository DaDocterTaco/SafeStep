// Executed in the authorized top-level isolated world. Only public variant
// markers are compared. Their text stays in the document.
export function watchComparison(id: string, install: boolean) {
  const world = globalThis as typeof globalThis & {
    __safeStepComparison?: { id: string; check: () => boolean; stop: () => void };
  };
  if (!install) return world.__safeStepComparison?.id === id && world.__safeStepComparison.check();
  world.__safeStepComparison?.stop();
  function signature() {
    const u = new URL(location.href);
    const parts = [u.pathname];
    if (u.hostname === 'addons.mozilla.org' && /\/reviews\/?$/.test(u.pathname))
      for (const key of ['score', 'page']) {
        const value = u.searchParams.get(key);
        if (value && /^\d{1,2}$/.test(value)) parts.push(key, value);
      }
    for (const el of Array.from(
      document.querySelectorAll(
        '[data-comparison-variant],[data-selected-variant],[data-comparison-subject]',
      ),
    ).slice(0, 8)) {
      if (el.closest('form,[data-private],[contenteditable],input,textarea')) continue;
      parts.push(
        (
          el.getAttribute('data-comparison-variant') ??
          el.getAttribute('data-selected-variant') ??
          el.getAttribute('data-comparison-subject') ??
          ''
        ).slice(0, 100),
        el instanceof HTMLElement ? el.innerText.slice(0, 100) : '',
      );
    }
    return JSON.stringify(parts);
  }
  const initial = signature(),
    check = () => initial === signature();
  const observer = new MutationObserver(() => {
    if (!check()) {
      observer.disconnect();
      void chrome.runtime.sendMessage({ channel: 'compare-page-change', id }).catch(() => {});
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'data-comparison-variant',
      'data-selected-variant',
      'data-comparison-subject',
    ],
  });
  world.__safeStepComparison = { id, check, stop: () => observer.disconnect() };
  return true;
}
