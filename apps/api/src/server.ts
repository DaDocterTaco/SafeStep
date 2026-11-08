import { apiPort, makeApi } from './app.js';
import { writeFileSync } from 'node:fs';
import { GeminiService, newPairToken } from './gemini.js';
import { guardedRuntimeActive, initializeWebRiskBudget, migrateWebRiskBudget, WebRiskService } from './web-risk.js';
if (process.argv.includes('--init-web-risk-budget')) {
  if (process.env.SAFESTEP_WEB_RISK_AUTHORIZED !== 'true') {
    throw new Error('Confirm separate Web Risk authorization before creating its budget.');
  }
  initializeWebRiskBudget(undefined, Number(process.env.SAFESTEP_WEB_RISK_DAILY_LIMIT?.trim() || 12));
  console.info('Web Risk daily budget initialized. No provider request was made.');
  process.exit(0);
}
if(process.argv.includes('--migrate-web-risk-budget')) {
  if(process.env.SAFESTEP_WEB_RISK_AUTHORIZED!=='true') throw Error('Separate Web Risk authorization is required.');
  const limits=migrateWebRiskBudget(undefined,process.argv.includes('--approve-automatic-profile'));
  console.info('Web Risk operating profile:',limits.profile,'with',limits.dayCap,'attempts/day and',limits.monthCap,'attempts/month. No provider request was made.');
  process.exit(0);
}
const token = newPairToken();
const modelEnabled = process.argv.includes('--enable-gemini');
if(modelEnabled&&!guardedRuntimeActive()) throw Error('Use the guarded model start command. The approved Gemini ledger must be active.');
makeApi(undefined, new GeminiService(modelEnabled ? process.env : {}, token), undefined,
  new WebRiskService(process.env)).listen(apiPort, '127.0.0.1', () => {
  writeFileSync(new URL('../.env.safestep-session', import.meta.url), token + '\n', {
    mode: 0o600,
  });
  console.info(
    'SafeStep API listening on 127.0.0.1:' +
      apiPort +
      '. Local pairing token saved in apps/api/.env.safestep-session (30 minutes). ' +
      (modelEnabled ? 'Model credentials use the local configuration.' : 'Gemini is off.'),
  );
});
