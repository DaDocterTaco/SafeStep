export class Outline {
  private static targets=new Set<HTMLElement>();
  static protected(region:HTMLElement){return [...this.targets].some(t=>t===region||region.contains(t)||t.contains(region));}
  host: HTMLDivElement | null = null;
  private target: HTMLElement | null = null;
  private frame = 0;
  private bounds = '';
  private orphanCheck: ReturnType<typeof setInterval> | undefined;
  private position = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      if (this.host) this.position();
    });
  };
  private draw() {
    if (!this.host || !this.target?.isConnected) {
      this.clear();
      return;
    }
    const b = this.target.getBoundingClientRect();
    const bounds = [b.left, b.top, b.width, b.height].join(',');
    if (this.bounds === bounds) return;
    this.bounds = bounds;
    for (const [name, value] of Object.entries({
      left: b.left - 3,
      top: b.top - 3,
      width: b.width + 6,
      height: b.height + 6,
    }))
      this.host.style.setProperty(name, value + 'px', 'important');
  }
  show(target: HTMLElement) {
    this.clear();
    this.target = target;
    Outline.targets.add(target);
    const el = document.createElement('div');
    el.dataset.safestepOutline = '';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'all:initial!important;position:fixed!important;display:block!important;pointer-events:none!important;box-sizing:border-box!important;border:3px solid #007664!important;box-shadow:0 0 0 2px white!important;border-radius:7px!important;z-index:2147483647!important;background:transparent!important;';
    this.host = el;
    document.documentElement.append(el);
    this.draw();
    // A preceding image can shift the target without resizing or scrolling it.
    // Only the one selected element is measured, and stable frames write nothing.
    this.position();
    // Selection has no idle timeout. Clean up an orphan if the extension is unloaded.
    this.orphanCheck = setInterval(() => {
      if (!chrome.runtime?.id) this.clear();
    }, 60000);
  }
  clear() {
    if(this.target)Outline.targets.delete(this.target);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearInterval(this.orphanCheck);
    this.bounds = '';
    this.host?.remove();
    this.host = null;
    this.target = null;
  }
}
