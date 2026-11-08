import { createHash } from 'node:crypto';
import { readdir, readFile, cp, mkdir, access } from 'node:fs/promises';
import { resolve, relative, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function fingerprint(dir) {
  const names = [];
  async function walk(path) {
    for (const e of await readdir(path, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(path, e.name));
      else if (e.isFile()) names.push(relative(dir, join(path, e.name)).split(sep).join('/'));
      else throw Error('Unexpected entry in extension bundle');
    }
  }
  await walk(dir);
  names.sort();
  const hash = createHash('sha256');
  for (const n of names) {
    const content = await readFile(join(dir, n));
    hash.update(n + '\0' + content.length + '\0');
    hash.update(content);
  }
  return { sha256: hash.digest('hex'), names };
}
// Snapshot the already-built extension. Never overwrite a previous tester handoff.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const from = resolve('apps/extension/.output/chrome-mv3'),
    { sha256 } = await fingerprint(from);
  const stage = process.argv[2] ?? '1';
  const version = JSON.parse(await readFile(join(from, 'manifest.json'), 'utf8')).version;
  if (!['1', '2', '3', '4', '5', '6', '7', '8'].includes(stage) || !version.startsWith('0.' + stage + '.'))
    throw Error('Release stage must match the built manifest version.');
  const base = resolve('artifacts', 'stage-' + stage + '-' + sha256.slice(0, 12)),
    to = join(base, 'chrome-mv3');
  await mkdir(base, { recursive: true });
  let exists = true;
  try {
    await access(to);
  } catch {
    exists = false;
  }
  if (!exists) await cp(from, to, { recursive: true, force: false, errorOnExist: true });
  if ((await fingerprint(to)).sha256 !== sha256)
    throw Error('Existing release directory differs. Refusing to overwrite it.');
  console.log(to + '\nSHA-256 ' + sha256);
}
