// Installed Chrome DOM reader fixture. Every document is intercepted, including the synthetic Wikipedia route.
// This exercises the real reader independently of an installed panel or live AI.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';

const revision = process.argv[2] ?? 'candidate';
assert(/^[a-z0-9-]+$/.test(revision));
const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './apps/extension/page/assist-reader.ts'; export * from './apps/extension/page/assist-bridge.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'Reader',
  platform: 'browser',
  logLevel: 'silent',
});
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : '/usr/bin/google-chrome'),
  headless: true,
  pipe: true,
  defaultViewport: null,
  args: ['--disable-background-networking'],
});
const rows = [];
const goal = 'Show me how to find the Wikipedia article about the atmosphere of Earth.';
try {
  const p = await browser.newPage();
  await p.setRequestInterception(true);
  let markup = '';
  p.on('request', (r) => {
    void (r.isNavigationRequest()
      ? r.respond({
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><meta charset=utf-8>' + markup,
        })
      : r.abort());
  });
  const doc = async (url, html) => {
    markup = html;
    await p.goto(url);
    await p.addScriptTag({ content: outputFiles[0].text });
  };
  for (const size of [
    [1440, 900],
    [1366, 768],
  ]) {
    await p.setViewport({ width: size[0], height: size[1] });
    async function check(name, fn) {
      try {
        await fn();
        rows.push({ name, size, pass: true });
      } catch (e) {
        rows.push({ name, size, pass: false, error: e.message.slice(0, 220) });
      }
    }
    await doc(
      'https://en.wikipedia.org/w/index.php?title=Special%3ASearch&search=the+atmosphere+of+Earth',
      '<main><h1>Search results</h1>' +
        Array.from(
          { length: 52 },
          (_, i) => '<a href="/wiki/Topic_' + i + '">Topic ' + i + '</a> ',
        ).join('') +
        '<a href="/wiki/Atmosphere_of_Earth">Atmosphere of Earth</a></main>',
    );
    await check('Late exact article appears in the bounded initial result batch', async () => {
      const snapshot = await p.evaluate((g) => Reader.scanAssist(g).snapshot, goal);
      assert.equal(snapshot.complete, null);
      assert.equal(
        snapshot.controls.filter((c) => c.path === '/wiki/Atmosphere_of_Earth').length,
        1,
      );
      assert(snapshot.controls.length <= 32);
    });
    await doc(
      'https://example.org/library',
      '<main><h1>Library</h1>' +
        '<section><h2>Teaching</h2><a id="teach" href="/reading">Read more</a></section>' +
        '<section><h2>Research</h2><a href="/reading">Read more</a></section>' +
        '<nav aria-label="Footer"><a href="/books">Books</a><a href="/books">Books</a></nav>' +
        '<section aria-label="password: privatevalue"><a href="/other">Other resources</a></section></main>',
    );
    await check(
      'Repeated labels use public section context and retire the ref when that context changes',
      async () => {
        const result = await p.evaluate(() => {
          const before = Reader.scanAssist('Find teaching resources');
          const teach = before.snapshot.controls.find((c) => c.context === 'Teaching');
          const names = before.snapshot.controls
            .filter((c) => c.label === 'Read more')
            .map((c) => c.context)
            .sort();
          document.querySelector('section h2').textContent = 'Old materials';
          const replacement = Reader.scanAssist('Find teaching resources', [], before.registry);
          return {
            names,
            retired: !!teach && !replacement.registry.has(teach.ref),
            secretReturned: JSON.stringify(before.snapshot).includes('privatevalue'),
            unresolved: before.snapshot.controls.filter((c) => c.label === 'Books').length,
          };
        });
        assert.deepEqual(result, {
          names: ['Research', 'Teaching'],
          retired: true,
          secretReturned: false,
          unresolved: 0,
        });
      },
    );
    await doc(
      'https://en.wikipedia.org/wiki/Rule_of_Rome_by_Gaul',
      '<main><h1>Rule of Rome by Gaul</h1><p>Fixture article</p></main>',
    );
    await check(
      'The same words with opposing subject and object do not prove article completion',
      async () => {
        const complete = await p.evaluate(
          () =>
            Reader.scanAssist('Find the Wikipedia article about rule of Gaul by Rome.').snapshot
              .complete,
        );
        assert.equal(complete, null);
      },
    );
    await doc(
      'https://en.wikipedia.org/wiki/Atmosphere_of_Earth',
      '<main><h1>Atmosphere of Earth</h1></main>',
    );
    await check(
      'Matching visible title and article path prove completion; a covering overlay removes that proof',
      async () => {
        const observed = await p.evaluate((g) => {
          const visible = Reader.scanAssist(g).snapshot.complete;
          document.body.insertAdjacentHTML(
            'beforeend',
            '<div style="position:fixed;inset:0;background:white;z-index:100"></div>',
          );
          return { visible, covered: Reader.scanAssist(g).snapshot.complete };
        }, goal);
        assert.deepEqual(observed, { visible: 'Atmosphere of Earth', covered: null });
      },
    );
    for (const modified of [false, true]) {
      await doc(
        'https://example.org/library',
        '<main><h1>Library</h1><a id="target" href="/reading">Reading room</a></main>',
      );
      await check(
        modified
          ? 'A modified click cannot claim the same-tab transition'
          : 'The trusted user link click survives page-driven removal of its selected element',
        async () => {
          await p.evaluate(() => {
            const id = 'a'.repeat(32);
            const notes = (window.notes = []);
            let receive;
            Object.defineProperty(window.chrome, 'runtime', {
              value: {
                id,
                getURL: (p) => 'chrome-extension://' + id + '/' + p,
                onMessage: { addListener: (fn) => (receive = fn) },
                sendMessage: async (m) => notes.push(m.event),
              },
              configurable: true,
            });
            Reader.installAssistBridge();
            const binding = {
              operationId: crypto.randomUUID(),
              taskId: crypto.randomUUID(),
              tabId: 1,
              windowId: 1,
              documentId: 'a'.repeat(32),
              revision: crypto.randomUUID(),
              epoch: 1,
              generation: 1,
              goalVersion: 1,
              origin: location.origin,
            };
            function msg(cmd) {
              let reply;
              receive(
                { channel: 'assist-page', binding, requestId: crypto.randomUUID(), cmd },
                { id, url: chrome.runtime.getURL('background.js') },
                (r) => (reply = r),
              );
              if (!reply?.ok) throw Error(reply?.error ?? 'fixture bridge did not reply');
              return reply;
            }
            const ref = msg({ op: 'inspect', goal: 'Find Reading room', terms: [] }).snapshot
              .controls[0].ref;
            msg({ op: 'cue', ref, action: 'activate_readonly_link', scroll: true });
            const a = document.querySelector('#target');
            // Mimics a hydrated link replacing its node during a real user click.
            a.addEventListener('click', (ev) => {
              ev.preventDefault();
              a.replaceWith(a.cloneNode(true));
            });
          });
          if (modified) await p.keyboard.down('Shift');
          try {
            await p.click('#target');
          } finally {
            if (modified) await p.keyboard.up('Shift');
          }
          const notes = await p.evaluate(() => window.notes);
          assert.deepEqual(notes, modified ? ['changed'] : ['user_target']);
        },
      );
    }
  }
  const out = resolve('docs/evidence/functional-navigation/reader');
  await mkdir(out, { recursive: true });
  await writeFile(
    resolve(out, revision + '.json'),
    JSON.stringify(
      {
        role: 'builder',
        at: new Date().toISOString(),
        revision,
        chrome: await browser.version(),
        coverage:
          'Real Chrome, intercepted fixture documents, reader module only. Zero model calls, no live website or native panel.',
        rows,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(rows));
  if (rows.some((r) => !r.pass)) process.exitCode = 1;
} finally {
  await browser.close();
}
