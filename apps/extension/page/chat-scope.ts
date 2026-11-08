// Runs in the authorized top frame. Only an opaque per-document token leaves the page.
// Ordinary DOM edits and layout changes do not invalidate an otherwise stable card.
export async function chatScopeSignature() {
  const parts = [location.pathname];
  if (location.hostname === 'addons.mozilla.org')
    for (const k of ['score', 'page']) {
      const v = new URL(location.href).searchParams.get(k);
      if (v && /^\d{1,3}$/.test(v)) parts.push(k, v);
    }
  const practice =
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
    /^\/(shopping-lab|comparison-lab)(\/|$)/.test(location.pathname);
  const candidates = document.querySelectorAll(
    '[data-selected-variant],[data-comparison-variant],[data-comparison-subject]' +
      (practice ? ',#shop-listing' : ''),
  );
  for (const el of Array.from(candidates).slice(0, 8)) {
    if (el.closest('form,[contenteditable],[data-private]')) continue;
    for (const key of [
      'selected-variant',
      'comparison-variant',
      'comparison-subject',
      ...(practice
        ? [
            'listing',
            'catalog',
            'offer',
            'asin',
            'region',
            'seller',
            'isbn',
            'variant',
            'condition',
            'format',
          ]
        : []),
    ]) {
      const value = el.getAttribute('data-' + key);
      if (value) parts.push(key, value.slice(0, 180));
    }
  }
  const signature = JSON.stringify(parts),
    world = globalThis as typeof globalThis & {
      __safeStepChatScope?: { signature: string; token: string };
    };
  if (world.__safeStepChatScope?.signature !== signature) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    world.__safeStepChatScope = {
      signature,
      token: [...bytes].map((n) => n.toString(16).padStart(2, '0')).join(''),
    };
  }
  return world.__safeStepChatScope.token;
}
