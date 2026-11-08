import { defineContentScript } from 'wxt/utils/define-content-script';
import { ProtectionView, nextProtectionExpiry, threatFinding, threatWarningLinks, visibleProtection } from '@safestep/contracts';
import { protectionRouteToken } from '../page/protection-route';

export default defineContentScript({
  registration: 'runtime',
  allFrames: false,
  main() {
    const shared = globalThis as typeof globalThis & { __safeStepProtection?: boolean };
    if (window.top !== window || shared.__safeStepProtection) return;
    shared.__safeStepProtection = true;
    let host: HTMLElement | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      bound: {raw: ProtectionView; route: string} | undefined,
      painted: string | undefined;
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
      const now = Date.now(), v = visibleProtection(raw, now);
      const signature = JSON.stringify([v.revision, v.status, v.outside, v.threatWarnings, v.expiresAt, v.threat?.expiresAt, v.dismissed]);
      if (signature === painted && host?.isConnected) return;
      clear();
      bound = {raw, route};
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
      if (!v.caution || v.dismissed || !document.documentElement) return;
      host = document.createElement('aside');
      host.setAttribute('data-safestep-protection', '');
      host.setAttribute('data-security', '');
      host.setAttribute('aria-label', 'SafeStep warning');
      host.style.setProperty('all', 'initial', 'important');
      for (const [k, value] of Object.entries({
        position: 'fixed',
        bottom: '12px',
        right: '12px',
        width: 'min(390px, calc(100vw - 24px))',
        zIndex: '2147483647',
      }))
        host.style.setProperty(k === 'zIndex' ? 'z-index' : k, value, 'important');
      const root = host.attachShadow({ mode: 'closed' }),
        style = document.createElement('style');
      style.textContent =
        ':host{color-scheme:light}section{font:16px/1.45 system-ui, sans-serif;color:#202925;background:white;border:2px solid #944311;border-radius:8px;padding:14px;box-shadow:0 3px 16px #0004;max-height:65vh;overflow:auto}p{margin:5px 0}button,a{font:inherit;color:#114c43}button{background:white;border:1px solid #555;border-radius:5px;min-height:36px;padding:4px 8px;margin:4px 4px 0 0}button:focus-visible,a:focus-visible{outline:3px solid #b54600;outline-offset:1px}';
      const box = document.createElement('section'),
        title = document.createElement('strong'),
        summary = document.createElement('p');
      title.textContent = 'SafeStep · Check this website';
      summary.setAttribute('role', 'alert');
      summary.textContent = v.threatWarnings?.length ? v.threatWarnings.map(r=>threatFinding(r, now)).join(' ') : v.status === 'reports' ? v.outside : v.address;
      const reasons = document.createElement('details'),
        disclosure = document.createElement('summary');
      disclosure.textContent = 'View reasons';
      disclosure.style.cssText =
        'cursor:pointer;min-height:32px;line-height:32px;font-weight:600;color:#114c43';
      reasons.append(disclosure);
      for (const detail of [v.address, v.outside, ...(v.threatWarnings ?? []).map(r=>threatFinding(r)+' Checked '+new Date(r.checkedAt).toLocaleString()+'.'), ...v.details]) {
        const p = document.createElement('p');
        p.textContent = detail;
        reasons.append(p);
      }
      for (const cited of v.sources) {
        const a = document.createElement('a');
        a.href = cited.url;
        a.textContent = cited.label;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const p = document.createElement('p');
        p.append(a);
        reasons.append(p);
      }
      box.append(title, summary);
      const links = new Map((v.threatWarnings ?? []).flatMap(r => threatWarningLinks(r, now)).map(link => [link.url, link]));
      for (const {url, label} of links.values()) {
        const a = document.createElement('a'), line = document.createElement('p');
        a.href = url;
        a.textContent = label;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        line.append(a);
        box.append(line);
      }
      box.append(reasons);
      // Native dialog-form dismissal survives sites' delegated click handlers.
      // The non-modal dialog is opened via its attribute, so it never takes focus.
      const dialog=document.createElement('dialog'),form=document.createElement('form');
      dialog.setAttribute('open','');dialog.setAttribute('aria-label','SafeStep website warning');
      dialog.style.cssText='position:static;inset:auto;background:transparent;border:0;padding:0;margin:0;width:100%;max-width:100%;color:inherit';
      form.method='dialog';form.style.cssText='display:flex;align-items:center;gap:8px';
      const dismiss=document.createElement('button'),leave=document.createElement('a');
      dismiss.type='submit';dismiss.value='dismiss';dismiss.textContent='Dismiss';
      leave.href='about:blank';leave.textContent='Leave page';
      const currentHost=host;
      const observer=new MutationObserver(()=>{
        if(dialog.open)return;
        observer.disconnect();currentHost.remove();send('dismiss',v.revision);
      });
      observer.observe(dialog,{attributes:true,attributeFilter:['open']});
      form.append(dismiss,leave);box.append(form);dialog.append(box);root.append(style,dialog);
      document.documentElement.append(host);
    }
    document.addEventListener('visibilitychange', () => {
      if (bound) paint(bound.raw, bound.route);
    });
    window.addEventListener('pageshow', () => send('arrive'));
    window.addEventListener('pagehide', clear);
    send('arrive');
  },
});
