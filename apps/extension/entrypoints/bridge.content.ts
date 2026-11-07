import { defineContentScript } from 'wxt/utils/define-content-script';
import { installBridge } from '../page/bridge';

export default defineContentScript({
  // WXT promotes declared runtime matches to required hosts. Supply real matches only after a site grant.
  registration: 'runtime',
  allFrames: false,
  main() {
    const world = globalThis as typeof globalThis & { __safeStepBridge?: boolean };
    if (window !== window.top || world.__safeStepBridge) return;
    world.__safeStepBridge = true;
    installBridge();
  },
});
