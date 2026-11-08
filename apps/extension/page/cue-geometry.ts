type Rect = { left: number; top: number; right: number; bottom: number };
export type CueSide = 'right' | 'left' | 'above' | 'below';
const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function clippedViewport(target: HTMLElement) {
  const area: Rect = {
    left: 0,
    top: 0,
    right: document.documentElement.clientWidth,
    bottom: window.innerHeight,
  };
  for (let p = target.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (!/(?:hidden|clip|scroll|auto)/.test(style.overflowX + ' ' + style.overflowY)) continue;
    const b = p.getBoundingClientRect();
    if (/hidden|clip|scroll|auto/.test(style.overflowX)) {
      area.left = Math.max(area.left, b.left + p.clientLeft);
      area.right = Math.min(area.right, b.left + p.clientLeft + p.clientWidth);
    }
    if (/hidden|clip|scroll|auto/.test(style.overflowY)) {
      area.top = Math.max(area.top, b.top + p.clientTop);
      area.bottom = Math.min(area.bottom, b.top + p.clientTop + p.clientHeight);
    }
  }
  return area;
}
export function withinScrollArea(target: HTMLElement) {
  const area = clippedViewport(target);
  return [...target.getClientRects()].some((b) => {
    if (!overlaps(b, area)) return false;
    const w = Math.min(b.right, area.right) - Math.max(b.left, area.left);
    const h = Math.min(b.bottom, area.bottom) - Math.max(b.top, area.top);
    return w > 0 && h > 0 && w * h >= b.width * b.height * 0.6;
  });
}

/** Smallest displacement that fits the actionable fragment and its exterior
 * cue inside one scrollport. An oversized fragment cannot fit on both edges. */
export function revealOffset(start: number, end: number, low: number, high: number, inset: number) {
  const margin = Math.min(inset, Math.max(0, (high - low - (end - start)) / 2));
  const near = start - low - margin,
    far = end - high + margin;
  if (near < 0 && far > 0) return 0;
  if (near < 0) return Math.floor(near);
  if (far > 0) return Math.ceil(far);
  return 0;
}

/** Explicit/approved reveals only. Scroll the actual nested scrollports from
 * inside out; drawing or tracking the cue never calls this method. */
