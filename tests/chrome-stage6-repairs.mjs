// Replay the dedicated tester's UI probes without writing to their QA directory.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fingerprint } from '../scripts/stage1.mjs';
const run = resolve('QA_REPORTS/stage-6-b6d12dbfde9f-20261107T2316Z');
const qa = JSON.parse(await readFile(join(run, 'REPORT.json'), 'utf8'));
assert.equal(qa.status, 'completed');
const bundle = resolve(process.env.SAFESTEP_BUNDLE ?? qa.release.directory),
  { sha256 } = await fingerprint(bundle);
const dest = resolve('.test-artifacts', 'stage6-repairs', sha256.slice(0, 12)),
  proc = join(dest, 'procedure');
await mkdir(proc, { recursive: true });
await mkdir(join(dest, 'evidence'), { recursive: true });
await writeFile(
  join(dest, 'evidence', 'release.json'),
  JSON.stringify({ directory: bundle, sha256 }),
);
for (const name of ['probes.mjs', 'native-qa.mjs'])
  await copyFile(join(run, 'procedure', name), join(proc, name));
let source = await readFile(join(run, 'procedure', 'suite.mjs'), 'utf8');
source = source
  .replace(
    /from '(\.\.\/\.\.\/\.\.\/[^']+)'/g,
    (_, p) => 'from ' + JSON.stringify(pathToFileURL(resolve(run, 'procedure', p)).href),
  )
  .replaceAll(
    'independent tester; newly executed Chrome observations',
    'builder; reproduced using independent procedure',
  );
await writeFile(join(proc, 'suite.mjs'), source);
const mode = process.env.SAFESTEP_S6_REPAIR_AI === '1' ? 'ai' : 'probes';
const sets =
  mode === 'ai'
    ? 'ai'
    : (process.env.SAFESTEP_S6_FIX_CASES ??
      'mozillaNegation,nibs,liveNib,partialSort,pickup,removedRefresh,excludedReason,filteredSource,reasonFit');
const cp = spawn(
  process.execPath,
  [
    join(proc, 'suite.mjs'),
    mode,
    process.env.SAFESTEP_WIDTH ?? 'both',
    sets,
    process.env.SAFESTEP_REPAIR_TRIAL ?? 'builder',
  ],
  { stdio: 'inherit', windowsHide: true },
);
process.exitCode = await new Promise((ok, no) => {
  cp.on('exit', ok);
  cp.on('error', no);
});
