import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from './stage1.mjs';

const id = process.argv[2];
assert.match(id ?? '', /^stage-8-[a-f0-9]{12}$/, 'Supply the frozen Stage 8 build ID.');
const root = await realpath('.');
const evidence = 'docs/evidence/' + id;
const pointerName = evidence + '/current-reference.json';
const readJSON = async (name) => JSON.parse(await readFile(name, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pointer = await readJSON(pointerName);
assert.equal(pointer.id, id);
const referenceName = evidence + '/reference-' + pointer.sourceSHA256.slice(0, 16) + '.json';
assert.equal(pointer.path, referenceName);
const ref = await readJSON(referenceName);
assert.equal(ref.id, id);
assert.equal(ref.extensionSHA256, pointer.extensionSHA256);
assert.equal(ref.source.sha256, pointer.sourceSHA256);
assert.equal(ref.router.schemaSHA256, ref.source.files[ref.router.schema]);
assert.equal(ref.directory, 'artifacts/' + id + '/chrome-mv3');
assert.equal((await fingerprint(ref.directory)).sha256, ref.extensionSHA256);
assert.match(ref.extensionSHA256, new RegExp('^' + id.slice(-12)));

const publicName = (name) =>
  name === 'apps/api/.env.example' ||
  (!name
    .split('/')
    .some((part) => !part || part.startsWith('.') || ['node_modules', 'dist'].includes(part)) &&
    /^[A-Za-z0-9_./-]+$/.test(name) &&
    !/\.(?:pem|p12|key|crt|der)$/i.test(name));
const sensitive =
  /AIza[\w-]{30,}|ss3_[\w-]{32,}|gh[pousr]_[A-Za-z\d]{30,}|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
async function checkDigestMap(record) {
  const aggregate = createHash('sha256');
  for (const name of Object.keys(record.files).sort()) {
    assert(!path.isAbsolute(name) && !name.includes('..') && /^[A-Za-z0-9_./-]+$/.test(name));
    const bytes = await readFile(name);
    assert.equal(
      hash(bytes),
      record.files[name],
      'Current bytes differ from the reference: ' + name,
    );
    aggregate.update(name + '\0' + bytes.length + '\0').update(bytes);
  }
  assert.equal(aggregate.digest('hex'), record.sha256);
}
await checkDigestMap(ref.source);
await checkDigestMap(ref.api);
await checkDigestMap(ref.compiledContracts);

async function publicFiles(dir, allowed) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || ['dist', 'node_modules'].includes(item.name)) continue;
    const name = dir + '/' + item.name;
    if (item.isDirectory()) files.push(...(await publicFiles(name, allowed)));
    else if (item.isFile() && allowed.test(item.name)) files.push(name);
    else assert(!item.isSymbolicLink(), 'Unexpected linked source: ' + name);
  }
  return files;
}
const sourceFiles = Object.keys(ref.source.files);
const files = [
  ...new Set([
    ...sourceFiles,
    ...(await publicFiles('scripts', /\.mjs$/)),
    ...(await publicFiles('tests', /\.(?:ts|mjs|js|html|css|ps1|json)$/)),
    'FOUNDATION_PLAN.json',
    'RESEARCH_STATE.json',
    ...(ref.supplement==='automatic-web-risk-1'?['AUTOMATIC_WEB_RISK_PLAN.json','ALL_FEATURES_THREE_SITE_BUILD_PLAN.json','THREE_SITE_COVERAGE_PLAN.json','docs/automatic-web-risk-setup.md']:[]),
    'apps/api/.env.example',
    pointerName,
    referenceName,
  ]),
].sort();
const hashes = {};
const disk = new Map();
for (const name of files) {
  assert(publicName(name), 'Private or unsafe archive name: ' + name);
  const full = path.resolve(name);
  assert.equal(await realpath(full), full, 'Linked source cannot enter the archive: ' + name);
  assert((await lstat(full)).isFile());
  const bytes = await readFile(full);
  assert(!sensitive.test(bytes.toString('utf8')), 'Credential pattern in ' + name);
  if (name === 'apps/api/.env.example') {
    assert(
      bytes
        .toString('utf8')
        .split(/\r?\n/)
        .every(
          (line) =>
            !line.trim() || line.trim().startsWith('#') || /^[A-Z][A-Z0-9_]*=$/.test(line.trim()),
        ),
    );
  }
  hashes[name] = hash(bytes);
  disk.set(name, full);
}

