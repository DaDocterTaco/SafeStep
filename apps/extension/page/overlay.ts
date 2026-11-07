export class Outline {
  host: HTMLDivElement | null = null;
  private target: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private frame = 0;
  private orphanCheck: ReturnType<typeof setInterval> | undefined;
  private position = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  };
  private draw() {
    if (!this.host || !this.target?.isConnected) {
      this.clear();
      return;
    }
    const b = this.target.getBoundingClientRect();
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
    const el = document.createElement('div');
    el.dataset.safestepOutline = '';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'all:initial!important;position:fixed!important;display:block!important;pointer-events:none!important;box-sizing:border-box!important;border:3px solid #007664!important;box-shadow:0 0 0 2px white!important;border-radius:7px!important;z-index:2147483647!important;background:transparent!important;';
    this.host = el;
    document.documentElement.append(el);
    this.draw();
    this.observer = new ResizeObserver(this.position);
    this.observer.observe(target);
    window.addEventListener('scroll', this.position, true);
    window.addEventListener('resize', this.position);
    // Selection has no idle timeout. Clean up an orphan if the extension is unloaded.
    this.orphanCheck = setInterval(() => {
      if (!chrome.runtime?.id) this.clear();
    }, 60000);
  }
  clear() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearInterval(this.orphanCheck);
    this.observer?.disconnect();
    window.removeEventListener('scroll', this.position, true);
    window.removeEventListener('resize', this.position);
    this.host?.remove();
    this.host = null;
    this.target = null;
  }
}
