// Builder verification of the compiled paired service with the actual outside source.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MerchantReply } from '@safestep/contracts';
import { makeApi } from '../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../apps/api/dist/gemini.js';
import { fingerprint } from '../scripts/stage1.mjs';

const folder = process.env.SAFESTEP_MERCHANT_EVIDENCE || '.test-artifacts/stage7/merchant';
await fs.mkdir(folder, { recursive: true });
const hash = async (p) =>
  createHash('sha256')
    .update(await fs.readFile(p))
    .digest('hex');
const files = [
  'apps/api/dist/app.js',
  'apps/api/dist/merchant.js',
  'packages/contracts/dist/merchant.js',
];
const evidence = {
  role: 'builder',
  stage: 7,
  at: new Date().toISOString(),
  type: 'compiled paired API and genuine Washington State public dataset; not installed Chrome',
  sources: Object.fromEntries(await Promise.all(files.map(async (f) => [f, await hash(f)]))),
  calls: [],
  status: 'not_run',
};
if (process.env.SAFESTEP_BUNDLE) {
  evidence.bundle = path.resolve(process.env.SAFESTEP_BUNDLE);
  evidence.sha256 = (await fingerprint(evidence.bundle)).sha256;
}
const token = newPairToken(),
  origin = 'chrome-extension://' + 'a'.repeat(32);
const api = makeApi(undefined, new GeminiService({}, token)).listen(0, '127.0.0.1');
try {
  await once(api, 'listening');
  const post = (route, body) =>
    fetch('http://127.0.0.1:' + api.address().port + route, {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
  const pair = await post('/v1/explain/connect', {});
  assert.equal(pair.status, 200);
  await pair.text();
  for (const domain of ['www.wayfair.com', 'example.org']) {
    const response = await post('/v1/merchant/check', { domain });
    const result = MerchantReply.parse(await response.json());
    evidence.calls.push({ domain, http: response.status, result });
    assert.equal(response.status, 200);
    assert.equal(result.domain, domain);
    if (domain === 'example.org') {
      assert.equal(result.status, 'no_match');
      assert.equal(result.distinctComplaints, 0);
    } else {
      assert.equal(result.status, 'reports');
      assert.equal(result.severity, 'caution');
      assert.equal(result.businessId, '262022');
      assert(result.distinctComplaints >= 2);
      assert.equal(new Set(result.records.map((x) => x.id)).size, result.records.length);
      assert(
        result.records.every(
          (x) => x.practices.length && new URL(x.url).origin === 'https://data.wa.gov',
        ),
      );
    }
  }
  evidence.status = 'pass';
} catch (e) {
  evidence.status = 'fail';
  evidence.error = String(e?.message ?? e).slice(0, 260);
  process.exitCode = 1;
} finally {
  api.closeAllConnections();
  await new Promise((ok) => api.close(ok));
  const file = path.join(folder, 'merchant-wire-' + evidence.at.replace(/[:.]/g, '-') + '.json');
  await fs.writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    evidence.status,
    file,
    evidence.calls.map((c) => [c.domain, c.result.status, c.result.distinctComplaints]),
    evidence.error ?? '',
  );
}