const setup = [
  '# Rebuild the SafeStep Stage 8 source',
  '',
  'Verify the downloaded ZIP against the adjacent CHECKSUMS.json using Get-FileHash. Extract it into a fresh folder. Open PowerShell there using Node 24 and npm 11.',
  '',
  '```powershell',
  'npm.cmd ci',
  'npm.cmd run typecheck',
  'npm.cmd test',
  'npm.cmd run build',
  'npm.cmd run release:stage8',
  'node scripts/stage8-reference.mjs ' + id,
  '```',
  '',
  'The release command prints the extension fingerprint. The reference command checks the rebuilt extension against the frozen copy and hashes the API, compiled contracts and router schema. Compare its reference with the copy included in this archive.',
  '',
  'Extension SHA-256 `' + ref.extensionSHA256 + '`',
  '',
  'Source SHA-256 `' + ref.source.sha256 + '`',
  '',
  'Compiled API SHA-256 `' + ref.api.sha256 + '`',
  '',
  'Compiled contracts SHA-256 `' + ref.compiledContracts.sha256 + '`',
  '',
  'Chat routing schema SHA-256 `' + ref.router.schemaSHA256 + '`',
  '',
  'Load the rebuilt `artifacts/' +
    id +
    '/chrome-mv3` in Chrome using Developer mode and Load unpacked. In a separate terminal run `npm.cmd run fixture -- --port=0` for labelled practice pages. `npm.cmd run api` starts the keyless loopback service; its local pairing token is generated at startup. Use Settings to pair for eligible merchant lookups. Gemini testing remains deferred.',
  '',
  'The unit-test inputs and Stage 8 native verifiers are included. Historical independent replay drivers may also need their corresponding QA_REPORTS from the original project. Independent tester results belong in a separate handoff.',
  '',
].join('\n');
const prefix = id + '-source-' + ref.source.sha256.slice(0, 16);
const artifacts = path.join(root, 'artifacts');
const dest = path.join(artifacts, prefix);
const tar = process.platform === 'win32' ? 'tar.exe' : 'bsdtar';
const runTar = (args, options = {}) =>
  execFileSync(tar, args, {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' },
    ...options,
  });
const zipName = 'SafeStep-source.zip';
const setupBytes = Buffer.from(setup);
hashes['SETUP.md'] = hash(setupBytes);
const names = Object.keys(hashes).sort();
const inventorySHA = hash(
  Buffer.from(names.map((name) => name + '\0' + hashes[name] + '\n').join('')),
);

function extractedContents(zip) {
  const listed = runTar(['-tf', zip], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(listed, names, 'Unexpected archive inventory or ordering.');
  for (const name of names) {
    assert.equal(
      hash(runTar(['-xOf', zip, name])),
      hashes[name],
      'Extracted bytes differ for ' + name,
    );
  }
}
const already = await lstat(dest).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (already) {
  assert(already.isDirectory() && !already.isSymbolicLink());
  const meta = await readJSON(path.join(dest, 'CHECKSUMS.json'));
  assert.equal(
    meta.inventorySHA256,
    inventorySHA,
    'Archive already exists with different supplemental inputs.',
  );
  assert.equal(meta.archiveSHA256, hash(await readFile(path.join(dest, zipName))));
  assert.equal(meta.sourceSHA256, ref.source.sha256);
  assert.equal(meta.extensionSHA256, ref.extensionSHA256);
  assert.deepEqual(meta.files, hashes);
  extractedContents(path.join(dest, zipName));
  console.log(dest, meta.archiveSHA256);
} else {
  const staging = await mkdtemp(path.join(artifacts, '.stage8-source-'));
  try {
    const publicDir = path.join(staging, 'publish');
    await mkdir(publicDir);
    const setupFile = path.join(publicDir, 'SETUP.md');
    await writeFile(setupFile, setupBytes);
    disk.set('SETUP.md', setupFile);
    // A libarchive mtree manifest supplies normalized file metadata. This keeps
    // repeat ZIPs independent of checkout timestamps, file ownership and modes.
    const escapeMtree = (s) =>
      s.replace(/[\\\s#=]/g, (ch) => '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0'));
    const entries = await Promise.all(
      names.map(async (name) => {
        const full = disk.get(name);
        const size = (await lstat(full)).size;
        return (
          escapeMtree(name) +
          ' type=file mode=0644 uid=0 gid=0 time=946684800.0 size=' +
          size +
          ' contents=' +
          escapeMtree(full.split(path.sep).join('/'))
        );
      }),
    );
    const manifest = path.join(staging, 'source.mtree');
    await writeFile(manifest, '#mtree\n' + entries.join('\n') + '\n');
    const zip = path.join(publicDir, zipName);
    runTar(['-a', '-cf', zip, '@' + manifest]);
    extractedContents(zip);
    const archiveSHA256 = hash(await readFile(zip));
    await writeFile(
      path.join(publicDir, 'CHECKSUMS.json'),
      JSON.stringify(
        {
          role: 'builder',
          stage: 8,
          id,
          archive: zipName,
          archiveSHA256,
          inventorySHA256: inventorySHA,
          extensionSHA256: ref.extensionSHA256,
          sourceSHA256: ref.source.sha256,
          apiSHA256: ref.api.sha256,
          compiledContractsSHA256: ref.compiledContracts.sha256,
          routerSchemaSHA256: ref.router.schemaSHA256,
          reference: referenceName,
          files: hashes,
          verified: 'Exact inventory and SHA-256 of every extracted ZIP member.',
        },
        null,
        2,
      ) + '\n',
    );
    await rename(publicDir, dest);
    console.log(dest, archiveSHA256);
  } finally {
    const actual = await realpath(staging);
    assert.equal(path.dirname(actual), artifacts);
    assert(path.basename(actual).startsWith('.stage8-source-'));
    await rm(actual, { recursive: true });
  }
}
