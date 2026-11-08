import { defineContentScript } from 'wxt/utils/define-content-script';
import { ProtectionView, nextProtectionExpiry, visibleProtection } from '@safestep/contracts';
import { protectionRouteToken } from '../page/protection-route';
import {
  currentWarningText,
  warningPresentationKey,
  warningPortName,
} from '../sites/protection-warning';
import { compactDockEvent, compactDockVisible } from '../page/compact-presence';

export default defineContentScript({
  registration: 'runtime',
  allFrames: false,
  main() {
    const shared = globalThis as typeof globalThis & { __safeStepProtection?: boolean };
    if (window.top !== window || shared.__safeStepProtection) return;
    shared.__safeStepProtection = true;
    let host: HTMLElement | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      bound: { raw: ProtectionView; route: string } | undefined,
      painted: string | undefined,
      controls: { root: ShadowRoot; reasons?: HTMLDetailsElement } | undefined;
    let foldedFor: string | undefined, announced: string | undefined;
    let panel:
      { port: chrome.runtime.Port; doc: string; revision: string; route: string } | undefined;
    const repaint = () => {
      if (bound) paint(bound.raw, bound.route);
    };
    chrome.runtime.onConnect.addListener((port) => {
      const from = port.sender;
      if (
        port.name !== warningPortName ||
        from?.id !== chrome.runtime.id ||
        from.tab ||
        from.url !== chrome.runtime.getURL('sidepanel.html')
      )
        return;
      port.onMessage.addListener((msg) => {
        if (
          msg?.op !== 'present' ||
          typeof msg.doc !== 'string' ||
          typeof msg.revision !== 'string' ||
          msg.origin !== location.origin ||
          msg.route !== protectionRouteToken()
        )
          return;
        panel = { port, doc: msg.doc, revision: msg.revision, route: msg.route };
        repaint();
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (panel?.port === port) {
          panel = undefined;
          repaint();
        }
      });
    });
    document.addEventListener(compactDockEvent, repaint);
    const send = (op: string, id?: string) =>
      void chrome.runtime
        .sendMessage({ channel: 'protection-page', op, revision: id })
        .catch(() => {});
    function clear() {
      clearTimeout(timer);
      host?.remove();
      host = undefined;
      painted = undefined;
      bound = undefined;
      controls = undefined;
    }
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender.id !== chrome.runtime.id || sender.tab || msg?.channel !== 'protection-display')
        return;
      if (msg.op === 'ping') {
        send('arrive');
        return;
      }
      if (msg.op === 'clear') {
        clear();
        return;
      }
      const parsed = ProtectionView.safeParse(msg.view);
      if (
        !parsed.success ||
        parsed.data.origin !== location.origin ||
        msg.route !== protectionRouteToken()
      )
        return;
      paint(parsed.data, msg.route);
    });
    function paint(raw: ProtectionView, route: string) {
      if (raw.origin !== location.origin || route !== protectionRouteToken()) {
        clear();
        return;
      }
      const now = Date.now(),
        v = visibleProtection(raw, now);
      const key = warningPresentationKey(v),
        panelShown =
          !!panel && panel.doc === v.doc && panel.route === route && panel.revision === v.revision;
      const compact = panelShown || foldedFor === key,
        dockShown = compactDockVisible();
      const signature = JSON.stringify([
        v.revision,
        v.status,
        v.outside,
        v.threatWarnings,
        v.expiresAt,
        v.threat?.expiresAt,
        v.dismissed,
        compact,
        panelShown,
        dockShown,
      ]);
      if (signature === painted && host?.isConnected) return;
      const sameWarning = bound?.route === route && bound.raw.revision === v.revision;
      const expanded = sameWarning && !!controls?.reasons?.open;
      const focus =
        sameWarning &&
        document.activeElement === host &&
        controls?.root.activeElement instanceof HTMLElement
          ? controls.root.activeElement.dataset.warningAction
          : undefined;
      clear();
      bound = { raw, route };
      painted = signature;
      const expiry = nextProtectionExpiry(raw, now);
      if (expiry !== null)
        timer = setTimeout(
          () => {
            if (bound?.raw !== raw || bound.route !== route) return;
            painted = undefined;
            paint(raw, route);
            if (bound && Date.now() >= expiry) send('expire', v.revision);
          },
          Math.max(0, Math.min(2147483647, expiry - Date.now())),
        );
      if (!v.caution || v.dismissed || !document.documentElement) {
        announced = undefined;
        foldedFor = undefined;
        return;
      }
      host = document.createElement('aside');
      host.setAttribute('data-safestep-protection', '');
      host.setAttribute('data-security', '');
      host.setAttribute('aria-label', 'SafeStep warning');
      host.dataset.warningMode = compact ? 'compact' : 'expanded';
      host.dataset.panelPresent = String(panelShown);
      host.style.setProperty('all', 'initial', 'important');
      for (const [k, value] of Object.entries({
        position: 'fixed',
        bottom: '12px',
        right: '12px',
        width: compact ? 'min(285px, calc(100vw - 24px))' : 'min(390px, calc(100vw - 24px))',
        zIndex: '2147483647',
      }))
        host.style.setProperty(k === 'zIndex' ? 'z-index' : k, value, 'important');
      const root = host.attachShadow({ mode: 'closed' }),
        style = document.createElement('style');
      style.textContent =
        ':host{color-scheme:light}section{box-sizing:border-box;font:15px/1.45 system-ui,sans-serif;color:#20342c;background:#fffaf0;border:1px solid #c5b9a6;border-radius:11px;padding:0 13px 11px;box-shadow:0 3px 14px #121f2429;max-height:60vh;overflow:auto;overflow-wrap:anywhere}' +
        'header{background:#173e34;color:#fffaf0;margin:0 -13px 9px;padding:8px 13px;font:600 17px/1.2 Georgia,serif}strong{display:block;background:#ffe9b9;color:#513304;border-radius:5px;padding:5px 9px;font:600 18px/1.25 Georgia,serif}' +
        'p{margin:5px 0}dl{margin:5px 0}dl div{display:grid;grid-template-columns:6em 1fr;gap:5px;padding:2px 0;border-bottom:1px solid #d3cabc}dt{font-weight:600}dd{margin:0}button,a{font:inherit;color:#114c43}button{background:#fffaf0;border:1px solid #628076;border-radius:6px;min-height:34px;padding:4px 9px}button.primary{background:#173e34;color:white}a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #a34b13;outline-offset:2px}small{display:block;color:#5a5448}form{flex-wrap:wrap;align-items:center}@media(forced-colors:active){strong,header{border:1px solid CanvasText}}';
      const box = document.createElement('section'),
        brand = document.createElement('header'),
        title = document.createElement('strong');
      brand.textContent = 'SafeStep';
      const copy = currentWarningText(v, now, compact);
      const toggleWarning = (event: Event) => {
        if (
          !event.isTrusted ||
          route !== protectionRouteToken() ||
          bound?.raw.revision !== v.revision
        )
          return;
        if (panelShown) {
          try {
            if (panel) {
              panel.port.postMessage({ op: 'show', revision: v.revision, route });
              return;
            }
          } catch {
            panel = undefined;
          }
          foldedFor = undefined;
        } else foldedFor = compact ? undefined : key;
        repaint();
      };
      if (copy.passiveLocalStrip) {
        host.dataset.warningStyle = 'strip';
        host.style.setProperty('width', 'min(223px, calc(100vw - 24px))', 'important');
        const strip = document.createElement('button');
        strip.type = 'button';
        strip.className = 'local-strip';
        strip.dataset.warningAction = 'fold';
        strip.setAttribute('aria-label', 'Show warning: ' + copy.title);
        strip.setAttribute('aria-expanded', 'false');
        const mark = document.createElement('span'),
          symbol = document.createElement('span'),
          label = document.createElement('span'),
          chevron = document.createElement('span');
        mark.className = 'brand-mark';
        mark.textContent = 'S';
        symbol.className = 'caution-mark';
        symbol.textContent = '⚠︎';
        label.className = 'finding';
        label.textContent = copy.title;
        chevron.className = 'chevron';
        for (const icon of [mark, symbol, chevron]) icon.setAttribute('aria-hidden', 'true');
        strip.append(mark, symbol, label, chevron);
        strip.addEventListener('click', toggleWarning);
        style.textContent +=
          '.local-strip{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:46px;padding:7px 12px;background:#fffaf0;color:#20342c;border:1px solid #a99e89;border-radius:11px;box-shadow:0 2px 8px #121f2422;text-align:left;font:600 14px/1.3 system-ui,sans-serif;cursor:pointer}' +
          '.brand-mark{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:5px;color:white;background:#173e34;font:700 16px/1 Georgia,serif}' +
          '.caution-mark{color:#865412;font:17px/1 system-ui,sans-serif}.finding{min-width:0;overflow-wrap:anywhere}.chevron{flex:none;margin-inline-start:auto;width:6px;height:6px;border:solid #173e34;border-width:0 1.5px 1.5px 0;transform:translateY(-2px) rotate(45deg)}' +
          '@media(forced-colors:active){.local-strip,.brand-mark{border:1px solid ButtonText}.chevron{border-color:ButtonText}.caution-mark{color:ButtonText}}';
        root.append(style, strip);
        document.documentElement.append(host);
        controls = { root };
        if (focus === 'fold') strip.focus({ preventScroll: true });
        return;
      }
      title.textContent = copy.title;
      const message = document.createElement('div');
      if (!panelShown && announced !== key) message.setAttribute('role', 'alert');
      announced = key;
      message.setAttribute('aria-atomic', 'true');
      const reasons = document.createElement('details'),
        disclosure = document.createElement('summary');
      disclosure.textContent = 'Details';
      disclosure.dataset.warningAction = 'details';
      reasons.open = expanded;
      disclosure.style.cssText =
        'cursor:pointer;min-height:32px;line-height:32px;font-weight:600;color:#114c43';
      reasons.append(disclosure);
      for (const detail of copy.details) {
        const p = document.createElement('p');
        p.textContent = detail;
        reasons.append(p);
      }
      for (const cited of copy.sources) {
        const a = document.createElement('a');
        a.href = cited.url;
        a.textContent = cited.label;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const p = document.createElement('p');
        p.append(a);
        reasons.append(p);
      }
      box.append(brand, message);
      message.append(title);
      const pair = document.createElement('dl');
      for (const { label, value } of copy.rows) {
        const row = document.createElement('div'),
          term = document.createElement('dt'),
          detail = document.createElement('dd');
        term.textContent = label;
        const difference = label === 'Here' ? copy.difference : null;
        if (difference) {
          const mark = document.createElement('mark');
          mark.textContent = value.slice(difference.start, difference.end);
          mark.style.cssText = 'font-weight:700;text-decoration:underline';
          detail.append(value.slice(0, difference.start), mark, value.slice(difference.end));
        } else detail.textContent = value;
        row.append(term, detail);
        pair.append(row);
      }
      if (!compact) message.append(pair);
      for (const text of copy.findings) {
        const line = document.createElement('p');
        line.textContent = text;
        message.append(line);
      }
      for (const { url, label } of copy.advisory) {
        const a = document.createElement('a'),
          line = document.createElement('p');
        a.href = url;
        a.textContent = label;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        line.append(a);
        box.append(line);
      }
      if (!compact) box.append(reasons);
      // Native dialog-form dismissal survives sites' delegated click handlers.
      // The non-modal dialog is opened via its attribute, so it never takes focus.
      const dialog = document.createElement('dialog'),
        form = document.createElement('form');
      dialog.setAttribute('open', '');
      dialog.setAttribute('aria-label', 'SafeStep website warning');
      dialog.style.cssText =
        'position:static;inset:auto;background:transparent;border:0;padding:0;margin:0;width:100%;max-width:100%;color:inherit';
      form.method = 'dialog';
      form.style.cssText = 'display:flex;align-items:center;gap:8px';
      const dismiss = document.createElement('button'),
        leave = document.createElement('a'),
        open = document.createElement('button');
      dismiss.type = 'submit';
      dismiss.value = 'dismiss';
      dismiss.textContent = 'Dismiss warning';
      dismiss.dataset.warningAction = 'dismiss';
      open.dataset.warningAction = 'open';
      leave.dataset.warningAction = 'leave';
      open.type = 'button';
      open.className = 'primary';
      open.textContent = 'Open SafeStep';
      open.addEventListener('click', (event) => {
        if (event.isTrusted && route === protectionRouteToken())
          void chrome.runtime
            .sendMessage({ channel: 'open-current-warning', route, revision: v.revision })
            .catch(() => {});
      });
      leave.href = 'about:blank';
      leave.textContent = 'Leave page';
      const fold = document.createElement('button');
      fold.type = 'button';
      fold.dataset.warningAction = 'fold';
      fold.textContent = compact ? 'Show warning' : 'Tuck warning';
      fold.setAttribute('aria-expanded', String(!compact));
      fold.addEventListener('click', toggleWarning);
      const currentHost = host;
      const observer = new MutationObserver(() => {
        if (dialog.open) return;
        observer.disconnect();
        currentHost.remove();
        send('dismiss', v.revision);
      });
      observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
      form.append(fold, leave, dismiss);
      if (!panelShown && !dockShown) form.append(open);
      box.append(form);
      dialog.append(box);
      root.append(style, dialog);
      document.documentElement.append(host);
      controls = { root, reasons };
      if (focus && ['open', 'leave', 'dismiss', 'details', 'fold'].includes(focus))
        root
          .querySelector<HTMLElement>('[data-warning-action="' + focus + '"]')
          ?.focus({ preventScroll: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (bound) paint(bound.raw, bound.route);
    });
    window.addEventListener('pageshow', () => send('arrive'));
    window.addEventListener('pagehide', clear);
    send('arrive');
  },
});