export function revealCue(target: HTMLElement) {
  const el = cueSurface(target),
    style = getComputedStyle(el);
  const nativeEdge = target.matches(':focus-visible')
    ? (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0)
    : 0;
  const inset = Math.max(13, nativeEdge + 8);
  function align(area: Rect, x: boolean, y: boolean, scroll: (dx: number, dy: number) => void) {
    let best: { dx: number; dy: number; distance: number } | null = null;
    for (const f of el.getClientRects()) {
      if (!f.width || !f.height) continue;
      const dx = x ? revealOffset(f.left, f.right, area.left, area.right, inset) : 0;
      const dy = y ? revealOffset(f.top, f.bottom, area.top, area.bottom, inset) : 0;
      const distance = Math.abs(dx) + Math.abs(dy);
      if (!best || distance < best.distance) best = { dx, dy, distance };
    }
    if (best?.distance) scroll(best.dx, best.dy);
  }
  for (
    let p = el.parentElement;
    p && p !== document.scrollingElement && p !== document.documentElement;
    p = p.parentElement
  ) {
    const s = getComputedStyle(p);
    const x = /(auto|scroll|hidden|overlay)/.test(s.overflowX) && p.scrollWidth > p.clientWidth;
    const y = /(auto|scroll|hidden|overlay)/.test(s.overflowY) && p.scrollHeight > p.clientHeight;
    if (!x && !y) continue;
    const r = p.getBoundingClientRect(),
      left = r.left + p.clientLeft,
      top = r.top + p.clientTop;
    const port = p;
    align(
      { left, top, right: left + p.clientWidth, bottom: top + p.clientHeight },
      x,
      y,
      (dx, dy) => port.scrollBy({ left: dx, top: dy, behavior: 'instant' }),
    );
  }
  align(
    { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: innerHeight },
    true,
    true,
    (dx, dy) => window.scrollBy({ left: dx, top: dy, behavior: 'instant' }),
  );
}
// An opacity-zero native checkbox can be the real click receiver for its
// visible label. Require their DOM relationship and overlapping rectangles.
export function cueSurface(el: HTMLElement): HTMLElement {
  if (
    !(el instanceof HTMLInputElement) ||
    !['checkbox', 'radio'].includes(el.type) ||
    el.disabled ||
    getComputedStyle(el).opacity !== '0' ||
    el.labels?.length !== 1
  )
    return el;
  const label = el.labels[0];
  if (
    !label ||
    label.control !== el ||
    !label.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return el;
  const a = el.getBoundingClientRect(),
    b = label.getBoundingClientRect();
  return a.width > 0 && a.height > 0 && overlaps(a, b) ? label : el;
}
export function visibleCueRect(target: HTMLElement, actionTarget = target) {
  const bounds = clippedViewport(target);
  let intersects = false;
  // A wrapped inline link has several actual rectangles. Its bounding-box
  // center may hit a neighboring control or whitespace between lines.
  const fragments = [...target.getClientRects()]
    .filter((r) => r.width > 0 && r.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  for (const box of fragments) {
    if (!overlaps(box, bounds)) continue;
    intersects = true;
    const r = {
      left: Math.max(box.left, bounds.left),
      top: Math.max(box.top, bounds.top),
      right: Math.min(box.right, bounds.right),
      bottom: Math.min(box.bottom, bounds.bottom),
    };
    const w = r.right - r.left,
      h = r.bottom - r.top;
    if (w < Math.min(12, box.width * 0.75) || h < Math.min(12, box.height * 0.75)) continue;
    if (w * h < box.width * box.height * 0.6) continue;
    const hit = document.elementFromPoint(r.left + w / 2, r.top + h / 2);
    if (
      hit === target ||
      hit === actionTarget ||
      (hit && target.contains(hit)) ||
      (hit instanceof HTMLLabelElement && hit.control === target)
    )
      return { rect: r, status: 'visible' } as const;
  }
  return { rect: null, status: intersects ? 'occluded' : 'offscreen' } as const;
}
const protectedElements =
  'a[href],button,input,select,textarea,summary,h1,h2,h3,h4,[role="heading"],[tabindex],[contenteditable],[data-security],[data-safestep-dock],[data-safestep-protection],[data-shopping-evidence],[data-consent],[role="alert"],[role="dialog"]';
export function markerBounds(side: CueSide, b: Rect, gap = 13) {
  const horizontal = side === 'right' || side === 'left';
  const width = horizontal ? 32 : 16,
    height = horizontal ? 16 : 32;
  const left =
    side === 'right'
      ? b.right + gap
      : side === 'left'
        ? b.left - gap - width
        : (b.left + b.right - width) / 2;
  const top =
    side === 'above'
      ? b.top - gap - height
      : side === 'below'
        ? b.bottom + gap
        : (b.top + b.bottom - height) / 2;
  return { left, top, right: left + width, bottom: top + height };
}
function vacant(r: Rect) {
  if (
    r.left < 8 ||
    r.top < 8 ||
    r.right > document.documentElement.clientWidth - 8 ||
    r.bottom > innerHeight - 8
  )
    return false;
  const focused = document.activeElement;
  if (
    focused instanceof HTMLElement &&
    focused !== document.body &&
    overlaps(focused.getBoundingClientRect(), r)
  )
    return false;
  // Test the indicator footprint against the actual hit stack. The cue's own
  // closed, pointer-transparent host never contributes a site obstacle.
  for (const x of [
    r.left + 1,
    (r.left * 3 + r.right) / 4,
    (r.left + r.right) / 2,
    (r.left + r.right * 3) / 4,
    r.right - 1,
  ]) {
    for (const y of [r.top + 1, (r.top + r.bottom) / 2, r.bottom - 1]) {
      if (document.elementFromPoint(x, y)?.closest(protectedElements)) return false;
    }
  }
  return true;
}
export function placeMarker(
  target: HTMLElement,
  box: Rect,
  previous?: CueSide,
  tip?: { width: number; height: number },
) {
  const style = getComputedStyle(target),
    rtl = style.direction === 'rtl';
  const sides: CueSide[] = [
    ...(previous ? [previous] : []),
    ...(rtl ? (['left', 'right'] as const) : (['right', 'left'] as const)),
    'below',
    'above',
  ];
  // Five pixels of the two-tone outline plus an eight-pixel clear gap. A
  // wider native focus ring can push the marker farther from the target.
  const focusEdge = target.matches(':focus-visible')
    ? (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0)
    : 0;
  let arrowOnly: {side:CueSide;marker:Rect;label:Rect|null} | null = null;
  for (const side of new Set(sides)) {
    const marker = markerBounds(side, box, Math.max(5, focusEdge) + 8);
    if (!vacant(marker)) continue;
    let label: Rect | null = null;
    if (tip?.width && tip.height) {
      const left =
        side === 'right'
          ? marker.right + 4
          : side === 'left'
            ? marker.left - tip.width - 4
            : (marker.left + marker.right - tip.width) / 2;
      const top =
        side === 'above'
          ? marker.top - tip.height - 4
          : side === 'below'
            ? marker.bottom + 4
            : (marker.top + marker.bottom - tip.height) / 2;
      const proposed = { left, top, right: left + tip.width, bottom: top + tip.height };
      if (vacant(proposed)) label = proposed;
    }
    if (!tip || label) return { side, marker, label };
    arrowOnly ??= { side, marker, label: null };
  }
  // A search suggestion list can occupy the whole width below the field
  // while its submit button occupies the right edge. Point at the corner
  // from the adjoining clear space, without drawing over either control.
  if (tip?.width && tip.height) {
    for (const side of (rtl ? ['left','right'] : ['right','left']) as ('right'|'left')[]) {
      const left = side==='right' ? box.right+9 : box.left-41;
      const top = box.bottom+9;
      const marker = {left,top,right:left+32,bottom:top+24};
      const x = side==='right' ? marker.right+4 : left-tip.width-4;
      const label = {left:x,top,right:x+tip.width,bottom:top+tip.height};
      if (vacant(marker) && vacant(label)) return {side, marker, label, diagonal:true};
    }
  }
  return arrowOnly;
}
