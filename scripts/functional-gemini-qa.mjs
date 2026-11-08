// Explicit private builder runtime for real navigation checks on an identified release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PaidLedger } from './stage8-paid-ledger.mjs';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';

assert(
  process.execArgv.some(
    (arg, i) =>
      arg === '--import' &&
      path.resolve(process.execArgv[i + 1]) === path.resolve('scripts/stage8-paid-ledger.mjs'),
  ),
  'Use the durable generation guard.',
);
assert(process.argv.includes('--enable-gemini'));
assert.equal(process.env.SAFESTEP_GEMINI_CALLER_ROLE,'builder','The builder runtime must retain the eight owner slots.');
assert.equal(process.env.GEMINI_MODEL, 'gemini-3.5-flash-lite');
assert(process.env.GEMINI_API_KEY?.trim());
const build = process.env.SAFESTEP_NAV_BUILD;
assert.match(build, /^stage-8-[0-9a-f]{12}$/);
const pointer = JSON.parse(
  await readFile('docs/evidence/' + build + '/current-reference.json', 'utf8'),
);
assert.equal(pointer.id, build);
const ref = JSON.parse(await readFile(pointer.path, 'utf8'));
for (const group of [ref.api, ref.compiledContracts]) {
  for (const [filename, hash] of Object.entries(group.files)) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(filename))
        .digest('hex'),
      hash,
      'Release module differs ' + filename,
    );
  }
}
const ledger = new PaidLedger(path.resolve('.test-artifacts/stage8-paid-budget'));
const start = ledger.status();
const session = start.sessions.at(-1);
assert(
  session && session.expires > Date.now() && session.attempts < 30 && start.remainingUSD >= 0.1,
  'The current ledger window has no usable allowance.',
);
ledger.close();
const runtime = path.resolve('.test-artifacts/functional-paid');
const evidence = path.resolve(
  'docs/evidence/functional-navigation/live',
  build,
  'session-' + session.id,
);
await mkdir(runtime, { recursive: true });
await mkdir(evidence, { recursive: true });
const token = newPairToken(),
  gemini = new GeminiService(process.env, token),
  server = makeApi(undefined, gemini);
server.listen(4317, '127.0.0.7', async () => {
  await writeFile(path.join(runtime, '.env.safestep-session'), token + '\n', { mode: 0o600 });
  await writeFile(
    path.join(evidence, 'runtime-' + process.pid + '.json'),
    JSON.stringify(
      {
        role: 'builder',
        started: new Date().toISOString(),
        schema: 'SafeStep Stage 8 chat 1 and assist 1',
        build,
        extensionSHA256: ref.extensionSHA256,
        sourceSHA256: ref.source.sha256,
        apiSHA256: ref.api.sha256,
        model: gemini.chatHealth().model,
        host: '127.0.0.7:4317',
        pid: process.pid,
        ledgerSession: session.id,
        callerRole: 'builder',
        ownerReserve: 8,
        expires: new Date(session.expires).toISOString(),
        startingExposureUSD: start.exposureUSD,
        startingGenerations: session.attempts,
        hardCapUSD: start.capUSD,
        perMinute: 6,
        perSession: 30,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.info(
    'Identified guarded SafeStep QA service listening on private loopback. Token was saved to the ignored runtime folder.',
  );
});
