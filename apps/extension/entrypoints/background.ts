import { defineBackground } from 'wxt/utils/define-background';
import { Fault, PanelRequest, parseWire } from '@safestep/contracts';
import { Coordinator } from '../core/coordinator';

export default defineBackground(() => {
  const coordinator = new Coordinator();
  const safe = (p: Promise<unknown>) => {
    void p.catch(() => console.warn('SafeStep: lifecycle operation unavailable'));
  };
  chrome.action.onClicked.addListener((t) => {
    // open must be called inside the toolbar gesture; do not await storage first.
    safe(chrome.sidePanel.open({ windowId: t.windowId }));
    safe(coordinator.invoked(t));
  });
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if (raw?.channel === 'changed') {
      safe(coordinator.changed(raw, sender));
      return;
    }
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      sender.url !== chrome.runtime.getURL('sidepanel.html')
    )
      return;
    const r = parseWire(PanelRequest, raw);
    if (!r) {
      send({ error: 'invalid_message' });
      return;
    }
    const base = { v: 2, channel: 'panelReply', requestId: r.requestId, tabId: r.tabId };
    void coordinator.handle(r).then(
      (view) => send({ ...base, ok: true, view, error: null }),
      (e) => {
        const error = e instanceof Fault ? e.code : 'blocked_by_policy';
        console.info('SafeStep', r.requestId, error);
        send({ ...base, ok: false, view: null, error });
      },
    );
    return true;
  });
  chrome.tabs.onActivated.addListener((a) => safe(coordinator.activation(a)));
  chrome.tabs.onUpdated.addListener((id, ch, t) => safe(coordinator.navigation(id, ch, t)));
  chrome.tabs.onRemoved.addListener((id) =>
    safe(coordinator.ready.then(() => coordinator.store.drop(id))),
  );
  chrome.permissions.onRemoved.addListener((p) => {
    if (p.origins?.length) safe(coordinator.ready.then(() => coordinator.removeSites(p.origins!)));
  });
});
