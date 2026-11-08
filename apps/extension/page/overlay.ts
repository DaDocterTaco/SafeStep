import { cueSurface, placeMarker, visibleCueRect, type CueSide } from './cue-geometry';
import { writeCueDescription } from './cue-owned';

function publicLabel(el: HTMLElement) {
  const text =
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    (el.matches('input,select,textarea,[contenteditable]') ? '' : el.innerText);
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
}
function identity(el: HTMLElement) {
  return JSON.stringify([
    el.tagName,
    el.id,
    el.getAttribute('role'),
    publicLabel(el),
    el instanceof HTMLAnchorElement ? el.href : null,
  ]);
}

export class Outline {
  private static active = new Map<Outline, HTMLElement>();
  static protected(region: HTMLElement) {
    return [...this.active].some(([cue, target]) =>
      [target, cue.surface].some(
        (el) => el && (el === region || region.contains(el) || el.contains(region)),
      ),
    );
  }
  static currentInstruction() {
    const active = [...this.active.keys()].at(-1);
    if (!active?.host || !active.target?.isConnected) return null;
    return {
      text: active.instruction,
      visibility: active.host.dataset.cueVisibility,
      placement: active.host.dataset.cuePlacement,
      caption: active.host.dataset.cueCaptionVisible === 'true',
    };
  }
  host: HTMLDivElement | null = null;
  private marker: HTMLElement | null = null;
  private tip: HTMLElement | null = null;
  private descriptionId = '';
  private description: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private surface: HTMLElement | null = null;
  private frame = 0;
  private geometry = '';
  private side?: CueSide;
  private signature = '';
  private surfaceSignature = '';
  private route = '';
  private href: string | null = null;
  private instruction = '';
  private visibilityChanged?: (visibility:'visible'|'offscreen'|'occluded')=>void;
  private checkIdentity = true;
  private lastProbe = 0;
  private frameBounds = '';
  private invalidate = () => {
    this.frameBounds = '';
  };
  private changes: MutationObserver | null = null;

  private draw = () => {
    const el = this.target,
      host = this.host,
      arrow = this.marker;
    if (
      !el?.isConnected ||
      !host?.isConnected ||
      !this.description?.isConnected ||
      !arrow ||
      !chrome.runtime?.id ||
      location.href !== this.route ||
      el.matches(':disabled,[aria-disabled=true]') ||
      el.closest('[hidden],[inert]') ||
      (el instanceof HTMLAnchorElement && el.href !== this.href) ||
      (this.checkIdentity && identity(el) !== this.signature)
    ) {
      this.clear();
      return;
    }
    const surface = cueSurface(el);
    if (
      surface !== this.surface ||
      !surface.isConnected ||
      (surface !== el && this.checkIdentity && identity(surface) !== this.surfaceSignature)
    ) {
      this.clear();
      return;
    }
    const box = surface.getBoundingClientRect(),
      now = performance.now();
    const bounds = [box.x, box.y, box.width, box.height, innerWidth, innerHeight].join('/');
    if (!this.checkIdentity && this.frameBounds === bounds && now - this.lastProbe < 140) {
      this.frame = requestAnimationFrame(this.draw);
      return;
    }
    this.frameBounds = bounds;
    this.lastProbe = now;
    this.checkIdentity = false;
    const visible = surface.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ? visibleCueRect(surface, el)
      : { rect: null, status: 'occluded' as const };
    const b = visible.rect;
    const candidate = b
      ? placeMarker(
          surface,
          b,
          this.side,
          this.tip ? { width: this.tip.offsetWidth, height: this.tip.offsetHeight } : undefined,
        )
      : null;
    const key = JSON.stringify([b, visible.status, candidate]);
    if (key !== this.geometry) {
      this.geometry = key;
      host.dataset.cueVisibility = visible.status;
      host.dataset.cuePlacement = candidate?.side ?? 'panel';
      host.dataset.cueCaptionVisible = String(!!candidate?.label);
      host.style.setProperty('visibility', b ? 'visible' : 'hidden', 'important');
      if (b) {
        for (const [name, value] of Object.entries({
          left: b.left - 3,
          top: b.top - 3,
          width: b.right - b.left + 6,
          height: b.bottom - b.top + 6,
        }))
          host.style.setProperty(name, value + 'px', 'important');
      }
      arrow.style.visibility = candidate ? 'visible' : 'hidden';
      if (candidate) {
        this.side = candidate.side;
        arrow.dataset.side = candidate.side;
        arrow.style.setProperty('--turn', 'diagonal' in candidate && candidate.diagonal
          ? (candidate.side==='right' ? '45deg':'135deg')
          : ({right:'0deg',left:'180deg',above:'-90deg',below:'90deg'}[candidate.side]));
        const r = candidate.marker;
        Object.assign(arrow.style, {
          left: r.left + 'px',
          top: r.top + 'px',
          width: r.right - r.left + 'px',
          height: r.bottom - r.top + 'px',
        });
      }
      if (this.tip) {
        const r = candidate?.label;
        this.tip.style.visibility = r ? 'visible' : 'hidden';
        if (r) Object.assign(this.tip.style, { left: r.left + 'px', top: r.top + 'px' });
      }
      this.visibilityChanged?.(visible.status);
    }
    this.frame = requestAnimationFrame(this.draw);
  };

