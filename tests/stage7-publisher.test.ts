import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  publisherChoice,
  publisherInformationTarget,
  publisherStep,
  isPublisherTerminal,
} from '../apps/extension/sites/publisher-goal';
import type { AssistSnapshot } from '@safestep/contracts';
const vlc = 'vlc_windows_x64',
  zip = 'seven_zip_windows_x64_exe',
  origin = 'https://www.videolan.org';
test('Natural download requests require a matching publisher, product and explicitly confirmed package', () => {
  assert.deepEqual(publisherChoice('Help me find the Windows VLC download.', origin), {
    kind: 'clarify',
    message: 'Confirm the application and Windows x64 EXE package you want to find.',
    choices: [vlc],
  });
  assert.deepEqual(publisherChoice('Help me find the Windows VLC download.', origin, vlc), {
    kind: 'ready',
    profile: vlc,
  });
  assert.deepEqual(
    publisherChoice('Help me find the right Windows x64 download.', 'https://www.7-zip.org'),
    { kind: 'ready', profile: zip },
  );
  for (const text of [
    'Find the Firefox Windows download',
    'VLC download for macOS',
    'Find a 7-Zip installer without an EXE',
    'Find the portable VLC download',
    'Find VLC 3.0.1 download',
    'Find the Audacity download',
  ])
    assert.notEqual(publisherChoice(text, origin, vlc).kind, 'ready', text);
  assert.notEqual(
    publisherChoice(
      'Find the right VLC Windows x64 download.',
      'https://www.videolan.org.attacker.example',
      vlc,
    ).kind,
    'ready',
  );
  for (const pageGoal of ['Find VLC for Windows.', 'Where is the Windows download page?', 'Show the official Windows VLC download page.']) {
    assert.equal(publisherChoice(pageGoal, origin).kind, 'unrelated', pageGoal);
  }
});
test('An official website request keeps its exact publisher, product and package', () => {
  for (const [product, site, profile] of [
    ['VLC', origin, vlc],
    ['7-Zip', 'https://www.7-zip.org', zip],
  ] as const) {
    const text = 'Help me find the ' + product + ' Windows x64 EXE download on the official website.';
    assert.deepEqual(publisherChoice(text, site), { kind: 'ready', profile });
    assert.deepEqual(publisherChoice(text, site, profile), { kind: 'ready', profile });
    assert.notEqual(publisherChoice(text, 'https://download.example', profile).kind, 'ready');
    assert.notEqual(publisherChoice(text, site === origin ? 'https://www.7-zip.org' : origin, profile).kind, 'ready');
    for (const qualified of [
      'Not the ' + product + ' Windows x64 EXE download on the official website.',
      'Find the ' + product + ' Windows x64 EXE download on the Softonic website.',
      text + ' I need version 3.0.20.',
      text + ' I need version 64.',
      'Find the ' + product + ' and Audacity Windows x64 EXE download on the official website.',
      'Find the VLC and 7-Zip Windows x64 EXE download on the official website.',
    ]) {
      assert.notEqual(publisherChoice(qualified, site, profile).kind, 'ready', qualified);
    }
  }
});
test('Publisher actions use a unique observed information control and do not dispatch a file URL', () => {
  const u = origin + '/vlc/download-windows.html';
  assert(isPublisherTerminal(new URL(u), vlc));
  assert(!isPublisherTerminal(new URL(u + '?private=token'), vlc));
  for (const raw of [
    'https://evil.test/vlc/download-windows.html',
    origin + '/download/file.exe',
    origin + '/vlc/download-windows.html?x=y',
    'https://get.videolan.org/vlc/3.0.0/win64/vlc-3.0.0-win64.exe',
  ])
    assert(!publisherInformationTarget(new URL(raw), vlc));
  const ref = {
    ref: crypto.randomUUID(),
    label: 'Windows',
    role: 'link' as const,
    path: '/vlc/download-windows.html',
    action: 'activate_readonly_link' as const,
    visible: true,
  };
  const snap: AssistSnapshot = {
    profile: 'publisher',
    path: '/',
    headings: [],
    controls: [ref],
    limited: false,
    complete: null,
  };
  assert.equal(publisherStep(snap, vlc).kind, 'next_candidate');
  assert.equal(
    publisherStep({ ...snap, controls: [ref, { ...ref, ref: crypto.randomUUID() }] }, vlc).kind,
    'clarify',
  );
  assert.equal(
    publisherStep({ ...snap, controls: [{ ...ref, path: '/vlc/file.exe' }] }, vlc).kind,
    'cannot_continue',
  );
});
