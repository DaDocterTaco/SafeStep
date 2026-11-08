import assert from 'node:assert/strict';
import { MerchantService } from '../../apps/api/dist/merchant.js';
import { merchantEndpoint, merchantProvider } from '@safestep/contracts';
import { view } from './chrome-cases.mjs';
import { change, installTransport, pair } from './stage7-protection-fixture.mjs';

// The page request at this origin is intercepted before network and fulfilled with labelled test HTML.
export const simulatedAmazon = 'https://www.amazon.com';

export async function syntheticMerchantCases() {
  const now = Date.now();
  const row = (id, daysAgo) => ({
    businessname: 'AMAZON.COM', businessid: '123', complaintid: id,
    openeddate: new Date(now - daysAgo * 86400000).toISOString().slice(0, 10) + 'T00:00:00',
    practicename: 'Failure To Deliver/Perform', status: 'Open',
  });
  const first = row('1', 1), second = row('2', 2);
  const examples = {
    empty: [], single: [first], duplicate: [first, {...first}],
    conflict: [first, {...first, status: 'Closed'}, second],
    repeated: [first, second],
  };
  const replies = {};
  for (const [name, rows] of Object.entries(examples)) {
    const service = new MerchantService(async (url) => {
      assert.equal(url.origin + url.pathname, merchantEndpoint);
      assert(url.searchParams.get('$where').includes("upper(businessname)='AMAZON.COM'"));
      return Response.json(rows);
    }, () => now);
    replies[name] = await service.check({domain: 'www.amazon.com'}, new AbortController().signal);
    assert.equal(replies[name].rowsInspected, rows.length);
  }
  return replies;
}

export async function runPrecedence({s, r, worker, area, button, wait, permission, record, lab}) {
  const cases = await syntheticMerchantCases();
  await installTransport(worker);
  await change(worker, {mode: 'empty', precedence: cases});
  await pair(worker, 'r');
  await area(s.panel, 'Settings');
  await s.panel.select('[aria-label="Auto protection settings"] select', 'selected');
  await s.panel.locator('::-p-aria(Look up outside merchant reports[role="checkbox"])').click();
  await permission(s, 'Allow');
  const current = async () => (await view(s.panel)).v;
  await wait(async () => (await current()).protection?.status === 'private', 'private fixture setup');
  await s.page.goto(simulatedAmazon + '/fixture', {waitUntil: 'domcontentloaded'});
  await wait(async () => (await current()).protection?.status === 'no_match', 'known domain plus no outside match');
  await area(s.panel, 'Safety checks');
  for (const [mode, status, distinct, caution] of [
    ['empty', 'no_match', 0, false], ['single', 'limited', 1, false],
    ['duplicate', 'limited', 1, false], ['conflict', 'limited', 2, false], ['repeated', 'reports', 2, true],
  ]) {
    if (mode !== 'empty') {
      await change(worker, {mode});
      await pair(worker, {single: 's', duplicate: 't', conflict: 'u', repeated: 'v'}[mode]);
      await wait(async () => (await current()).protection?.status === 'unavailable', 'new controlled transport pairing');
      await button(s.panel, 'Recheck protection').click();
    }
    const result = await wait(async () => {
      const p = (await current()).protection;
      return p?.status === status && p.outside === cases[mode].summary && p;
    }, mode + ' normalized evidence shown');
    assert.equal(result.identity, 'amazon_us');
    assert(result.address.includes('Seller feedback is a separate check'));
    assert.equal(result.caution, caution);
    assert.equal(cases[mode].distinctComplaints, distinct);
    const wire = await worker.evaluate(() => globalThis.protectionTest.precedenceReads.at(-1));
    assert.deepEqual(wire, {mode, domain: 'www.amazon.com', distinct});
    assert.equal(result.sources.filter((x) => x.label.startsWith('Complaint ')).length, distinct);
    if (mode === 'duplicate') assert.equal(cases[mode].rowsInspected, 2);
    if (mode === 'conflict') assert(result.details.some((line) => line.includes('Conflicting')));
    const section = '[role=tabpanel]:not([hidden]) [aria-label="Website protection"]';
    await s.panel.waitForFunction((selector, summary) => document.querySelector(selector)?.innerText.includes(summary), {}, section, cases[mode].summary);
    const displayed = await s.panel.$eval(section, (el) => el.innerText);
    assert(displayed.includes(cases[mode].summary) && displayed.includes(merchantProvider));
    assert(!/\d+%\s*(?:safe|fraud)|guaranteed safe|definitely a scam/i.test(displayed));
    await wait(async () => {
      const visible = !!await s.page.$('[data-safestep-protection]');
      const badge = await worker.evaluate((id) => chrome.action.getBadgeText({tabId: id}), (await current()).tabId);
      return visible === caution && (badge === '!') === caution;
    }, mode + ' banner and badge precedence');
    r.observations.push({scope: 'synthetic merchant rows', mode, status, identity: result.identity,
      rows: cases[mode].rowsInspected, distinct, caution, summary: result.outside,
      sources: result.sources, visibleText: displayed});
  }
  await record(s, r, 'simulated-known-merchant-caution');

  await s.page.goto(lab + '/trust-lab?source=match', {waitUntil: 'domcontentloaded'});
  await s.activate(s.page);
  await area(s.panel, 'Safety checks');
  await button(s.panel, 'Check this website').click();
  const threat = await wait(async () => {
    const d = (await current()).review;
    return d?.fixture && d.status === 'reported_threat' && d;
  }, 'manual exact homepage threat fixture');
  const evidence = threat.sources.find((source) => source.kind === 'homepage_threat');
  assert.equal(evidence.source, 'labelled_fixture');
  assert.equal(evidence.state, 'matched');
  assert.equal(evidence.subject, 'https://' + new URL(lab).hostname + '/');
  assert(Date.parse(evidence.expiresAt) > Date.parse(evidence.observedAt));
  const shown = await s.panel.$eval('article[aria-label="Website summary"]', (el) => el.innerText);
  for (const label of ['Threat source reported a match', 'Labelled fixture · Match', 'Threat-list coverage', evidence.subject, 'Coverage checked']) assert(shown.includes(label), label);
  assert.equal(await s.panel.$eval('article[aria-label="Website summary"] h3', (el) => el.innerText), 'Threat source reported a match');
  r.observations.push({scope: 'manually invoked local threat fixture only', evidence, heading: 'Threat source reported a match'});
  r.checks.push('The compiled merchant normalizer handled exact known-domain no match, one report, repeated rows, conflicting statuses, and two distinct dates. Only the two distinct dates produced the automatic warning and badge. The separate manual homepage-threat fixture displayed the exact matched subject, attributed fixture state and time. Live and automatic threat-feed positives are unavailable.');
  r.caseChecks.push('S7-X12');
}
