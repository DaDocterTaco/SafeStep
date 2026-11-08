import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function until(fn, label, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      last = e;
    }
    await delay(70);
  }
  throw Error('Timed out: ' + label + (last ? ' (' + String(last.message).slice(0, 90) + ')' : ''));
}
export const button = (p, text) =>
  p.locator('::-p-aria(' + text + '[role="button"])').setTimeout(7000);
function children(n) {
  return [...(n.children ?? []), ...(n.shadowRoots ?? [])];
}
function find(n, match) {
  if (match(n)) return n;
  for (const c of children(n)) {
    const found = find(c, match);
    if (found) return found;
  }
}
function attr(n, k) {
  const a = n.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === k) return a[i + 1];
  return null;
}
function textOf(n) {
  return (n.nodeType === 3 ? n.nodeValue : '') + children(n).map(textOf).join('');
}
function elementMetrics() {
  const r = this.getBoundingClientRect(),
    c = getComputedStyle(this);
  return {
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    visible:
      this.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      r.width > 0 &&
      r.height > 0,
    pointer: c.pointerEvents,
    tabIndex: this.tabIndex,
    focused: this.matches(':focus'),
    focusVisible: this.matches(':focus-visible'),
    color: c.color,
    background: c.backgroundColor,
    border: c.borderTopColor,
    outline: c.outlineStyle,
    outlineColor: c.outlineColor,
    transition: c.transitionDuration,
    animations: this.getAnimations({ subtree: true }).filter((a) => a.playState === 'running')
      .length,
    role: this.getAttribute('role'),
    live: this.getAttribute('aria-live'),
    afterMarker:
      this.tagName === 'BUTTON'
        ? {
            content: getComputedStyle(this, '::after').content,
            width: getComputedStyle(this, '::after').width,
            height: getComputedStyle(this, '::after').height,
          }
        : null,
  };
}
async function metrics(cdp, n) {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendNodeId });
  try {
    return (
      await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: elementMetrics.toString(),
        returnByValue: true,
      })
    ).result.value;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
