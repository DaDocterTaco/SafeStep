import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicStepInstruction } from '@safestep/contracts';
import { markerBounds, placeMarker, revealOffset } from '../apps/extension/page/cue-geometry';

test('the panel and the pointed-to control use one public instruction without repeating the action', () => {
  assert.equal(publicStepInstruction({ action: 'activate_readonly_link', role: 'link', label: 'Account settings' }), 'Open Account settings');
  assert.equal(publicStepInstruction({ action: 'activate_readonly_link', role: 'link', label: 'Open Account settings' }), 'Open Account settings');
  assert.equal(publicStepInstruction({ action: 'toggle_known_navigation', role: 'button', expanded: false, label: 'Tools' }), 'Open Tools');
  assert.equal(publicStepInstruction({ action: 'reveal_target', role: 'heading', label: 'Examples' }), 'Find Examples');
});

test('an explicit reveal reserves exterior cue clearance and leaves an already fitting fragment alone', () => {
  assert.equal(revealOffset(0.21875, 24.21875, 0, 892, 13), -13);
  assert.equal(revealOffset(864, 888, 0, 892, 13), 9);
  assert.equal(revealOffset(33, 57, 0, 892, 13), 0);
  assert.equal(revealOffset(-50, -26, 65, 185, 13), -128);
  // The complete element fits inside this tight scrollport, but full
  // 13 px margins on both sides are impossible; distribute the spare 6px.
  assert.equal(revealOffset(21, 45, 20, 50, 13), -2);
});

test('the exterior pointer keeps its tip beyond the two-tone outline on each side', () => {
  const b = { left: 80, top: 50, right: 160, bottom: 78 };
  assert.deepEqual(markerBounds('right', b), { left: 173, top: 56, right: 205, bottom: 72 });
  assert.deepEqual(markerBounds('left', b), { left: 35, top: 56, right: 67, bottom: 72 });
  assert.deepEqual(markerBounds('above', b), { left: 112, top: 5, right: 128, bottom: 37 });
  assert.deepEqual(markerBounds('below', b), { left: 112, top: 91, right: 128, bottom: 123 });
});

test('occupied areas and viewport edges choose a free side or an outline-only fallback', (t) => {
  class Element {
    matches() {
      return false;
    }
  }
  let block: (x: number, y: number) => boolean = () => false;
  const locals = {
    document: {
      documentElement: { clientWidth: 320 },
      activeElement: null,
      elementFromPoint: (x: number, y: number) => ({ closest: () => block(x, y) }),
    },
    innerHeight: 200,
    HTMLElement: Element,
    getComputedStyle: () => ({ direction: 'ltr', outlineWidth: '0px', outlineOffset: '0px' }),
  };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(locals)) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => {
    for (const [key, d] of prior) {
      if (d) Object.defineProperty(globalThis, key, d);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const el = new Element() as unknown as HTMLElement;
  const center = { left: 100, top: 80, right: 190, bottom: 110 };
  assert.equal(placeMarker(el, center)?.side, 'right');
  assert.equal(placeMarker(el, { left: 250, top: 60, right: 305, bottom: 89 })?.side, 'left');
  block = (x, y) => y >= center.top && y <= center.bottom;
  assert.equal(placeMarker(el, center)?.side, 'below');
  block = () => true;
  assert.equal(placeMarker(el, center), null);
});
