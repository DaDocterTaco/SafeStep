import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fingerprint } from '../scripts/stage1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'QA_REPORTS', 'stage-5-47d2b97b94a4-20261107T2037Z', 'procedure');
const bundle = resolve(
  process.env.SAFESTEP_BUNDLE || join(root, 'artifacts', 'stage-5-47d2b97b94a4', 'chrome-mv3'),
);
const { sha256 } = await fingerprint(bundle);
const original = sha256 === '47d2b97b94a4617df7225e5d861e0001108bb74512ba3a347db8168b0a916144';
const trial = process.env.SAFESTEP_REPAIR_TRIAL || '';
assert(!trial || /^[a-z0-9-]{1,50}$/i.test(trial), 'Invalid repair trial label');
const output = join(root, '.test-artifacts', 'stage5-repairs', sha256.slice(0, 12), trial);
const scripts = join(output, 'procedure'),
  evidence = join(output, 'evidence');
await Promise.all([mkdir(scripts, { recursive: true }), mkdir(evidence, { recursive: true })]);
const paths = (rel) => JSON.stringify(pathToFileURL(resolve(root, rel)).href);
function replaceOnce(input, from, to) {
  assert(
    input.includes(from),
    'The independent procedure changed. Review adaptation: ' + from.slice(0, 80),
  );
  return input.replace(from, to);
}
let session = await readFile(join(source, 'session.mjs'), 'utf8');
session = replaceOnce(
  session,
  "'../../../tests/support/native-stage2.mjs'",
  paths('tests/support/native-stage2.mjs'),
);
session = replaceOnce(session, "'../../../scripts/stage1.mjs'", paths('scripts/stage1.mjs'));
if(Number(JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8')).version.split('.')[1])>=7){
  session = 'import { openArea } from '+paths('tests/support/stage7-panel.mjs')+';\n'+session;
  session=replaceOnce(session,"export async function click(p, txt, sel = 'button') {",`export async function click(p, txt, sel = 'button') {
  if (txt === 'Check this website') await openArea(p, 'Safety checks');
  if (['Guide me','Start automatic','Preview cleanup','Apply cleanup','Restore item','Restore cleanup'].includes(txt)) await openArea(p, 'Guide');
  if (txt === 'Guide me') txt='Show me';
  if (txt === 'Start automatic') { const preview=await byText(p,'button','Take me there'); await preview.click(); }`);
  session=replaceOnce(session,"export async function goal(p, g) {","export async function goal(p, g) {\n  await openArea(p,'Guide');");
}
const start = session.indexOf('const handoff = '),
  end = session.indexOf('export async function json');
assert(start > 0 && end > start);
session =
  session.slice(0, start) +
  'const report=' +
  JSON.stringify({ build: basename(dirname(bundle)), sha256, unpacked_directory: bundle }) +
  ';\nexport const bundle=report.unpacked_directory,sha=report.sha256,output=' +
  JSON.stringify(evidence) +
  ';\n' +
  session.slice(end);
await writeFile(join(scripts, 'session.mjs'), session);
const groups = [
  [
    'navigation-ui.mjs',
    [
      'guide',
      'automatic',
      'adjacent',
      'deep-guide',
      'deep-auto',
      'covered',
      'late-guide',
      'late-auto',
    ],
  ],
  ['cleanup-ui.mjs', ['baseline', 'protected', 'backdrop', 'zero']],
];
for (const [file] of groups) {
  let s = await readFile(join(source, file), 'utf8');
  s = replaceOnce(s, "'../../../tests/fixtures/serve.mjs'", paths('tests/fixtures/serve.mjs'));
  await writeFile(join(scripts, file), s);
}
const ids = {
  'navigation-deep-guide': 'SS5-01',
  'navigation-deep-auto': 'SS5-01',
  'navigation-late-guide': 'SS5-01',
  'navigation-late-auto': 'SS5-01',
  'navigation-covered': 'SS5-02',
  'cleanup-protected': 'SS5-03',
  'cleanup-backdrop': 'SS5-04',
  'cleanup-baseline': 'SS5-05',
};
const requested = process.env.SAFESTEP_FIX_CASES?.split(','),
  widths = process.env.SAFESTEP_WIDTH ? [Number(process.env.SAFESTEP_WIDTH)] : [1440, 1366];
const results = [];
const checks = [...groups];
if (!original)
  checks.push([
    'nearby.mjs',
    ['uncover', 'wrong-subject', 'detach', 'replace', 'protected-interaction'],
  ]);
for (const width of widths)
  for (const [file, cases] of checks)
    for (const name of cases) {
      const label = (file==='nearby.mjs'?'nearby':file.split('-')[0]) + '-' + name,
        issue = ids[label] ?? null;
      if (requested && !requested.includes(name) && !requested.includes(issue) && !requested.includes(label)) continue;
      const driver =
        file === 'nearby.mjs'
          ? join(root, 'tests/support/stage5-repair-nearby.mjs')
          : join(scripts, file);
      const cp = spawn(process.execPath, [driver, '5', String(width), name], {
        cwd: root,
        windowsHide: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          QA_TRIAL: '',
          SAFESTEP_REPAIR_SESSION: join(scripts, 'session.mjs'),
        },
      });
      const code = await new Promise((ok, no) => {
        cp.on('error', no);
        cp.on('exit', ok);
      });
      const log = join(evidence, 's5-' + width + '-' + label + '.json');
      const actual = JSON.parse(await readFile(log, 'utf8'));
      assert.equal(code, 0);
      assert.equal(actual.release.sha256, sha256);
      const expected = issue && original ? 'fail' : 'pass';
      const row = {
        case: label,
        issue,
        width,
        expected,
        observed: actual.status,
        matched: expected === actual.status,
        log,
        dimensions: actual.dimensions,
      };
      results.push(row);
      await writeFile(
        join(output, 'results.json'),
        JSON.stringify(
          {
            role: 'builder',
            original,
            sha256,
            bundle,
            at: new Date().toISOString(),
            sourceProcedure: source,
            results,
          },
          null,
          2,
        ) + '\n',
      );
    }
assert(results.length > 0);
if (results.some((r) => !r.matched)) {
  console.error(results.filter((r) => !r.matched));
  process.exitCode = 1;
}
