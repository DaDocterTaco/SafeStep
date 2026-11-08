import { DockDisplay, type DockAction, type DockControl } from '@safestep/contracts';
import { protectionRouteToken } from './protection-route';
import { Outline } from './overlay';
import { setCompactDockHost } from './compact-presence';

const labels: Record<DockAction, string> = {
  open: 'Open SafeStep',
  show: 'Show step',
  pause: 'Pause',
  stop: 'Stop',
  takeover: 'Take over',
  restore: 'Restore page',
};
const obstacles =
  'input:not([type=hidden]),textarea,select,button,a[href],summary,[contenteditable=true],[role=button],[role=dialog],[role=alert],[data-security],[data-consent],[data-shopping-evidence]';
type Display = Extract<DockDisplay, { op: 'show' }>;
function goalLabel(goal: string) {
  const subject = goal.replace(/^(?:please\s+)?(?:(?:help me|can you)\s+)?(?:find|show me|take me to)\s+(?:the\s+)?/i, '');
  const value = subject || goal;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
export function installDock() {
  if (window.top !== window) return;
  let active: Display | null = null,
    host: HTMLElement | null = null,
    root: ShadowRoot | null = null,
    region: HTMLElement | null = null,
    heading: HTMLElement | null = null,
    goal: HTMLElement | null = null,
    controls: HTMLElement | null = null,
    observer: MutationObserver | null = null,
    warningSize: ResizeObserver | null = null,
    observedWarning: Element | null = null,
    hint: HTMLElement | null = null,
    frame = 0;
  function clear() {
    observer?.disconnect();
    observer = null;
    warningSize?.disconnect();
    warningSize = null;
    observedWarning = null;
    cancelAnimationFrame(frame);
    frame = 0;
    active = null;
    host?.remove();
    setCompactDockHost(null);
    host = null;
    root = null;
    region = null;
    heading = null;
    goal = null;
    controls = null;
    hint = null;
  }
  const message = (action: DockControl['action'], d: Display) => {
    try {
      return chrome.runtime.sendMessage({
        channel: 'dock-control',
        cap: d.cap,
        route: d.route,
        action,
      } satisfies DockControl);
    } catch {
      return Promise.resolve({ ok: false });
    }
  };
  function lost() {
    const d = active;
    clear();
    if (d) void message('lost', d).catch(() => {});
  }
  function place() {
    if (!active || !host?.isConnected || !region || protectionRouteToken() !== active.route)
      return false;
    const cue = Outline.currentInstruction();
    const show = controls?.querySelector<HTMLButtonElement>('button[data-action=show]');
    if (show) {
      // Keep a focused button in place during an explicit reveal. Passive updates
      // never remove keyboard focus from the person's current control.
      show.hidden = cue?.visibility === 'visible' && root?.activeElement !== show;
      const name = cue?.text ? 'Show step: ' + cue.text : 'Show step';
      if (show.getAttribute('aria-label') !== name) show.setAttribute('aria-label', name);
    }
    if (hint) {
      const value =
        active.actions.includes('show') &&
        cue && (cue.visibility !== 'visible' || cue.placement === 'panel' || !cue.caption)
          ? cue.text
          : '';
      if (hint.textContent !== value) hint.textContent = value;
      hint.hidden = !value;
    }
    const view = window.visualViewport;
    const left = view?.offsetLeft ?? 0,
      top = view?.offsetTop ?? 0,
      w = view?.width ?? innerWidth,
      h = view?.height ?? innerHeight;
    const b = region.getBoundingClientRect(),
      gap = 10;
    if (!b.width || !b.height || b.width > w - 2 * gap || b.height > h - 2 * gap) return false;
    const overlap = (x: number, y: number, r: DOMRect) =>
      x < r.right + 3 && x + b.width > r.left - 3 && y < r.bottom + 3 && y + b.height > r.top - 3;
    const keep = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-safestep-outline],[data-safestep-protection],[role=dialog][aria-modal=true]',
      ),
    ]
      .filter((e) => e.checkVisibility({ checkVisibilityCSS: true }))
      .map((e) => e.getBoundingClientRect());
    const warning = document.querySelector('[data-safestep-protection]');
    if (warning !== observedWarning) {
      warningSize?.disconnect();
      if (warning) warningSize?.observe(warning);
      observedWarning = warning;
    }
    const above = warning?.getBoundingClientRect();
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const end = rtl ? left + gap : left + w - b.width - gap;
    const start = rtl ? left + w - b.width - gap : left + gap;
    const bottom = top + h - b.height - gap;
    const places = [
      [end, bottom],
      ...(above ? [[end, above.top - b.height - gap]] : []),
      [start, bottom],
      [end, top + gap],
      [start, top + gap],
    ];
    for (const pos of places) {
      const x = pos[0]!,
        y = pos[1]!;
      if (y < top + gap || y + b.height > top + h - gap) continue;
      if (keep.some((r) => overlap(x, y, r))) continue;
      host.style.setProperty('left', x + 'px', 'important');
      host.style.setProperty('top', y + 'px', 'important');
      const usable = [0.18, 0.5, 0.82].every((f) =>
        [0.25, 0.75].every((g) => {
          const layers = document.elementsFromPoint(x + f * b.width, y + g * b.height);
          return layers[0] === host && !layers.find((e) => e !== host && !!e.closest(obstacles));
        }),
      );
      if (usable) return true;
    }
    return false;
  }
  const reposition = () => {
    if (active && !frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!place()) lost();
      });
  };
  function show(d: Display) {
    if (
      protectionRouteToken() !== d.route ||
      !document.documentElement ||
      document.visibilityState === 'hidden'
    )
      return false;
    if (!host) {
      host = document.createElement('aside');
      host.setAttribute('data-safestep-dock', '');
      host.setAttribute('data-security', '');
      host.setAttribute('aria-label', 'SafeStep compact controls');
      host.style.cssText =
        'all:initial!important;display:block!important;box-sizing:border-box!important;position:fixed!important;width:max-content!important;max-width:calc(100vw - 20px)!important;z-index:2147483647!important;pointer-events:auto!important;';
      root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host{color-scheme:light}
        nav{display:flex;align-items:center;flex-wrap:wrap;gap:5px 8px;width:max-content;max-width:min(475px,calc(100vw - 24px));box-sizing:border-box;padding:5px 7px;border:1px solid #718176;border-radius:11px;background:#fffaf0;color:#173e34;font:15px/1.3 system-ui,sans-serif;box-shadow:0 2px 10px #172b2533}
        button{box-sizing:border-box;min-height:40px;padding:4px 10px;border:1px solid #8d9c90;border-radius:6px;color:inherit;background:#fffdf7;font:inherit;cursor:pointer}
        .heading{display:flex;align-items:center;min-width:0;max-width:100%}.goal{max-width:30ch;overflow-wrap:anywhere;font:600 17px/1.24 Georgia,serif}
        .opener{display:flex;align-items:center;gap:7px;max-width:100%;padding:2px 4px;border-color:transparent;background:transparent;text-align:start;font:600 17px/1.18 Georgia,serif}
        .opener::after{content:'';width:7px;height:7px;flex:none;margin:0 4px 3px 1px;border-block-end:2px solid currentColor;border-inline-end:2px solid currentColor;transform:rotate(45deg)}
        .mark{display:grid;place-items:center;width:29px;height:29px;border:1px solid #173e34;border-radius:8px;background:#173e34;color:#fffaf0;font:600 20px/1 Georgia,serif}
        .actions{display:flex;flex-wrap:wrap;gap:5px;min-width:0}.actions:empty,[hidden]{display:none!important}
        .instruction{order:1;flex-basis:100%;max-width:42ch;padding:1px 5px;overflow-wrap:anywhere;font-weight:600}
        button[data-action=stop]{color:#733b26;border-color:#b49c90}
        button:hover{background:#e6ebe2}button:focus-visible{outline:3px solid #9a4500;outline-offset:-2px}
        @media(forced-colors:active){nav{border-color:CanvasText}.mark,button{border:1px solid ButtonText}button:focus-visible{outline-color:Highlight}}
      `;
      region = document.createElement('nav');
      region.setAttribute('aria-label', 'SafeStep controls');
      heading = document.createElement('div');
      heading.className = 'heading';
      goal = document.createElement('span');
      goal.className = 'goal';
      heading.append(goal);
      hint = document.createElement('span');
      hint.className = 'instruction';
      hint.hidden = true;
      controls = document.createElement('div');
      controls.className = 'actions';
      region.append(heading, hint, controls);
      root.append(style, region);
      document.documentElement.append(host);
      observer = new MutationObserver((records) => {
        if (!host?.isConnected) {
          lost();
          return;
        }
        if (
          records.some(
            (r) =>
              r.type === 'attributes' ||
              [...r.addedNodes, ...r.removedNodes].some(
                (n) => n instanceof HTMLElement && n !== host,
              ),
          )
        )
          reposition();
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-cue-placement', 'data-cue-visibility','data-cue-caption','data-cue-caption-visible', 'open', 'aria-modal'],
      });
      warningSize = new ResizeObserver(reposition);
    }
    active = d;
    goal!.textContent = d.goal ? goalLabel(d.goal) : '';
    goal!.hidden = !d.goal;
    // Keep surviving buttons (and their actual keyboard focus) on a refresh.
    const previousFocus = root!.activeElement,
      buttons = region!.querySelectorAll<HTMLButtonElement>('button');
    for (const b of buttons) if (!d.actions.includes(b.dataset.action as DockAction)) b.remove();
    for (const action of d.actions) {
      if (region!.querySelector('button[data-action="' + action + '"]')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.action = action;
      if (action === 'open') {
        b.className = 'opener';
        b.setAttribute('aria-label', labels.open);
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = 'S';
        b.setAttribute('title', labels.open);
        b.append(mark, goal!);
      } else {
        b.textContent = labels[action];
      }
      b.addEventListener('click', (event) => {
        const current = active;
        if (
          !event.isTrusted ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.metaKey ||
          !current ||
          !current.actions.includes(action) ||
          !host?.isConnected
        )
          return;
        if (current.route !== protectionRouteToken() || !place()) {
          lost();
          return;
        }
        // Retain Chrome's user activation for Open panel; do not await other work first.
        void message(action, current)
          .then((reply) => {
            if (active !== current) return;
            if (reply?.ok && action === 'open') {
              clear();
              return;
            }
            if (!reply?.ok) {
              // A worker may have restarted. Only the presentation opener remains
              // until a new worker-owned document/task binding is established.
              if (action !== 'open' && !show({ ...current, goal: undefined, actions: ['open'], state: 'paused' }))
                clear();
            }
          })
          .catch(() => {
            if (
              active === current &&
              action !== 'open' &&
              !show({ ...current, goal: undefined, actions: ['open'], state: 'paused' })
            )
              clear();
          });
      });
      if (action === 'open') heading!.prepend(b);
      else controls!.append(b);
    }
    if (!d.goal) {
      goal!.textContent = d.state === 'paused' ? 'Guide paused' : labels.open;
      goal!.hidden = false;
    }
    heading!.querySelector('button')?.setAttribute('aria-label',
      d.goal ? labels.open + ': ' + goal!.textContent : labels.open);
    if (previousFocus && !previousFocus.isConnected)
      region!.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    if (!place()) {
      clear();
      return false;
    }
    setCompactDockHost(host);
    return true;
  }
  chrome.runtime.onMessage.addListener((raw, sender, reply) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js'))
    )
      return;
    const parsed = DockDisplay.safeParse(raw);
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.op === 'clear') {
      if (active?.cap === m.cap) clear();
      reply({ ok: true });
      return;
    }
    reply({ ok: show(m) });
  });
  window.addEventListener('pagehide', clear);
  window.addEventListener('hashchange', reposition);
  window.addEventListener('popstate', reposition);
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.visualViewport?.addEventListener('resize', reposition);
}