// Use the debug protocol read-only to observe extension-owned closed shadow
// nodes. Never attach a new shadow root or replace product event handlers.
export async function overlay(s, type = 'outline') {
  const cdp = s.tabSession;
  const tree = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })).root;
  const host = find(tree, (n) => attr(n, 'data-safestep-' + type) !== null);
  if (!host) return null;
  const o = {
    host: await metrics(cdp, host),
    shadow: (host.shadowRoots ?? []).map((n) => n.shadowRootType),
    text: '',
    instruction: '',
    buttons: [],
  };
  if (type === 'outline') {
    const description = find(tree, (n) => attr(n, 'data-safestep-instruction') !== null);
    o.instruction = description ? textOf(description).trim() : '';
    o.placement = attr(host, 'data-cue-placement');
    o.manual = attr(host,'data-manual-guide') === 'true';
  }
  for (const sh of host.shadowRoots ?? []) {
    if (type === 'protection') {
      o.mode = attr(host, 'data-warning-mode');
      o.warningStyle = attr(host,'data-warning-style');
      o.panelPresent = attr(host, 'data-panel-present');
      const list = find(sh, (n) => n.nodeName === 'DL'),
        message = find(sh, (n) => attr(n, 'role') === 'alert');
      o.hostRows = (list && (await metrics(cdp, list)).visible ? (list.children ?? []) : [])
        .filter((n) => n.nodeName === 'DIV')
        .map((row) => [
          textOf(find(row, (n) => n.nodeName === 'DT')),
          textOf(find(row, (n) => n.nodeName === 'DD')),
        ]);
      o.findings = (message?.children ?? []).filter((n) => n.nodeName === 'P').map(textOf);
      const marked = find(sh, (n) => n.nodeName === 'MARK');
      o.emphasis = marked ? textOf(marked) : null;
    }
    if (type === 'outline') {
      const marker = find(sh, (n) => attr(n, 'data-safestep-marker') !== null);
      if (marker) o.marker = await metrics(cdp, marker);
    }
    const hint =
      find(sh, (n) => attr(n, 'data-safestep-hint') !== null) ??
      (type === 'dock'
        ? find(sh, (n) => attr(n, 'class')?.split(/\s+/).includes('instruction'))
        : null) ??
      (type === 'dock'
        ? find(
            sh,
            (n) =>
              ['SPAN', 'P', 'DIV', 'ASIDE'].includes(n.nodeName) &&
              n.children?.some((c) => c.nodeType === 3 && c.nodeValue.trim()),
          )
        : null);
    if ((type === 'outline' || type === 'dock') && hint) {
      o.hint = await metrics(cdp, hint);
      o.text = textOf(hint).replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    async function visit(n) {
      if (n.nodeName === 'BUTTON' || n.nodeName === 'A' || n.nodeName === 'SUMMARY') {
        const name = (attr(n, 'aria-label') || textOf(n)).trim();
        if (name)
          o.buttons.push({
            name,
            text: textOf(n).trim(),
            backendNodeId: n.backendNodeId,
            ...(await metrics(cdp, n)),
          });
      }
      for (const c of children(n)) await visit(c);
    }
    if (type !== 'outline') await visit(sh);
  }
  return o;
}
export async function dockControl(s, name, activate = false) {
  const node = await until(async () => {
    const dock = await overlay(s, 'dock');
    const button = dock?.buttons.find(
      (b) =>
        (b.name === name ||
          (['Show step', 'Open SafeStep'].includes(name) && b.name.startsWith(name + ':'))) &&
        b.visible,
    );
    if (!button || !activate) return button;
    const x = Math.round(button.rect.x + button.rect.w / 2),
      y = Math.round(button.rect.y + button.rect.h / 2);
    const { object } = await s.tabSession.send('DOM.resolveNode', {
      backendNodeId: button.backendNodeId,
    });
    try {
      const answer = await s.tabSession.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        arguments: [{ value: x }, { value: y }],
        functionDeclaration:
          'function(x,y){const root=this.getRootNode();return this.isConnected && document.elementFromPoint(x,y)===root.host && root.elementFromPoint(x,y)?.closest("button")===this;}',
      });
      return answer.result.value && button;
    } finally {
      await s.tabSession.send('Runtime.releaseObject', { objectId: object.objectId });
    }
  }, 'visible compact control ' + name);
  if (activate)
    await s.page.mouse.click(node.rect.x + node.rect.w / 2, node.rect.y + node.rect.h / 2);
  return node;
}
export async function currentTarget(s, selector) {
  return s.page.$eval(selector, (e) => {
    const b = e.getBoundingClientRect(),
      x = b.left + b.width / 2,
      y = b.top + b.height / 2,
      front = document.elementFromPoint(x, y);
    const ids = (e.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    return {
      rect: { x: b.x, y: b.y, w: b.width, h: b.height },
      label: e.innerText,
      hit: !!front && e.contains(front),
      focus: document.activeElement === e,
      scrollY: window.scrollY,
      viewport: { w: innerWidth, h: innerHeight },
      route: location.pathname,
      descriptionIds: ids,
      extensionDescriptions: ids
        .map((id) => document.getElementById(id))
        .filter((el) => el?.hasAttribute('data-safestep-instruction'))
        .map((el) => el.textContent),
    };
  });
}
const near = (x, y) => Math.abs(x - y) <= 3;
export function aligned(outer, t) {
  return (
    outer &&
    t &&
    near(outer.x, t.x - 3) &&
    near(outer.y, t.y - 3) &&
    near(outer.w, t.w + 6) &&
    near(outer.h, t.h + 6)
  );
}
export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
export function verifyCue(c, t) {
  assert(
    c && c.marker?.visible && c.instruction,
    'visible passive arrow and one accessible instruction',
  );
  assert.equal(c.host.pointer, 'none');
  assert.equal(c.marker.pointer, 'none');
  assert(c.marker.tabIndex < 0);
  assert.deepEqual(t.extensionDescriptions, [c.instruction]);
  assert(
    !c.hint?.visible || (c.manual ? c.text === c.instruction && !overlaps(c.hint.rect,c.host.rect) : !t.label.trim()),
    'a visible manual caption matches the description and stays outside the target',
  );
  assert(c.shadow.includes('closed'));
  assert(aligned(c.host.rect, t.rect), 'outline follows the selected target box');
  assert(!overlaps(c.marker.rect, c.host.rect), 'arrow stays outside the ring');
  assert(t.hit, 'target center receives the hit');
  const h = c.marker.rect,
    v = t.viewport;
  assert(
    h.x >= 1 && h.y >= 1 && h.x + h.w <= v.w - 1 && h.y + h.h <= v.h - 1,
    'visible hint remains inside measured viewport',
  );
}
export async function panelClosed(s) {
  return !(await s.root.send('Target.getTargets', { filter: [{}] })).targetInfos.some((t) =>
    t.url.endsWith(s.id + '/sidepanel.html'),
  );
}
export async function reopen(s, viaDock = true) {
  if (viaDock) await dockControl(s, 'Open SafeStep', true);
  else {
    await s.page.bringToFront();
    await s.activate(s.page);
  }
  s.panel = await (
    await s.browser.waitForTarget(
      (t) => t.url() === 'chrome-extension://' + s.id + '/sidepanel.html',
      { timeout: 8000 },
    )
  ).asPage();
  await s.panel.waitForSelector('#chat-composer');
}
export async function media(s, reduce, forced = false) {
  const features = [
    { name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' },
    { name: 'forced-colors', value: forced ? 'active' : 'none' },
  ];
  await s.tabSession.send('Emulation.setEmulatedMedia', { features });
  const cp = await s.panel.createCDPSession();
  try {
    await cp.send('Emulation.setEmulatedMedia', { features });
  } finally {
    await cp.detach();
  }
}
export async function panelContrast(panel) {
  return panel.evaluate(() => {
    const parse = (value) => {
      const match =
        /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value);
      return match
        ? [
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
            match[4] === undefined ? 1 : Number(match[4]),
          ]
        : null;
    };
    const over = (rgb, bg) => rgb.slice(0, 3).map((v, i) => rgb[3] * v + (1 - rgb[3]) * bg[i]);
    const luminance = (rgb) =>
      rgb
        .slice(0, 3)
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    return [
      ...document.querySelectorAll(
        'header h1,header strong,header button,#chat-composer,.site-warning strong',
      ),
    ]
      .filter((e) => e.checkVisibility() && !e.disabled)
      .slice(0, 8)
      .map((e) => {
        const s = getComputedStyle(e),
          fg = parse(s.color);
        let base = [255, 255, 255],
          p = e,
          colors = [];
        while (p) {
          colors.unshift(parse(getComputedStyle(p).backgroundColor));
          p = p.parentElement;
        }
        for (const c of colors) if (c) base = over(c, base);
        const lf = fg && luminance(over(fg, base)),
          lb = luminance(base);
        return {
          label: e.getAttribute('aria-label') || e.textContent?.trim().slice(0, 70) || e.id,
          color: s.color,
          background: base.map((v) => Math.round(v)),
          font: s.fontSize,
          ratio:
            lf === null
              ? null
              : +((Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05)).toFixed(2),
        };
      });
  });
}
