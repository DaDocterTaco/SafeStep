// This function is also injected into the isolated world for a document-bound read.
export function protectionRouteToken() {
  const world = globalThis as typeof globalThis & {
    __safeStepArrivalRoute?: { url: string; nonce: string };
  };
  if (world.__safeStepArrivalRoute?.url !== location.href) {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
    world.__safeStepArrivalRoute = { url: location.href, nonce };
  }
  return world.__safeStepArrivalRoute.nonce;
}