  updateInstruction(words:string) {
    if (!this.host || this.instruction === words) return;
    this.instruction = words;
    if (this.description) this.description.textContent = words;
    if (this.tip) this.tip.textContent = words;
    this.host.dataset.cueCaption = words;
    this.frameBounds = this.geometry = '';
  }

  show(target: HTMLElement, instruction?: string, manual?: {onVisibility?:(value:'visible'|'offscreen'|'occluded')=>void}) {
    const surface = cueSurface(target);
    const label = publicLabel(target) || publicLabel(surface);
    const verb = target.matches('summary,[aria-expanded]')
      ? target.getAttribute('aria-expanded') === 'true'
        ? 'Close '
        : 'Open '
      : 'Select ';
    const words = (instruction?.trim() || (label ? verb + label : 'Use this control')).slice(
      0,
      144,
    );
    // An explicit reveal of exactly the same live binding should not reannounce
    // its description or replay the acquisition animation.
    if (
      this.host?.isConnected &&
      this.target === target &&
      this.surface === surface &&
      this.route === location.href &&
      this.signature === identity(target) &&
      this.surfaceSignature === identity(surface) &&
      (manual ? !!this.host.dataset.manualGuide : !this.host.dataset.manualGuide)
    ) {
      this.visibilityChanged = manual?.onVisibility;
      this.updateInstruction(words);
      this.invalidate();
      return;
    }
    this.clear();
    for (const other of Outline.active.keys()) other.clear();
    this.target = target;
    this.surface = surface;
    this.surfaceSignature = identity(this.surface);
    this.signature = identity(target);
    this.route = location.href;
    this.href = target instanceof HTMLAnchorElement ? target.href : null;
    Outline.active.set(this, target);
    const host = document.createElement('div');
    host.dataset.safestepOutline = '';
    if (manual) host.dataset.manualGuide = 'true';
    this.visibilityChanged = manual?.onVisibility;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial!important;position:fixed!important;display:block!important;pointer-events:none!important;box-sizing:border-box!important;border:3px solid #007664!important;box-shadow:0 0 0 2px white!important;border-radius:7px!important;z-index:2147483646!important;background:transparent!important;visibility:hidden!important;';
    const root = host.attachShadow({ mode: 'closed' }),
      style = document.createElement('style');
    style.textContent = `
      [data-safestep-marker],[data-safestep-hint]{position:fixed;box-sizing:border-box;visibility:hidden;pointer-events:none;color:#173e34}
      .shape{position:absolute;left:50%;top:50%;width:32px;height:16px;transform:translate(-50%,-50%) rotate(var(--turn,0deg))}
      [data-side=left]{--turn:180deg}[data-side=above]{--turn:-90deg}[data-side=below]{--turn:90deg}
      .shape::before{content:"";position:absolute;box-sizing:border-box;left:2px;top:3px;width:10px;height:10px;border-left:3px solid currentColor;border-bottom:3px solid currentColor;border-radius:1px;transform:rotate(45deg)}
      .shaft{position:absolute;left:3px;right:1px;top:6.5px;height:3px;border-radius:3px;background:currentColor;transform-origin:left center}
      @keyframes cue-arrive{from{transform:scaleX(.3)}to{transform:scaleX(1)}}
      @media(prefers-reduced-motion:no-preference){.shaft{animation:cue-arrive 140ms ease-out both}}
      [data-safestep-hint]{max-width:min(175px,55vw);padding:3px 7px;border:1px solid #a4ada4;border-radius:5px;background:#fffaf0;font:14px/1.3 system-ui,sans-serif;overflow-wrap:anywhere}
      @media(forced-colors:active){:host{border-color:Highlight!important;box-shadow:0 0 0 2px Canvas!important}[data-safestep-marker]{color:Highlight;forced-color-adjust:none}[data-safestep-hint]{color:CanvasText;background:Canvas;border-color:CanvasText}}
    `;
    const arrow = document.createElement('span'),
      shape = document.createElement('span'),
      shaft = document.createElement('span');
    arrow.dataset.safestepMarker = '';
    shape.className = 'shape';
    shaft.className = 'shaft';
    shape.append(shaft);
    arrow.append(shape);
    root.append(style, arrow);
    // A visible site label already tells the person what to use. A short
    // public name may additionally disambiguate an icon if there is space.
    if (manual || (
      !surface.innerText?.trim() &&
      label &&
      label.length <= 45 &&
      !surface.matches('input,textarea,[contenteditable]')
    )) {
      this.tip = document.createElement('span');
      this.tip.dataset.safestepHint = '';
      this.tip.textContent = manual ? words : label;
      root.append(this.tip);
    }
    this.instruction = words;
    const description = document.createElement('span');
    this.descriptionId = 'safestep-step-' + crypto.randomUUID();
    description.id = this.descriptionId;
    description.hidden = true;
    description.style.setProperty('display','none','important');
    description.dataset.safestepInstruction = '';
    description.textContent = words;
    this.description = description;
    this.host = host;
    this.marker = arrow;
    this.changes = new MutationObserver(() => {
      this.checkIdentity = true;
    });
    const watch: MutationObserverInit = {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'aria-label', 'title', 'href', 'role', 'disabled', 'hidden'],
    };
    this.changes.observe(target, watch);
    if (target !== this.surface) this.changes.observe(this.surface, watch);
    // Keep the ID target in the rendered light tree. A non-slotted light
    // child of the closed outline host is omitted by Chrome's AX description
    // calculation, even though document.getElementById can resolve it.
    document.documentElement.append(description, host);
    // The existing panel supplies the live announcement. This non-live,
    // directly referenced description is available when focusing the real
    // page control; it does not replace its native name or descriptions.
    const current = target.getAttribute('aria-describedby')?.trim() ?? '';
    writeCueDescription(target, [current, this.descriptionId].filter(Boolean).join(' '));
    document.addEventListener('scroll', this.invalidate, true);
    document.addEventListener('focusin', this.invalidate, true);
    window.addEventListener('resize', this.invalidate);
    this.draw();
  }

  clear() {
    Outline.active.delete(this);
    cancelAnimationFrame(this.frame);
    document.removeEventListener('scroll', this.invalidate, true);
    document.removeEventListener('focusin', this.invalidate, true);
    window.removeEventListener('resize', this.invalidate);
    this.changes?.disconnect();
    this.changes = null;
    this.checkIdentity = true;
    this.frame = 0;
    this.geometry = '';
    this.frameBounds = '';
    this.side = undefined;
    if (this.target && this.descriptionId) {
      const refs = this.target.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
      if (refs.includes(this.descriptionId)) {
        const remaining = refs.filter((id) => id !== this.descriptionId);
        writeCueDescription(this.target, remaining.length ? remaining.join(' ') : null);
      }
    }
    this.descriptionId = '';
    this.description?.remove();
    this.description = null;
    this.visibilityChanged = undefined;
    this.host?.remove();
    this.host = null;
    this.marker = null;
    this.tip = null;
    this.target = null;
    this.surface = null;
    this.route = '';
    this.href = null;
    this.instruction = '';
  }
}
