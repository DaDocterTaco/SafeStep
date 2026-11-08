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
  panelClosed,
  reopen,
  media,
  panelContrast,
} from './support/design-cues.mjs';

const designCases = {
  cue: ['DG01', 'DG02', 'DG03', 'DG04', 'DG11'],
  replacement: ['DG03', 'DG04', 'DG10'],
  clip: ['DG02', 'DG03'],
  tuck: ['DG06', 'DG08', 'DG11'],
  autoPause: ['DG04', 'DG06', 'DG11'],
  autoTakeover: ['DG04', 'DG06', 'DG11'],
  autoStop: ['DG04', 'DG06', 'DG11'],
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
    'Actual 320px desktop panel and 200% user text zoom',
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
    r.checks.push({ tag, status: 'fail', start, error: String(e.message).slice(0, 320) });
    await shot(s, r, 'failed-' + tag.replace(/\W+/g, '-')).catch(() => {});
  }
  await save();
}
async function practice(s) {
  await s.page.evaluate(() => {
    const m = document.querySelector('main'),
      a = m.querySelector('a[href="/settings-lab/account"]');
    m.style.padding = '115px 16px 0';
    m.style.minHeight = '150vh';
    const neighbor = document.createElement('a');
    neighbor.href = '/settings-lab/username';
    neighbor.innerText = 'Account settings help';
    a.insertAdjacentElement('afterend', neighbor);
  });
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
async function cue(s, r) {
  const initial = await practice(s);
  const c = await show(s),
    before = await currentTarget(s, sel);
  await check(s, r, 'DG01 verified target and readable hint', async () => {
    verifyCue(c, before);
    assert(c.text.toLowerCase().includes('account'), c.text);
    const neighbor = await currentTarget(s, 'a[href="/settings-lab/username"]');
    assert(!aligned(c.host.rect, neighbor.rect));
    assert.equal((await s.page.$$('[data-safestep-outline]')).length, 1);
    await shot(s, r, 'verified-cue');
    return { target: before, neighbor: neighbor.label, cue: c };
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
      return aligned(ring?.host.rect, t.rect) && ring?.hint?.visible && ring;
    }, 'painted bounds after reflow');
    verifyCue(moved, t);
    assert(t.focus);
    assert.equal(t.scrollY, 52);
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
      return !o?.hint?.visible && { retainedOutline: !!o };
    }, 'offscreen hint suppressed');
    await delay(220);
    assert.equal(await s.page.evaluate(() => scrollY), stop);
    assert.equal((await state(s)).task.steps, 0);
    await shot(s, r, 'offscreen');
    const reveal =
      (await s.panel.$('::-p-aria(Show step[role="button"])')) ??
      (await s.panel.$('::-p-aria(Show this target[role="button"])'));
    assert(reveal && (await reveal.isVisible()), 'explicit reveal available');
    await reveal.click();
    const t = await until(async () => {
      const x = await currentTarget(s, sel);
      return x.hit && x;
    }, 'explicit reveal returns target');
    await shot(s, r, 'revealed');
    return { offscreenScroll: stop, hidden, after: t };
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
    return { route: t.route, steps: next.steps, cue: c.text };
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
    await until(async () => !(await overlay(s))?.hint?.visible, 'clipped target hint suppressed');
    assert.equal(await s.page.$eval('#dg-scroller', (e) => e.scrollTop), clippedTop);
    assert.equal(await s.page.evaluate(() => scrollY), outer);
    await shot(s, r, 'clipped');
    const reveal =
      (await s.panel.$('::-p-aria(Show step[role="button"])')) ??
      (await s.panel.$('::-p-aria(Show this target[role="button"])'));
    assert(reveal && (await reveal.isVisible()));
    await reveal.click();
    await until(async () => (await currentTarget(s, sel)).hit, 'inner scroll restored target');
    const after = await s.page.$eval('#dg-scroller', (e) => e.scrollTop);
    assert(after < clippedTop);
    assert.equal((await state(s)).task.steps, 0);
    await shot(s, r, 'inner-reveal');
    return { outer, clippedScroll: clippedTop, afterExplicitReveal: after };
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
      return !o?.hint?.visible;
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
        (!o?.hint?.visible || t?.state === 'paused') && {
          state: t.state,
          steps: t.steps,
          cue: o?.text ?? null,
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
    await shot(s, r, 'tucked', false);
    let openByKeys = false;
    await s.page.bringToFront();
    for (let n = 0; n < 22; n++) {
      const d = await overlay(s, 'dock');
      if (d?.buttons.some((b) => b.name === 'Open SafeStep' && b.focused)) {
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
      openRect: open.rect,
      goalId: t.id,
      steps: t.steps,
    };
  });
}
async function automaticInterruption(s, r) {
  const action = { autoPause: 'Pause', autoTakeover: 'Take over', autoStop: 'Stop' }[r.group];
  await check(s, r, 'DG04 DG06 direct automatic ' + action, async () => {
    const initial = await practice(s);
    await s.page.$eval(sel, (e) => e.addEventListener('click', (event) => event.preventDefault()));
    await button(s.panel, 'Take me there').click();
    assert(!(await state(s)).task.adaptive.authorized);
    await button(s.panel, 'Start automatic').click();
    await button(s.panel, 'Tuck panel').click();
    const transition = await until(async () => {
      if (await panelClosed(s)) return 'tucked';
      return (await state(s)).task?.state === 'paused' && 'safe pause before tucking';
    }, 'tuck transition');
    if (transition === 'safe pause before tucking') {
      assert.equal((await state(s)).task.steps, 0);
      return {
        transition,
        taskId: initial.id,
        limitation: 'Compact activation could not be exercised because the product paused safely.',
      };
    }
    const dock = await until(async () => {
      const d = await overlay(s, 'dock');
      return d?.host.visible && d;
    }, 'tucked automation controls');
    const directNames = dock.buttons.filter((b) => b.visible).map((b) => b.name);
    for (const expected of ['Open SafeStep', 'Pause', 'Stop', 'Take over'])
      assert(directNames.includes(expected), directNames.join(', '));
    await shot(s, r, 'auto-controls', false);
    await dockControl(s, action, true);
    await reopen(s);
    const t = await until(async () => {
      const t = (await state(s)).task;
      return t?.id === initial.id && ['paused', 'cancelled'].includes(t.state) && t;
    }, 'immediate local intervention');
    assert.equal(t.steps, 0);
    assert.equal(t.adaptive.authorized, false);
    assert.equal(new URL(s.page.url()).pathname, '/settings-lab');
    await shot(s, r, 'interrupted');
    return { action, directNames, final: t.state, steps: t.steps, taskId: t.id };
  });
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
      assert.equal(c.hint.animations, 0);
      await shot(s, r, 'forced-reduced');
      return {
        chromeEmulation: preference,
        visibleInstruction: c.text,
        renderedTextColor: c.hint.color,
        renderedHintBackground: c.hint.background,
        outline: c.host.border,
      };
    },
  );
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
    const pinned = await s.panel.$eval('[aria-label="Current website warning"]', (e) => ({
      outside: !document.querySelector('[role=log]').contains(e),
      text: e.innerText.slice(0, 450),
    }));
    assert(pinned.outside && pinned.text.includes(new URL(s.page.url()).hostname));
    const v = await until(async () => {
      const d = await overlay(s, 'protection');
      return d?.host.visible && d;
    }, 'page-edge warning');
    await s.page.evaluate(() => scrollBy(0, 140));
    const after = await overlay(s, 'protection');
    assert(Math.abs(v.host.rect.y - after.host.rect.y) <= 2);
    await shot(s, r, 'pinned-warning');
    await clearChat(s);
    const record = (await state(s)).protection;
    assert(record.caution && !record.dismissed);
    await button(s.panel, 'Dismiss warning').click();
    await until(async () => (await state(s)).protection.dismissed, 'dismissal acknowledged');
    const dismissed = (await state(s)).protection;
    assert(dismissed.caution);
    return {
      host: dismissed.host,
      identity: dismissed.identity,
      pinned,
      position: after.host.rect,
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
      cue: c.text,
    };
  });
}
const runners = {
  cue,
  replacement,
  clip,
  tuck,
  autoPause: automaticInterruption,
  autoTakeover: automaticInterruption,
  autoStop: automaticInterruption,
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
