import { defineContentScript } from 'wxt/utils/define-content-script';
import { installBridge } from '../page/bridge';
import { installReviewBridge } from '../page/review-bridge';
import { installShopBridge } from '../page/shop-bridge';
import {installAssistBridge} from '../page/assist-bridge';
import {installCleanup} from '../page/cleanup';
import {installDock} from '../page/dock';

export default defineContentScript({
  // WXT promotes declared runtime matches to required hosts. Supply real matches only after a site grant.
  registration: 'runtime',
  allFrames: false,
  main() {
    const world = globalThis as typeof globalThis & { __safeStepBridge?: boolean };
    if (window !== window.top || world.__safeStepBridge) return;
    world.__safeStepBridge = true;
    installBridge();
    installReviewBridge();
    installShopBridge();
    installAssistBridge();
    installCleanup();
    installDock();
  },
});
