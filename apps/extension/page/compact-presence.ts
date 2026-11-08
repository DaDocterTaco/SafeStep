// The dock and warning run in the extension's isolated world, in separate bundles.
// Publish only the connected presentation host. A page event cannot grant actions.
const world = globalThis as typeof globalThis & { __safeStepCompactDock?: HTMLElement };
export const compactDockEvent = 'safestep-compact-visibility';
export function compactDockVisible() {
  return world.__safeStepCompactDock?.isConnected === true;
}
export function setCompactDockHost(host: HTMLElement | null) {
  if (world.__safeStepCompactDock === (host ?? undefined)) return;
  if (host) world.__safeStepCompactDock = host;
  else delete world.__safeStepCompactDock;
  document.dispatchEvent(new Event(compactDockEvent));
}
