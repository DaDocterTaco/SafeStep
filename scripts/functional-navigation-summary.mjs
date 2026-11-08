// Summarize immutable builder runs; retain unsuccessful attempts and their evidence.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const build = process.argv[2];
assert.match(build, /^stage-8-[0-9a-f]{12}$/);
const directory = 'docs/evidence/functional-navigation/native/' + build;
const entries = await readdir(directory, { withFileTypes: true });
const attempts = [];
for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const source = directory + '/' + entry.name + '/results.json';
  const result = await readFile(source, 'utf8')
    .then(JSON.parse)
    .catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  if (!result) continue;
  assert.equal(result.build, build);
  const live = result.model === 'gemini-3.5-flash-lite';
  for (const [i, row] of (result.sessionRows ?? result.rows ?? []).entries()) {
    const receipts = (row.connector ?? []).filter(
      (c) => c.bound && c.validated && c.status === 'available',
    );
    attempts.push({
      case: row.name,
      width: row.width,
      height: row.dimensions?.closed.height,
      zoom: row.dimensions?.zoom,
      attempt: i + 1,
      transport: live
        ? 'genuine Gemini'
        : row.connector
          ? 'labelled model/real public website'
          : 'labelled model/controlled local website',
      status: row.status,
      reason: row.error ?? null,
      destination: row.destination ?? row.finalLocation ?? null,
      visibleHeading: row.heading?.text ?? row.observedHeading?.text ?? null,
      clicksInAutomatic: row.auto ? row.guideSiteActions.length : null,
      fileRequests: row.fileRequests ?? null,
      downloads: row.downloads ?? null,
      receipts: receipts.map((r) => r.operation),
      source,
    });
  }
}
const counts = {};
for (const t of attempts) {
  const key = t.transport + ' / ' + t.status;
  counts[key] = (counts[key] ?? 0) + 1;
}
const out = path.join(directory, 'attempt-index.json');
await writeFile(
  out,
  JSON.stringify(
    { role: 'builder', build, updated: new Date().toISOString(), counts, attempts },
    null,
    2,
  ) + '\n',
);
console.log(out, counts);
