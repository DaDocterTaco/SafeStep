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
  chrome.sidePanel.onOpened?.addListener(({windowId,tabId})=>coordinator.dock.opened(windowId,tabId));
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if(raw?.channel==='open-current-warning'){
      const result=coordinator.protection.openWarning(sender,raw.revision,raw.route);
      if(result)safe(result);
      return;
    }
    if(raw?.channel==='dock-control'){
      void coordinator.dock.receive(raw,sender,coordinator.ready).then(ok=>send({ok}),()=>send({ok:false}));
      return true;
    }
    if(raw?.channel==='protection-page'){
      safe(coordinator.ready.then(()=>coordinator.protection.page(raw,sender)));return;
    }
    if (raw?.channel === 'compare-page-change' && typeof raw.id === 'string') {
      safe(coordinator.ready.then(() => coordinator.comparisons.pageChanged(raw.id, sender)));
      return;
    }
    if (raw?.channel === 'assist-notice') {
      safe(coordinator.ready.then(() => coordinator.adaptive.notice(raw, sender)));
      return;
    }
    if (raw?.channel === 'clean-notice') {
      safe(
        coordinator.ready.then(async () => {
          const s = await coordinator.cleanup.changed(raw, sender);
          if (s?.cp.task?.adaptive)
            await coordinator.adaptive.pause(s, 'Cleanup changed this page. Inspect again.');
        }),
      );
      return;
    }
    if (raw?.channel === 'shop-reserve') {
      void coordinator.ready
        .then(() => coordinator.shopping.reserve(raw, sender))
        .then(send, () => send(false));
      return true;
    }
    if (raw?.channel === 'shop-change') {
      safe(coordinator.ready.then(() => coordinator.shopping.changed(raw, sender)));
      return;
    }
    if (raw?.channel === 'review-change') {
      safe(coordinator.ready.then(() => coordinator.reviews.changed(raw, sender)));
      return;
    }
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
  chrome.tabs.onActivated.addListener((a) => {
    coordinator.dock.activated(a.tabId,a.windowId);
    safe(coordinator.activation(a));
    safe(coordinator.ready.then(()=>coordinator.protection.activated(a.tabId)));
  });
  chrome.windows.onFocusChanged.addListener((id) =>
    safe(
      coordinator.ready.then(async () => {
        for(const s of coordinator.store.tabs.values())if((s.abortChat || s.cp.chat?.activeTurnId)&&s.windowId!==id)
          await coordinator.chat.changed(s);
        for (const s of coordinator.store.tabs.values())
          if (
            s.comparison &&
            s.windowId !== id &&
            !['stale', 'paused', 'cancelled'].includes(s.comparison.status)
          )
            coordinator.comparisons.invalidate(
              s,
              'Window changed. Refresh on the owning product tab.',
            );
        for (const s of coordinator.store.tabs.values())
          if (s.abortAssist && s.windowId !== id)
            await coordinator.adaptive.pause(
              s,
              'The active window changed. Resume from the original tab.',
            );
      }),
    ),
  );
  chrome.tabs.onUpdated.addListener((id, ch, t) => {
    coordinator.dock.navigation(id,ch,t);
    safe(coordinator.ready.then(()=>coordinator.protection.navigation(id,ch,t)));
    safe(coordinator.navigation(id,ch,t));
  });
  chrome.tabs.onRemoved.addListener((id) =>
    safe(
      coordinator.ready.then(() => {
        coordinator.dock.drop(id);
        safe(coordinator.protection.drop(id));
        coordinator.shopping.clearHistory(id);
        const s = coordinator.store.tabs.get(id);
        if (s) coordinator.comparisons.forget(s);
        return coordinator.store.drop(id);
      }),
    ),
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if(area==='session'&&'local-ai-session' in changes)
      safe(coordinator.ready.then(async()=>{
        for(const s of coordinator.store.tabs.values())if(s.abortChat)await coordinator.chat.changed(s);
        await coordinator.protection.pairingChanged();
      }));
    if (
      area === 'session' &&
      'local-ai-session' in changes &&
      !changes['local-ai-session']?.newValue
    )
      safe(
        coordinator.ready.then(async () => {
          coordinator.shopping.clearHistory();
          for (const s of coordinator.store.tabs.values())
            if (s.cp.task?.adaptive)
              await coordinator.adaptive.pause(
                s,
                'AI connection changed. Pair again before continuing.',
              );
          for (const s of coordinator.store.tabs.values())
            if (s.cancelShopping) {
              coordinator.shopping.clear(s);
              await coordinator.store.save(s);
            }
        }),
      );
  });
  chrome.permissions.onRemoved.addListener((p) => {
    if(p.origins?.length)coordinator.dock.revoked(p.origins);
    if (p.origins?.length) safe(coordinator.ready.then(() => coordinator.removeSites(p.origins!)));
  });
});
