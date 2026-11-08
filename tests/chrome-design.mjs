// Builder-only native panel checks. Uses disposable practice pages and an
// explicitly intercepted address-mismatch example. No human or screen reader
// session is inferred from browser automation, DOM observations or screenshots.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeSession } from './support/native-stage2.mjs';
import { view } from './support/chrome-cases.mjs';
import { startFixture } from './fixtures/serve.mjs';
import { fingerprint } from '../scripts/stage1.mjs';
import {
  until,
  button,
  overlay,
  dockControl,
  currentTarget,
  verifyCue,
  aligned,
  overlaps,
  panelClosed,
  reopen,
  media,
  panelContrast,
} from './support/design-cues.mjs';

const designCases = {
  cue: ['DG01', 'DG02', 'DG03', 'DG04', 'DG11'],
  replacement: ['DG03', 'DG04', 'DG10'],
  clip: ['DG02', 'DG03'],
  edges: ['DG01', 'DG02', 'DG03'],
  tuck: ['DG06', 'DG08', 'DG11'],
  restart: ['DG06', 'DG10', 'DG11'],
  autoPause: ['DG04', 'DG06', 'DG11'],
  autoTakeover: ['DG04', 'DG06', 'DG11'],
  autoStop: ['DG04', 'DG06', 'DG11'],
  rapidStop: ['DG04', 'DG06', 'DG10'],
  privacy: ['DG04', 'DG10'],
  cleanup: ['DG07', 'DG10'],
  warning: ['DG05', 'DG12'],
  access: ['DG08', 'DG09', 'DG12'],
  file: ['DG04', 'DG10'],
};
if (process.argv.includes('--plan')) {
  console.log(
    JSON.stringify(
      {
        caseGroups: designCases,
        viewports: [
          [1440, 900],
          [1366, 768],
        ],
        measure:
          'Zoom 1.0; record closed/open content and native panel dimensions, actual rendered target/hint rectangles, pointer hits, screenshots, accessible names, focus and links. No new grants except the explicit selected-site warning fixture. No model or threat calls.',
        separate:
          'Screen reader speech, human effectiveness, physical high-contrast settings, left-panel location, 200%/320px native reflow and independent QA need their own evidence.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const build = process.argv[2];
assert.match(build, /^stage-8-[a-f0-9]{12}$/);
const bundle = resolve('artifacts', build, 'chrome-mv3'),
  expected = JSON.parse(
    await readFile(resolve('docs/evidence', build, 'current-reference.json'), 'utf8'),
  );
const digest = await fingerprint(bundle);
assert.equal(digest.sha256, expected.extensionSHA256);
const groupList = (process.env.SAFESTEP_DG_GROUPS ?? Object.keys(designCases).join(',')).split(',');
assert(groupList.every((k) => Object.hasOwn(designCases, k)));
const widthList = process.env.SAFESTEP_WIDTH ? [Number(process.env.SAFESTEP_WIDTH)] : [1440, 1366];
assert(widthList.every((w) => [1440, 1366].includes(w)));
const out = resolve(
  'docs/evidence',
  build,
  'design-native',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(out, { recursive: true });
const lab = await startFixture(0),
  rows = [];
const summary = {
  role: 'builder',
  build,
  extensionSHA256: digest.sha256,
  sourceSHA256: expected.sourceSHA256,
  coverage:
    'Disposable installed Chrome, native panel at 100% zoom, labelled harmless fixture pages. No public AI/provider requests. No human/speech observations or independent acceptance.',
  unmeasured: [
    'Voluntary human observations',
    'Actual screen reader speech',
    'Physical OS forced colors',
    'Opposite native panel side if not actually observed',
    'Physical OS magnification and a physically dragged 320px native side panel; the access group separately measures a 320px emulated panel and a 200% test user stylesheet.',
    'Full SS8-02/03 shopping transfer if not reported in other exact-build suites',
  ],
  rows,
};
const save = () => writeFile(join(out, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
const state = async (s) => (await view(s.panel)).v;
const goal = 'Find my username settings',
  sel = 'a[href="/settings-lab/account"]';
async function shot(s, r, key, withPanel = true) {
  const p = r.width + '-' + r.group + '-' + key;
  await s.page.screenshot({ path: join(out, p + '-page.png') });
  r.screens.push(p + '-page.png');
  if (withPanel && !(await panelClosed(s))) {
    await s.panel.screenshot({ path: join(out, p + '-panel.png') });
    r.screens.push(p + '-panel.png');
    if (
      [
        'verified-cue',
        'offscreen',
        'revealed',
        'inner-reveal',
        'reopened',
        'pinned-warning',
        'warning-details',
        'edge-warning-details',
        'native-warning-tucked',
        'warning-reopened',
      ].includes(key) &&
      process.platform === 'win32'
    ) {
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve('tests/support/capture-design-pair.ps1'),
          '-PageImage',
          join(out, p + '-page.png'),
          '-PanelImage',
          join(out, p + '-panel.png'),
          '-Destination',
          join(out, p + '-pair.png'),
          '-PanelSide',
          r.panelLayout?.side ?? 'right',
        ],
        { windowsHide: true, timeout: 12000 },
      );
      r.screens.push(p + '-pair.png');
    }
  }
}
async function cmd(s, g) {
  await s.panel.focus('#chat-composer');
  await s.panel.keyboard.type(g);
  await s.panel.keyboard.press('Enter');
}
async function check(s, r, tag, f) {
  const start = new Date().toISOString();
  try {
    const facts = await f();
    r.checks.push({ tag, status: 'pass', start, facts });
  } catch (e) {
    const debug = {};
    try {
      debug.route = new URL(s.page.url()).pathname;
      debug.panelClosed = await panelClosed(s);
      if (!debug.panelClosed) {
        const t = (await state(s)).task;
        debug.task = t ? { state: t.state, steps: t.steps, status: t.adaptive?.status } : null;
        debug.visibleButtons = await s.panel.$$eval('button', (xs) =>
          xs
            .filter((x) => x.checkVisibility())
            .map((x) => x.getAttribute('aria-label') || x.innerText)
            .slice(-16),
        );
      }
      const dock = await overlay(s, 'dock');
      debug.dock = dock?.buttons.filter((x) => x.visible).map((x) => x.name) ?? [];
    } catch {
      /* Preserve the original failing observation if a target closed. */
    }
    r.checks.push({ tag, status: 'fail', start, error: String(e.message).slice(0, 320), debug });
    await shot(s, r, 'failed-' + tag.replace(/\W+/g, '-')).catch(() => {});
  }
  await save();
}
async function practice(s) {
  await s.page.evaluate(() => {
    const m = document.querySelector('main'),
      a = m.querySelector('a[href="/settings-lab/account"]');
    const explanation = document.createElement('span');
    explanation.id = 'dg-site-context';
    explanation.hidden = true;
    explanation.textContent = 'Practice page account link.';
    m.append(explanation);
    a.setAttribute('aria-describedby', explanation.id);
    m.style.padding = '115px 16px 0';
    m.style.minHeight = '150vh';
    const neighbor = document.createElement('a');
    neighbor.href = '/settings-lab/username';
    neighbor.innerText = 'Account settings help';
    a.insertAdjacentElement('afterend', neighbor);
  });
  // Fixture layout is installed after the native panel opens. Let the
  // previously inspected document's normal invalidation settle before typing
  // the first task, rather than racing our synthetic page mutation.
  await until(async()=>{
    const a=await state(s);await delay(220);const b=await state(s);
    return a.origin===new URL(s.page.url()).origin&&b.origin===a.origin&&a.epoch===b.epoch &&
      a.snapshot?.context.documentId===b.snapshot?.context.documentId;
  },'current fixture context stable before goal');
  await cmd(s, goal);
  const preview = await until(async () => {
    const t = (await state(s)).task;
    return t?.goal === goal && t.state === 'awaiting_confirmation' && t;
  }, 'practice task available');
  return preview;
}
async function show(s) {
  await button(s.panel, 'Show me').click();
  await until(async () => {
    const t = (await state(s)).task;
    return t?.state === 'showing_step' && t;
  }, 'visible manual step');
  return until(async () => {
    const c = await overlay(s);
    return c?.host.visible && c;
  }, 'current outline');
}
async function deliberateReveal(s, r) {
  const control = await until(async () => {
    const e =
      (await s.panel.$('[data-show-step]')) ??
      (await s.panel.$('button[aria-label^="Show step:"]')) ??
      (await s.panel.$('::-p-aria(Show step[role="button"])')) ??
      (await s.panel.$('::-p-aria(Show this target[role="button"])'));
    const t = (await state(s)).task;
    r.beforeReveal = { state: t?.state, status: t?.adaptive?.status, steps: t?.steps };
    return e && (await e.isVisible()) && e;
  }, 'native current-step reveal control');
  await control.click();
}
async function cue(s, r) {
  const initial = await practice(s);
  const c = await show(s),
    before = await currentTarget(s, sel);
  await check(s, r, 'DG01 verified target and readable hint', async () => {
    verifyCue(c, before);
    assert.equal(c.instruction, 'Open Account settings');
    assert(before.descriptionIds.includes('dg-site-context'));
    const doc = await s.tabSession.send('DOM.getDocument');
    const { nodeId } = await s.tabSession.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: sel,
    });
    const ax = await s.tabSession.send('Accessibility.getPartialAXTree', {
      nodeId,
      fetchRelatives: false,
    });
    const exposed = ax.nodes.find((n) => n.role?.value === 'link');
    r.accessibleLink = { name: exposed?.name?.value, description: exposed?.description?.value };
    assert.equal(exposed?.name?.value, before.label);
    assert(exposed.description.value.includes('Practice page account link.'));
    assert(exposed.description.value.includes(c.instruction));
    const neighbor = await currentTarget(s, 'a[href="/settings-lab/username"]');
    assert(!aligned(c.host.rect, neighbor.rect));
    assert.equal((await s.page.$$('[data-safestep-outline]')).length, 1);
    await shot(s, r, 'verified-cue');
    return {
      target: before,
      nativeAccessibilityDescription: exposed.description.value,
      neighbor: neighbor.label,
      cue: c,
    };
  });
  await check(s, r, 'DG02 scroll and reflow keep identity and focus', async () => {
    await s.panel.evaluate(() => {
      const signature = () =>
        [...document.querySelectorAll('[aria-live],[role=status],[role=alert]')]
          .filter((e) => e.checkVisibility())
          .map((e) => e.textContent)
          .join('|');
      let previous = signature();
      window.dgLiveChanges = 0;
      window.dgMonitor = new MutationObserver(() => {
        const next = signature();
        if (previous !== next) {
          window.dgLiveChanges++;
          previous = next;
        }
      });
      window.dgMonitor.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    });
    await s.page.focus(sel);
    await s.page.evaluate(() => window.scrollBy(0, 52));
    await s.page.$eval('header', (e) => {
      e.style.paddingBottom = '36px';
    });
    const t = await currentTarget(s, sel);
    const moved = await until(async () => {
      const ring = await overlay(s);
      return aligned(ring?.host.rect, t.rect) && ring?.marker?.visible && ring;
    }, 'painted bounds after reflow');
    verifyCue(moved, t);
    assert(t.focus);
    // Chrome can anchor a person's scroll position when the preceding header
    // grows. Verify SafeStep leaves the settled scroll alone rather than
    // imposing a particular native anchoring policy on the page.
    assert(t.scrollY > 0);
    await delay(175);
    assert.equal(await s.page.evaluate(() => scrollY), t.scrollY);
    assert.notEqual(Math.round(moved.host.rect.y), Math.round(c.host.rect.y));
    const now = (await state(s)).task;
    assert.equal(now.id, initial.id);
    assert.equal(now.steps, 0);
    const textChanges = await s.panel.evaluate(() => {
      window.dgMonitor.disconnect();
      return window.dgLiveChanges;
    });
    assert.equal(textChanges, 0, 'movement changed announceable text');
    await shot(s, r, 'scroll-reflow');
    return {
      before: before.rect,
      after: t,
      cue: moved,
      steps: now.steps,
      observedPanelLiveTextChanges: textChanges,
    };
  });
  await check(s, r, 'DG03 offscreen suppression and deliberate reveal', async () => {
    await s.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const stop = await s.page.evaluate(() => scrollY);
    assert(stop > 0);
    const hidden = await until(async () => {
      const o = await overlay(s);
      return !o?.marker?.visible && { retainedOutline: !!o };
    }, 'offscreen hint suppressed');
    await delay(220);
    assert.equal(await s.page.evaluate(() => scrollY), stop);
    assert.equal((await state(s)).task.steps, 0);
    await shot(s, r, 'offscreen');
    const count = () =>
      s.page.evaluate(
        () => JSON.parse(sessionStorage.getItem('counts') || '{}')['Account settings'] ?? 0,
      );
    const clicks = await count(),
      focused = await s.page.$eval(sel, (e) => document.activeElement === e);
    await deliberateReveal(s, r);
    const t = await until(async () => {
      const x = await currentTarget(s, sel);
      return x.hit && x;
    }, 'explicit reveal returns target');
    const arrow = await until(async () => {
      const x = await overlay(s);
      return x?.marker?.visible && aligned(x.host.rect, t.rect) && x;
    }, 'exterior marker and ring settled after user reveal');
    verifyCue(arrow, t);
    assert(t.rect.y >= 5 && arrow.host.rect.y >= 2);
    assert.equal(t.focus, focused);
    assert.equal(await count(), clicks);
    assert.equal((await state(s)).task.steps, 0);
    await shot(s, r, 'revealed');
    return {
      offscreenScroll: stop,
      hidden,
      after: t,
      marker: arrow.marker.rect,
      ring: arrow.host.rect,
      clicksBefore: clicks,
      clicksAfter: await count(),
      focusUnchanged: true,
    };
  });
  await check(s, r, 'DG04 advance only after verified real user click', async () => {
    const prior = (await state(s)).task;
    assert.equal(prior.steps, 0);
    await s.page.click(sel);
    const next = await until(async () => {
      const t = (await state(s)).task;
      return t?.id === prior.id && t.steps === 1 && t.state === 'showing_step' && t;
    }, 'verified step two');
    const t = await currentTarget(s, 'a[href="/settings-lab/username"]'),
      c = await overlay(s);
    assert.equal(t.route, '/settings-lab/account');
    verifyCue(c, t);
    await shot(s, r, 'next-cue');
    return { route: t.route, steps: next.steps, cue: c.instruction };
  });
}
async function clip(s, r) {
  await check(s, r, 'DG02 DG03 clipped scroll ancestor and deliberate inner reveal', async () => {
    await s.page.evaluate(() => {
      const a = document.querySelector('a[href="/settings-lab/account"]'),
        shell = document.createElement('div');
      shell.id = 'dg-scroller';
      Object.assign(shell.style, {
        height: '120px',
        overflowY: 'auto',
        position: 'relative',
        width: '78%',
        border: '1px solid black',
      });
      a.before(shell);
      const head = document.createElement('p'),
        tail = document.createElement('p');
      head.style.height = '26px';
      tail.style.height = '360px';
      head.textContent = 'Browse';
      tail.textContent = 'More practice reading';
      shell.append(head, a, tail);
    });
    await practice(s);
    await show(s);
    const before = await currentTarget(s, sel);
    assert(before.hit);
    const outer = await s.page.evaluate(() => scrollY);
    await s.page.$eval('#dg-scroller', (e) => (e.scrollTop = 145));
    const clippedTop = await s.page.$eval('#dg-scroller', (e) => e.scrollTop);
    await until(
      async () => !(await overlay(s))?.marker?.visible,
      'clipped target arrow suppressed',
    );
    assert.equal(await s.page.$eval('#dg-scroller', (e) => e.scrollTop), clippedTop);
    assert.equal(await s.page.evaluate(() => scrollY), outer);
    await shot(s, r, 'clipped');
    await deliberateReveal(s, r);
    await until(async () => (await currentTarget(s, sel)).hit, 'inner scroll restored target');
    const after = await s.page.$eval('#dg-scroller', (e) => e.scrollTop);
    assert(after < clippedTop);
    assert.equal((await state(s)).task.steps, 0);
    const t = await currentTarget(s, sel),
      ring = await until(async () => {
        const x = await overlay(s);
        return x?.marker?.visible && aligned(x.host.rect, t.rect) && x;
      }, 'inner ring and marker settled');
    const viewport = await s.page.$eval('#dg-scroller', (e) => {
      const r = e.getBoundingClientRect();
      return { top: r.top + e.clientTop, bottom: r.top + e.clientTop + e.clientHeight };
    });
    verifyCue(ring, t);
    assert(t.rect.y >= viewport.top + 5 && t.rect.y + t.rect.h <= viewport.bottom - 5);
    assert.equal(await s.page.evaluate(() => scrollY), outer);
    assert.equal(t.focus, before.focus);
    await shot(s, r, 'inner-reveal');
    return {
      outer,
      clippedScroll: clippedTop,
      afterExplicitReveal: after,
      target: t,
      container: viewport,
      marker: ring.marker.rect,
      ring: ring.host.rect,
    };
  });
}
async function replacement(s, r) {
  await practice(s);
  await show(s);
  await check(s, r, 'DG03 DG10 occluded original cannot show misleading hint', async () => {
    await s.page.$eval(sel, (e) => {
      const b = e.getBoundingClientRect();
      const blocker = document.createElement('div');
      blocker.id = 'dg-cover';
      blocker.textContent = 'Fixture overlay';
      Object.assign(blocker.style, {
        position: 'fixed',
        left: b.left - 5 + 'px',
        top: b.top - 5 + 'px',
        width: b.width + 10 + 'px',
        height: b.height + 10 + 'px',
        background: 'white',
        zIndex: '2147483646',
      });
      document.documentElement.append(blocker);
    });
    await until(async () => {
      const o = await overlay(s);
      return !o?.marker?.visible;
    }, 'covered cue suppressed');
    assert(!(await currentTarget(s, sel)).hit);
    assert.equal((await state(s)).task.steps, 0);
    await shot(s, r, 'occluded');
  });
  await check(s, r, 'DG04 DG10 same-label replacement never inherits a selected ref', async () => {
    await s.page.evaluate(() => {
      document.getElementById('dg-cover')?.remove();
      const prior = document.querySelector('a[href="/settings-lab/account"]');
      const other = prior.cloneNode(true);
      other.href = '/settings-lab/username';
      other.id = 'dg-replacement';
      prior.replaceWith(other);
    });
    const a = await until(async () => {
      const o = await overlay(s),
        t = (await state(s)).task;
      return (
        (!o?.marker?.visible || t?.state === 'paused') && {
          state: t.state,
          steps: t.steps,
          cue: o?.instruction ?? null,
        }
      );
    }, 'old hint retired');
    await delay(180);
    assert.equal(new URL(s.page.url()).pathname, '/settings-lab');
    assert.equal(a.steps, 0);
    await shot(s, r, 'replacement');
    return a;
  });
}
async function edges(s, r) {
  await check(
    s,
    r,
    'DG02 DG03 exterior edge, occupied-side and outline-only fallback',
    async () => {
      await practice(s);
      await s.page.$eval(sel, (e) => {
        Object.assign(e.style, { position: 'fixed', right: '8px', top: '42%', margin: 0 });
      });
      await show(s);
      const edge = await until(async () => {
        const c = await overlay(s);
        return c?.marker?.visible && c.placement === 'left' && c;
      }, 'right edge uses exterior left arrow');
      verifyCue(edge, await currentTarget(s, sel));
      await shot(s, r, 'edge-left');
      await s.page.$eval(sel, (e) => {
        const b = e.getBoundingClientRect();
        const guard = document.createElement('div');
        guard.id = 'dg-marker-guard';
        guard.setAttribute('data-security', '');
        Object.assign(guard.style, {
          position: 'fixed',
          top: b.top - 2 + 'px',
          right: innerWidth - b.left + 2 + 'px',
          width: '60px',
          height: b.height + 4 + 'px',
          background: '#c0d3cf',
          zIndex: '3',
        });
        document.documentElement.append(guard);
      });
      const vertical = await until(async () => {
        const c = await overlay(s);
        return c?.marker?.visible && ['above', 'below'].includes(c.placement) && c;
      }, 'occupied side uses free vertical arrow');
      verifyCue(vertical, await currentTarget(s, sel));
      await shot(s, r, 'edge-vertical');
      await s.page.$eval(sel, (e) => {
        const b = e.getBoundingClientRect();
        for (const y of [b.top - 58, b.bottom + 2]) {
          const guard = document.createElement('div');
          guard.setAttribute('data-security', '');
          Object.assign(guard.style, {
            position: 'fixed',
            left: b.left + 'px',
            top: y + 'px',
            width: b.width + 'px',
            height: '56px',
            background: '#c0d3cf',
            zIndex: '3',
          });
          document.documentElement.append(guard);
        }
      });
      const fallback = await until(async () => {
        const c = await overlay(s);
        return c?.host.visible && c.placement === 'panel' && !c.marker?.visible && c;
      }, 'all occupied sides leave only verified ring');
      const t = await currentTarget(s, sel);
      assert(t.hit && aligned(fallback.host.rect, t.rect));
      assert.equal((await state(s)).task.steps, 0);
      await shot(s, r, 'edge-outline-only');
      return {
        edge: edge.placement,
        vertical: vertical.placement,
        fallback: fallback.placement,
        controlReachable: t.hit,
        cueTextCount: t.extensionDescriptions.length,
      };
    },
  );
}
async function tuck(s, r) {
  const initial = await practice(s);
  await show(s);
  await check(s, r, 'DG06 same guide and controls survive keyboard tuck', async () => {
    const control = await s.panel.waitForSelector('::-p-aria(Tuck panel[role="button"])');
    await control.focus();
    await s.panel.keyboard.press('Enter');
    await until(() => panelClosed(s), 'tucked native panel closed');
    const dock = await until(async () => {
      const d = await overlay(s, 'dock');
      return d?.host.visible && d;
    }, 'edge dock shown');
    const open = await dockControl(s, 'Open SafeStep');
    assert.equal(open.name, 'Open SafeStep: My username settings');
    assert.equal(open.text.match(/My username settings/g)?.length, 1);
    assert(
      parseFloat(open.afterMarker.width) > 0 &&
        parseFloat(open.afterMarker.height) > 0 &&
        !['none', 'normal'].includes(open.afterMarker.content),
      'reopen affordance rendered',
    );
    const pause = dock.buttons.find((x) => x.visible && x.name === 'Pause'),
      stop = dock.buttons.find((x) => x.visible && x.name === 'Stop');
    assert(pause && stop, 'direct manual controls');
    assert(
      Math.abs(open.rect.y + open.rect.h / 2 - (pause.rect.y + pause.rect.h / 2)) < 9 &&
        Math.abs(pause.rect.y - stop.rect.y) < 4,
      'short goal and manual controls share one desktop strip',
    );
    assert(
      !dock.buttons.some((b) => b.visible && /restore|show step/i.test(b.name)),
      'only actual interference or changes add other buttons',
    );
    const cue = await overlay(s);
    verifyCue(cue, await currentTarget(s, sel));
    assert(!dock.hint?.visible, 'the visible site label must not be repeated by the dock');
    assert(!overlaps(cue.marker.rect, dock.host.rect));
    await shot(s, r, 'tucked', false);
    await s.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const offset = await s.page.evaluate(() => scrollY);
    const edge = await until(async () => {
      const d = await overlay(s, 'dock');
      return d?.hint?.visible && /Account settings/i.test(d.text) && d;
    }, 'compact dock names the offscreen target');
    assert(!(await overlay(s))?.marker?.visible);
    assert.equal(await s.page.evaluate(() => scrollY), offset);
    await shot(s, r, 'offscreen-dock', false);
    await dockControl(s, 'Show step', true);
    await until(async () => (await currentTarget(s, sel)).hit, 'deliberate compact reveal');
    await shot(s, r, 'compact-reveal', false);
    let openByKeys = false;
    await s.page.bringToFront();
    for (let n = 0; n < 22; n++) {
      const d = await overlay(s, 'dock');
      if (d?.buttons.some((b) => b.name.startsWith('Open SafeStep') && b.focused)) {
        await s.page.keyboard.press('Enter');
        openByKeys = true;
        break;
      }
      await s.page.keyboard.press('Tab');
    }
    assert(openByKeys, 'Open SafeStep must be reachable by actual Tab navigation');
    s.panel = await (
      await s.browser.waitForTarget(
        (t) => t.url() === 'chrome-extension://' + s.id + '/sidepanel.html',
      )
    ).asPage();
    await s.panel.waitForSelector('#chat-composer');
    const t = (await state(s)).task;
    assert.equal(t.id, initial.id);
    assert.equal(t.goal, initial.goal);
    assert.equal(t.steps, 0);
    r.reopened = { state: t.state, status: t.adaptive?.status, steps: t.steps };
    assert.equal(t.state, 'showing_step', 'Reopened guide: ' + t.adaptive?.status);
    await shot(s, r, 'reopened');
    await button(s.panel, 'Pause').click();
    await until(async () => (await state(s)).task?.state === 'paused', 'local pause');
    await button(s.panel, 'Stop').click();
    await until(async () => {
      const t = (await state(s)).task;
      return !t || t.state === 'cancelled';
    }, 'local stop');
    await shot(s, r, 'reopened-stopped');
    return {
      controlNames: dock.buttons.map((b) => b.name),
      shortDesktopStrip: { opener: open.rect, pause: pause.rect, stop: stop.rect },
      cueBesideDock: cue.marker.rect,
      offscreenInstruction: edge.text,
      explicitRevealFromScroll: offset,
      openRect: open.rect,
      goalId: t.id,
      steps: t.steps,
    };
  });
}
async function automaticInterruption(s, r) {
  const action = {
    autoPause: 'Pause',
    autoTakeover: 'Take over',
    autoStop: 'Stop',
    rapidStop: 'Stop',
  }[r.group];
  const rapid = r.group === 'rapidStop';
  await check(s, r, 'DG04 DG06 direct automatic ' + action, async () => {
    const initial = await practice(s);
    const worker = await (
      await s.browser.waitForTarget(
        (t) =>
          t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + s.id + '/'),
      )
    ).worker();
    // Explicit fixture delay, confined to this disposable extension worker.
    const foreground = () =>
      worker.evaluate(async (id) => {
        const tab = await chrome.tabs.get(id),
          win = await chrome.windows.get(tab.windowId);
        const key = 'task:' + id,
          t = (await chrome.storage.session.get(key))[key]?.task;
        let frame = null,
          error = null;
        try {
          const rows = await chrome.scripting.executeScript({
            target: { tabId: id, frameIds: [0] },
            func: () => ({
              path: location.pathname,
              visibility: document.visibilityState,
              pageFocus: document.hasFocus(),
            }),
          });
          const top = rows.find((f) => f.frameId === 0);
          frame = { documentId: top?.documentId, ...top?.result };
        } catch (e) {
          error = String(e.message).slice(0, 160);
        }
        return {
          at: new Date().toISOString(),
          tab: id,
          currentWindow: tab.windowId,
          windowFocused: win.focused,
          tabActive: tab.active,
          loading: tab.status,
          frame,
          error,
          events: globalThis.dgEvents?.slice(-18),
          task: t
            ? {
                id: t.id,
                mode: t.mode,
                state: t.state,
                status: t.adaptive?.status,
                authorized: t.adaptive?.authorized,
                documentId: t.documentId,
              }
            : null,
        };
      }, initial.tabId);
    // The product still owns approval, action, interruption and late-reply
    // policy. Pausing transport keeps the control interval reproducible.
    await worker.evaluate(() => {
      globalThis.dgEvents = [];
      const add = (entry) => {
        globalThis.dgEvents.push({ ...entry, at: Date.now() });
        if (globalThis.dgEvents.length > 18) globalThis.dgEvents.shift();
      };
      chrome.windows.onFocusChanged.addListener((id) => add({ kind: 'window-focus', id }));
      chrome.runtime.onMessage.addListener((msg, sender) => {
        if (msg?.channel === 'dock-control')
          add({
            kind: 'dock-control',
            action: msg.action,
            document: sender.documentId,
            tab: sender.tab?.id,
          });
      });
      const send = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (...args) => {
        const m = args[1];
        if (m?.channel === 'assist-page' && m.cmd.op === 'act' && !globalThis.dgHeld) {
          globalThis.dgHeld = true;
          await new Promise((resolve) => {
            globalThis.dgRelease = resolve;
          });
          const result = await send(...args);
          globalThis.dgStaleAccepted = result?.ok;
          return result;
        }
        return send(...args);
      };
    });
    await s.page.$eval(sel, (e) => e.addEventListener('click', (event) => event.preventDefault()));
    await button(s.panel, 'Take me there').click();
    assert(!(await state(s)).task.adaptive.authorized);
    await button(s.panel, 'Start automatic').click();
    await until(
      () => worker.evaluate(() => typeof globalThis.dgRelease === 'function'),
      'approved fixture act held at the extension transport',
    );
    await button(s.panel, 'Tuck panel').click();
    const transition = await until(async () => {
      if (await panelClosed(s)) return 'tucked';
      return (await state(s)).task?.state === 'paused' && 'safe pause before tucking';
    }, 'tuck transition');
    if (transition === 'safe pause before tucking') {
      const paused = (await state(s)).task;
      assert.equal(paused.steps, 0);
      return {
        transition,
        taskId: initial.id,
        status: paused.adaptive?.status,
        limitation: 'Compact activation could not be exercised because the product paused safely.',
      };
    }
    const dock = await until(async () => {
      const d = await overlay(s, 'dock');
      return d?.host.visible && d;
    }, 'tucked automation controls');
    const directNames = dock.buttons.filter((b) => b.visible).map((b) => b.name);
    for (const expected of ['Open SafeStep', 'Pause', 'Stop', 'Take over'])
      assert(
        directNames.some((n) => n === expected || n.startsWith(expected + ':')),
        directNames.join(', '),
      );
    if (r.group === 'autoPause') await shot(s, r, 'auto-controls', false);
    r.beforeIntervention = await foreground();
    if (rapid)
      await worker.evaluate((id) => {
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.scripting.executeScript = async (options) => {
          if (
            !globalThis.dgSpotBlocked &&
            options.target.tabId === id &&
            options.target.frameIds?.includes(0) &&
            options.func
          ) {
            globalThis.dgSpotBlocked = true;
            await new Promise((ok) => {
              globalThis.dgReleaseSpot = ok;
            });
          }
          return execute(options);
        };
      }, initial.tabId);
    const clickAt = Date.now();
    await dockControl(s, action, true);
    if (rapid) {
      await until(
        () => worker.evaluate(() => typeof globalThis.dgReleaseSpot === 'function'),
        'prior Stop is validating the real subject',
      );
      await reopen(s);
      await worker.evaluate(() => globalThis.dgReleaseSpot());
    }
    const expectedStatus = {
      Stop: 'Stopped by you.',
      Pause: 'Paused by you.',
      'Take over': 'You have control. Continue in guide mode.',
    };
    const confirmed = await until(async () => {
      const result = await worker.evaluate(async (id) => {
        const key = 'task:' + id;
        const task = (await chrome.storage.session.get(key))[key]?.task;
        return task
          ? {
              id: task.id,
              mode: task.mode,
              authorized: task.adaptive?.authorized,
              state: task.state,
              status: task.adaptive?.status,
              steps: task.steps,
            }
          : null;
      }, initial.tabId);
      r.interventionCheckpoint = result;
      return result?.id === initial.id && result.status === expectedStatus[action] && result;
    }, 'bound direct intervention acknowledged before any other gesture').finally(async () => {
      r.afterIntervention = await foreground();
    });
    r.interventionMs = Date.now() - clickAt;
    await worker.evaluate(() => globalThis.dgRelease());
    await until(
      () => worker.evaluate(() => globalThis.dgStaleAccepted === false),
      'old delayed action rejected',
    );
    if (!rapid) {
      await until(
        async () =>
          !(await overlay(s, 'dock'))?.buttons.some((b) => b.visible && b.name === 'Take over'),
        'updated dock action set',
      );
      await reopen(s);
    }
    const t = await until(async () => {
      const t = (await state(s)).task;
      return t?.id === initial.id && t.state === (action === 'Stop' ? 'cancelled' : 'paused') && t;
    }, 'immediate local intervention');
    assert.equal(t.steps, 0);
    assert.equal(t.adaptive.authorized, false);
    assert.equal(t.adaptive.status, expectedStatus[action]);
    if (action === 'Take over')
      assert.equal(t.mode, 'guide', 'takeover must actually return ownership to the user');
    assert.equal(new URL(s.page.url()).pathname, '/settings-lab');
    await shot(s, r, 'interrupted');
    return {
      action,
      directNames,
      final: t.state,
      steps: t.steps,
      taskId: t.id,
      confirmedTask: confirmed,
      openedDuringPendingStop: rapid,
      status: t.adaptive.status,
      transport: 'controlled delay of a real authorized fixture message; stale response refused',
    };
  });
}
async function restart(s, r) {
  await check(
    s,
    r,
    'DG06 tucked worker recovery fences old Stop and preserves the guide',
    async () => {
      const task = await practice(s);
      await show(s);
      const count = () =>
        s.page.evaluate(
          () => JSON.parse(sessionStorage.getItem('counts') || '{}')['Account settings'] ?? 0,
        );
      const before = await count();
      await button(s.panel, 'Tuck panel').click();
      await until(() => panelClosed(s), 'tucked before restarting worker');
      await dockControl(s, 'Stop');
      const target = await s.browser.waitForTarget(
        (t) =>
          t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + s.id + '/'),
      );
      const worker = await target.worker();
      await worker.close();
      // This is the real, stale page button. It can wake the worker, but its
      // retired capability cannot cancel or run the recovered task.
      await dockControl(s, 'Stop', true);
      await until(async () => {
        const d = await overlay(s, 'dock');
        return !d || d.buttons.every((b) => !b.visible || b.name === 'Open SafeStep');
      }, 'stale action retired on the actual page');
      const usable = (await overlay(s, 'dock'))?.buttons.some(
        (b) => b.visible && b.name === 'Open SafeStep',
      );
      await reopen(s, !!usable);
      const recovered = await until(async () => {
        const t = (await state(s)).task;
        return t?.id === task.id && t.state === 'paused' && t;
      }, 'own prior task recovered paused');
      assert.equal(recovered.steps, 0);
      assert.equal(await count(), before);
      assert.equal(new URL(s.page.url()).pathname, '/settings-lab');
      await shot(s, r, 'recovered');
      return {
        id: task.id,
        status: recovered.state,
        siteCountBefore: before,
        siteCountAfter: await count(),
        openedUsing: usable ? 'remaining opener' : 'native toolbar',
      };
    },
  );
}
async function privacy(s, r) {
  await check(s, r, 'DG04 no-op and restricted tab cannot complete or replay', async () => {
    const task = await practice(s);
    await show(s);
    const selected = (await state(s)).task;
    await s.page.evaluate(() => {
      const ring = document.querySelector('[data-safestep-outline]');
      for (let n = 0; n < 12; n++) ring.setAttribute('data-dg-fixture-pass', String(n));
    });
    await delay(250);
    const unchanged = (await state(s)).task;
    assert.equal(unchanged.revision, selected.revision);
    assert.equal(unchanged.steps, 0);
    assert.equal(unchanged.state, 'showing_step');
    await s.page.$eval(sel, (e) => e.addEventListener('click', (ev) => ev.preventDefault()));
    await s.page.click(sel);
    await delay(250);
    const held = (await state(s)).task;
    assert.equal(held.id, task.id);
    assert.equal(held.steps, 0);
    assert.notEqual(held.state, 'completed');
    const newer = await s.browser.newPage();
    try {
      await newer.goto('chrome://version/');
      await newer.bringToFront();
      assert.equal(
        await newer.$$eval(
          '[data-safestep-outline],[data-safestep-dock],[data-safestep-protection]',
          (xs) => xs.length,
        ),
        0,
      );
      await newer.close();
      await s.page.bringToFront();
      const final = (await state(s)).task;
      assert(!final || (final.steps === 0 && final.state !== 'completed'));
      assert.equal(new URL(s.page.url()).pathname, '/settings-lab');
      return {
        unchangedAfterOwnedOverlayMutations: true,
        noOp: { steps: held.steps, state: held.state },
        restrictedOverlayCount: 0,
        returnState: final?.state ?? null,
      };
    } finally {
      if (!newer.isClosed()) await newer.close();
    }
  });
}
async function clearChat(s) {
  await button(s.panel, 'Settings').click();
  const disclosure = await s.panel.$('summary::-p-text(Reading and conversation)');
  if (disclosure && !(await disclosure.evaluate((e) => e.parentElement.open)))
    await disclosure.click();
  await button(s.panel, 'New chat').click();
  const close = await s.panel.$('::-p-aria(Close Settings[role="button"])');
  if (close && (await close.isVisible())) await close.click();
}
async function cleanup(s, r) {
  await check(
    s,
    r,
    'DG07 cleanup preview apply tuck and restore protect site-owned state',
    async () => {
      await s.page.evaluate(() =>
        document
          .querySelector('main')
          .insertAdjacentHTML(
            'beforeend',
            '<details id="dg-manual"><summary>Public notices</summary>Still open</details>',
          ),
      );
      await s.page.click('#dg-manual summary');
      const initial = await s.page.$eval('#private', (e) => e.value);
      await button(s.panel, 'Help').click();
      await s.panel.locator('button[data-feature="page_cleanup"]').click();
      await until(async () => {
        const c = (await state(s)).cleanup;
        return c?.items.length && c.hidden === 0;
      }, 'preview has no hidden regions');
      await button(s.panel, 'Apply cleanup').click();
      const hidden = await until(async () => {
        const c = (await state(s)).cleanup;
        return c?.hidden > 0 && c.hidden;
      }, 'owned cleanup applied');
      await clearChat(s);
      assert.equal((await state(s)).cleanup.hidden, hidden);
      await button(s.panel, 'Tuck panel').click();
      await until(() => panelClosed(s), 'tucked with cleanup');
      await dockControl(s, 'Restore page', true);
      await until(
        () => s.page.$eval('#ad', (e) => e.checkVisibility()),
        'owned advertisement restored',
      );
      await reopen(s);
      assert.equal(await s.page.$eval('#private', (e) => e.value), initial);
      assert(await s.page.$eval('#dg-manual', (e) => e.open));
      const protectedVisible = await s.page.$$eval(
        '[data-security],[data-consent],[data-shopping-evidence]',
        (els) => els.every((e) => e.checkVisibility()),
      );
      assert(protectedVisible);
      await shot(s, r, 'restored');
      return {
        hiddenBeforeRestore: hidden,
        hiddenAfter: (await state(s)).cleanup?.hidden ?? 0,
        protectedVisible,
        nativeDisclosureOpen: true,
        formUnchanged: true,
      };
    },
  );
}
async function access(s, r) {
  await check(
    s,
    r,
    'DG08 DG12 panel landmarks, nine Help features and keyboard focus',
    async () => {
      await button(s.panel, 'Help').click();
      const ids = await s.panel.$$eval('[data-feature]', (es) =>
        es.filter((e) => e.checkVisibility()).map((e) => e.dataset.feature),
      );
      assert.equal(new Set(ids).size, 9);
      await s.panel.keyboard.press('Escape');
      await until(
        () =>
          s.panel.evaluate(
            () =>
              document.activeElement?.textContent.trim() === 'Help' ||
              document.activeElement?.getAttribute('aria-label') === 'Help',
          ),
        'focus restored to Help',
      );
      await button(s.panel, 'Settings').click();
      await s.panel.locator('summary::-p-text(Reading and conversation)').click();
      await s.panel.locator('::-p-aria(Larger text[role="checkbox"])').click();
      await until(async () => (await state(s)).prefs.largeText, 'larger text');
      await s.panel.keyboard.press('Escape');
      const landmarks = await s.panel.evaluate(() => {
        const rect = (e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const log = document.querySelector('[role=log]'),
          box = document.querySelector('#chat-composer'),
          d = document.querySelector('.action-dock');
        return {
          viewport: [innerWidth, innerHeight],
          scrollWidth: document.documentElement.scrollWidth,
          log: rect(log),
          request: rect(box),
          dock: d ? rect(d) : null,
          composerCount: document.querySelectorAll('#chat-composer').length,
          warningOutsideLog: !log.querySelector('.site-warning'),
          bodyColor: getComputedStyle(document.body).color,
        };
      });
      assert.equal(landmarks.composerCount, 1);
      assert(landmarks.scrollWidth <= landmarks.viewport[0] + 1);
      assert(landmarks.request.y + landmarks.request.h <= landmarks.viewport[1] + 2);
      const contrast = await panelContrast(s.panel);
      assert(contrast.length > 0);
      await shot(s, r, 'larger-text');
      return { ids, landmarks, computedContrastSamples: contrast };
    },
  );
  await check(
    s,
    r,
    'DG08 DG11 reduced motion and forced colors keep a text equivalent',
    async () => {
      await media(s, true, true);
      await practice(s);
      const c = await show(s);
      const t = await currentTarget(s, sel);
      verifyCue(c, t);
      const preference = await s.page.evaluate(() => ({
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        forced: matchMedia('(forced-colors: active)').matches,
      }));
      assert(preference.reduce && preference.forced);
      assert.equal(c.marker.animations, 0);
      await shot(s, r, 'forced-reduced');
      return {
        chromeEmulation: preference,
        accessibleInstruction: c.instruction,
        markerColor: c.marker.color,
        outline: c.host.border,
      };
    },
  );
  await check(s, r, 'DG08 measured 320px panel and doubled reading text', async () => {
    const session = await s.panel.createCDPSession();
    const size = () =>
      s.panel.evaluate(() => ({
        width: innerWidth,
        viewportHeight: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        composerSize: parseFloat(
          getComputedStyle(document.querySelector('#chat-composer')).fontSize,
        ),
        composerVisible: document.querySelector('#chat-composer').checkVisibility(),
        composerBottom: document.querySelector('#chat-composer').getBoundingClientRect().bottom,
      }));
    const initial = await size();
    let sheet;
    try {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: initial.viewportHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });
      // Isolate the CSS reflow check from physical Windows display settings.
      // The stylesheet doubles computed text sizes and leaves control geometry
      // to the shipped app, just as a user text-sizing stylesheet would.
      const rules = await s.panel.evaluate(() => {
        const selectors = [
          '.chat-shell',
          '.chat-bar button',
          '.chat-bar strong',
          '.chat-shell p',
          '.chat-shell label',
          '.chat-shell textarea',
          '.chat-shell button',
          '.chat-shell summary',
          '.chat-shell small',
        ];
        return selectors
          .map((selector) => {
            const first = document.querySelector(selector);
            if (!first) return '';
            const px = parseFloat(getComputedStyle(first).fontSize);
            return selector + '{font-size:' + px * 2 + 'px!important}';
          })
          .join('\n');
      });
      sheet = await s.panel.addStyleTag({ content: rules });
      const doubled = await size();
      assert.equal(doubled.width, 320);
      assert(doubled.composerSize >= initial.composerSize * 1.95);
      assert(doubled.composerVisible);
      assert(doubled.scrollWidth <= 321, 'panel acquires viewport-wide horizontal scrolling');
      assert(doubled.composerBottom <= doubled.viewportHeight + 1, 'composer below the viewport');
      await shot(s, r, '320px-double-text');
      return {
        method:
          'Native panel target, CDP viewport override and temporary doubled text-size stylesheet',
        initial,
        doubled,
      };
    } finally {
      if (sheet) await sheet.evaluate((e) => e.remove());
      await session.send('Emulation.clearDeviceMetricsOverride');
      await session.detach();
    }
  });
  await check(s, r, 'DG08 actual Chrome site zoom at 200%', async () => {
    const tab = await s.panel.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
    );
    const set = async (value) =>
      s.panel.evaluate(
        async (id, v) => {
          await chrome.tabs.setZoom(id, v);
          return chrome.tabs.getZoom(id);
        },
        tab,
        value,
      );
    try {
      assert.equal(await set(2), 2);
      const target = await until(async () => {
        const t = await currentTarget(s, sel),
          c = await overlay(s);
        const fragments = await s.page.$eval(sel, (e) =>
          [...e.getClientRects()].map((b) => ({
            x: b.x,
            y: b.y,
            w: b.width,
            h: b.height,
            hit: e.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
          })),
        );
        r.zoomObservation = { t, placement: c?.placement, outline: c?.host.rect, fragments };
        const fragment = fragments.find((f) => f.hit && aligned(c?.host.rect, f));
        return c?.host.visible && fragment && { c, t: { ...t, hit: true, rect: fragment } };
      }, 'bound target at real 200 percent page zoom');
      if (target.c.marker?.visible) verifyCue(target.c, target.t);
      else assert.equal(target.c.placement, 'panel', 'only the verified outline fits');
      await shot(s, r, 'site-zoom-200');
      return {
        zoom: 2,
        siteViewport: target.t.viewport,
        cuePlacement: target.c.placement,
        nativePanel: await s.panel.evaluate(() => [innerWidth, innerHeight]),
        note: 'Real foreground website zoom; native panel text sizing is a separate observation.',
      };
    } finally {
      assert.equal(await set(1), 1);
    }
  });
}
async function warning(s, r) {
  await check(s, r, 'DG05 DG12 local address warning stays bound outside transcript', async () => {
    await button(s.panel, 'Settings').click();
    await s.panel.select('[aria-label="Auto protection settings"] select', 'selected');
    await button(s.panel, 'Apply protection settings').click();
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve('tests/support/permission.ps1'),
        '-BrowserProcessId',
        String(s.browser.process().pid),
        '-Choice',
        'Allow',
      ],
      { windowsHide: true, timeout: 16000 },
    ).catch(() => {});
    await until(async () => {
      const x = (await state(s)).protection;
      return x?.caution && x.host === new URL(s.page.url()).hostname;
    }, 'actual fixture-host discrepancy');
    await button(s.panel, 'Close Settings').click();
    const selector = '[aria-label="Current website warning"]';
    const panelWarning = () =>
      s.panel.$eval(selector, (e) => ({
        outside: !document.querySelector('[role=log]').contains(e),
        text: e.innerText,
        mode: e.dataset.warningMode,
        hosts: [...e.querySelectorAll('dl div')].map((row) => [
          row.querySelector('dt').innerText,
          row.querySelector('dd').innerText,
        ]),
        emphasis: e.querySelector('dd mark')?.textContent,
        details: e.querySelector('details')?.innerText,
      }));
    const protection = (await state(s)).protection;
    const pinned = await until(async () => {
      const p = await panelWarning();
      return p.mode === 'expanded' && p;
    }, 'full current warning in native panel');
    assert(pinned.outside);
    assert.deepEqual(pinned.hosts, [
      ['Expected', protection.expectedHost],
      ['Here', protection.host],
    ]);
    assert.equal(pinned.emphasis, 'safestep-fixture.org');
    const header = await s.panel.$eval('.chat-header', (e) => e.innerText);
    assert(
      !header.includes(protection.host),
      'the native header does not repeat the full hostname in its warning',
    );
    assert.equal(
      pinned.text.match(/Address only\. Outside reputation checks are off\./g)?.length,
      1,
    );
    assert.match(pinned.text, /Check before sharing information\./);
    assert(!pinned.text.includes('Advisory provided by Google'));
    const edgeMode = async (mode, present) =>
      until(
        async () => {
          const d = await overlay(s, 'protection');
          return d?.host.visible && d.mode === mode && d.panelPresent === String(present) && d;
        },
        'page warning ' + mode + ' with panel ' + present,
      );
    const edgeAction = async (name) => {
      const control = await until(
        async () =>
          (await overlay(s, 'protection'))?.buttons.find(
            (b) =>
              (b.name === name ||
                (name === 'Show warning' && b.name.startsWith('Show warning:'))) &&
              b.visible,
          ),
        'usable page warning control ' + name,
      );
      await s.page.mouse.click(
        control.rect.x + control.rect.w / 2,
        control.rect.y + control.rect.h / 2,
      );
    };
    const compactStrip = (edge) => {
      assert.equal(edge.warningStyle,'strip');
      const controls = edge.buttons.filter((b) => b.visible);
      assert.equal(controls.length, 1, 'folded local finding uses one complete strip action');
      assert.equal(controls[0].name, 'Show warning: Different website');
      assert.match(controls[0].text, /Different website/);
      assert(controls[0].rect.w >= edge.host.rect.w - 3, 'the whole folded strip is operable');
      assert(edge.host.rect.h <= 55, 'the folded local warning occupies a single short line');
      return {
        label: controls[0].name,
        text: controls[0].text,
        height: edge.host.rect.h,
        button: controls[0].rect,
      };
    };
    const compact = await edgeMode('compact', true);
    const stripWithPanel = compactStrip(compact);
    assert.equal(compact.hostRows.length, 0, 'only one visible full comparison');
    await s.page.evaluate(() => scrollBy(0, 140));
    const after = await edgeMode('compact', true);
    assert(Math.abs(compact.host.rect.y - after.host.rect.y) <= 2);
    await shot(s, r, 'pinned-warning');
    const detailButton = await s.panel.$(selector + ' summary');
    await detailButton.click();
    const detail = await s.panel.$eval(selector + ' details', (e) => ({
      open: e.open,
      source: e.innerText,
    }));
    assert(detail.open && /Local address check.*\d/.test(detail.source));
    assert.match(detail.source, /built-in Amazon US address rule/i);
    assert.match(detail.source, /Current browser address/i);
    assert(
      !detail.source.includes(protection.host),
      'details should not repeat the current address',
    );
    await shot(s, r, 'warning-details');
    await detailButton.click();
    await button(s.panel, 'Tuck warning').click();
    await until(async () => (await panelWarning()).mode === 'compact', 'tucked native finding');
    assert(!(await state(s)).protection.dismissed);
    await shot(s, r, 'native-warning-tucked');
    await edgeAction('Show warning');
    await until(
      async () => (await panelWarning()).mode === 'expanded',
      'page affordance reopens the native finding',
    );
    await until(
      () =>
        s.panel.evaluate(
          () => !!document.activeElement?.closest('[aria-label="Current website warning"]'),
        ),
      'native warning receives focus after deliberate page request',
    );
    await clearChat(s);
    assert((await state(s)).protection.caution);
    await button(s.panel, 'Tuck panel').click();
    await until(() => panelClosed(s), 'native panel tucked');
    const expanded = await edgeMode('expanded', false);
    assert.deepEqual(expanded.hostRows, pinned.hosts);
    assert.equal(expanded.emphasis, pinned.emphasis);
    const dock = await until(async () => {
      const d = await overlay(s, 'dock');
      return d?.host.visible && d;
    }, 'compact opener remains');
    assert(!overlaps(dock.host.rect, expanded.host.rect));
    const openers = [...dock.buttons, ...expanded.buttons].filter(
      (b) => b.visible && b.name.startsWith('Open SafeStep'),
    );
    assert.equal(openers.length, 1, 'one available reopen action');
    await shot(s, r, 'tucked-warning', false);
    await edgeAction('Details');
    await until(
      async () => (await overlay(s, 'protection')).host.rect.h > expanded.host.rect.h,
      'page details expanded',
    );
    await shot(s, r, 'edge-warning-details', false);
    await edgeAction('Details');
    await edgeAction('Tuck warning');
    const stripWithoutPanel = compactStrip(await edgeMode('compact', false));
    await shot(s, r, 'page-warning-tucked', false);
    await edgeAction('Show warning');
    await edgeMode('expanded', false);
    await reopen(s);
    await edgeMode('compact', true);
    await until(
      async () => (await panelWarning()).mode === 'expanded',
      'warning returns once in native panel',
    );
    const retained = (await state(s)).protection;
    assert(retained.caution && !retained.dismissed && retained.revision === protection.revision);
    await shot(s, r, 'warning-reopened');
    await button(s.panel, 'Dismiss warning').click();
    await until(
      async () => (await state(s)).protection.dismissed,
      'explicit dismissal acknowledged',
    );
    const dismissed = (await state(s)).protection;
    assert(dismissed.caution);
    return {
      host: dismissed.host,
      identity: dismissed.identity,
      pinned,
      detail,
      receipt: protection.revision,
      compactPage: after.host.rect,
      stripWithPanel,
      stripWithoutPanel,
      fullPage: expanded.host.rect,
      dock: dock.host.rect,
      reopenActions: openers.map((b) => b.name),
      dismissed: true,
      evidenceRetained: true,
    };
  });
}
async function file(s, r) {
  await check(s, r, 'DG04 verified final download control remains user-owned', async () => {
    await cmd(s, 'Help me find the right Windows x64 7-Zip download.');
    await until(
      async () => (await state(s)).task?.state === 'awaiting_confirmation',
      'local package goal',
    );
    await button(s.panel, 'Show me').click();
    const v = await until(async () => {
      const v = await state(s);
      return v.review?.selected && v.review.binding.taskId === v.task?.id && v;
    }, 'identified publisher file');
    const item = v.review.candidates.find((c) => c.ref === v.review.selected);
    assert(item);
    assert.equal(v.review.selection.profile, 'seven_zip_windows_x64_exe');
    const clicks = Number(await s.page.$eval('#count', (e) => e.textContent));
    assert.equal(clicks, 0);
    assert.equal(r.fileRequests.length, 0);
    const c = await overlay(s);
    assert(c?.host.visible);
    await shot(s, r, 'file-boundary');
    return {
      profile: v.review.selection.profile,
      selectedLabel: item.label,
      clicks,
      fileRequests: r.fileRequests.length,
      cue: c.instruction,
    };
  });
}
const runners = {
  cue,
  edges,
  restart,
  replacement,
  clip,
  tuck,
  autoPause: automaticInterruption,
  autoTakeover: automaticInterruption,
  autoStop: automaticInterruption,
  rapidStop: automaticInterruption,
  privacy,
  cleanup,
  warning,
  access,
  file,
};
try {
  for (const width of widthList)
    for (const group of groupList) {
      const r = {
        width,
        group,
        declared: designCases[group],
        status: 'fail',
        checks: [],
        screens: [],
        fileRequests: [],
        started: new Date().toISOString(),
      };
      rows.push(r);
      let s;
      try {
        const warn = group === 'warning',
          url = warn
            ? 'https://www.amazon.com.safestep-fixture.org/display'
            : lab.origin +
              (group === 'cleanup'
                ? '/cleanup-lab'
                : group === 'file'
                  ? '/download-lab?product=7zip'
                  : '/settings-lab');
        s = await nativeSession(bundle, width, width === 1440 ? 900 : 768, url, {
          attachWorker: true,
          prepare: async (p) => {
            await p.setRequestInterception(true);
            p.on('request', (req) => {
              const u = new URL(req.url());
              if (
                /\.(?:exe|msi|zip|7z|dmg|xpi|pkg)(?:$|\/)/i.test(u.pathname) ||
                u.hostname === 'generativelanguage.googleapis.com'
              ) {
                r.fileRequests.push({ host: u.host, path: u.pathname });
                void req.abort().catch(() => {});
                return;
              }
              if (warn && u.origin === 'https://www.amazon.com.safestep-fixture.org') {
                if (req.isNavigationRequest())
                  void req
                    .respond({
                      status: 200,
                      contentType: 'text/html',
                      body: '<!doctype html><title>Harmless mismatch fixture</title><main style="min-height:250vh"><h1>SafeStep local warning exercise</h1></main>',
                    })
                    .catch(() => {});
                else void req.abort().catch(() => {});
                return;
              }
              void req.continue().catch(() => {});
            });
          },
        });
        r.dimensions = s.dimensions;
        r.chrome = await s.browser.version();
        r.panelLayout = await s.panel.evaluate(async () =>
          chrome.sidePanel.getLayout ? await chrome.sidePanel.getLayout() : null,
        );
        const installed = (await s.root.send('Extensions.getExtensions')).extensions.find(
          (e) => e.id === s.id && e.enabled,
        );
        assert(installed && resolve(installed.path) === bundle);
        r.extensionId = s.id;
        await runners[group](s, r);
        assert.equal(r.fileRequests.length, 0);
        r.status = r.checks.length && r.checks.every((c) => c.status === 'pass') ? 'pass' : 'fail';
      } catch (e) {
        r.error = String(e.message).slice(0, 320);
        if (s) await shot(s, r, 'diagnostic').catch(() => {});
      } finally {
        if (s) await s.browser.close();
        r.ended = new Date().toISOString();
        await save();
        console.log(r.status, width, group);
      }
    }
} finally {
  lab.server.close();
}
console.log(out);
if (rows.some((r) => r.status !== 'pass')) process.exitCode = 1;
