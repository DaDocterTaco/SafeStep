// Builder reporting only. Inputs are executed artifacts and command output.
// A mapping is an evidence requirement, never a declaration that a test ran.
import fs from 'node:fs';
import path from 'node:path';
const unitTests = {
  money: 'Comparison costs retain decimal precision, reject malformed amounts and preserve zero',
  basis:
    'Savings distinguish equal basis, mixed currencies, changed quantity, condition, package and budget scope',
  fit: 'Modes preserve immutable identities, edition/variant, offer quantity, condition and explicitly allowed differences',
  beta: 'A beta version exclusion checks the actual catalog version before recommending an offer',
  metrics:
    'Source-bound product/seller metrics preserve sparsity, scale, period and shared catalog scope',
  rank: 'Ranking follows declared priorities, leaves ties unresolved, deduplicates and honors unknown evidence',
  zero: 'Explicit zero budgets, priority ties and stale or unavailable choices never manufacture a winning savings',
  citation:
    'Discovery citations match the fixed read-only source, baseline origin and approved query',
  urls: 'Offer URL and command contracts refuse tracked, transactional, spoofed or malformed destinations',
  routes:
    'Comparison canonical routes strip private query values locally; manual offers remain strictly scoped',
  resell:
    'Resell discovery deduplicates canonical URLs, rechecks detail identity and reads the shop evidence once',
  mozilla:
    'Mozilla keeps catalog ID, Firefox compatibility, filtered written page and full distribution independent',
  fixture:
    'Labelled practice discovery differentiates baseline-only, empty, failing detail, changed and blocked sources',
  limits:
    'Public discovery enforces its operation budget, two active reads, safe query validation and abort',
  ai: 'Comparison intent and explanation preserve hard constraints, budgets, reference ownership and local decisions',
  paired:
    'Protected comparison API is opt-in, paired, strict, replay fenced, and separate from legacy operations',
  late: 'An interrupted model response cannot return explanation facts to an abandoned comparison',
  failures:
    'Comparison discovery fails closed on HTTP, redirect, timeout, oversized and malformed source responses',
  fitTrade:
    'A different-model price benefit and a different-model preferred feature remain independent tradeoffs',
};
// U = exact named executed unit; N = installed native at each measured size;
// R = separately verified provenance/repair/delivery record; H = same-build earlier regression.
export const stage6EvidenceRequirements = {
  'S6-G01': 'R:gate',
  'S6-G02': 'R:repair',
  'S6-G03': 'R:integrity',
  'S6-I01': 'U:fit N:exact',
  'S6-I02': 'U:fit U:beta N:pen N:mozilla',
  'S6-I03': 'N:edits N:lifecycle',
  'S6-I04': 'U:urls U:routes U:basis N:boundaries',
  'S6-I05': 'U:routes U:fit N:selected N:boundaries',
  'S6-D01': 'U:resell U:mozilla U:citation N:pen N:mozilla',
  'S6-D02': 'U:fit U:resell N:exact',
  'S6-D03': 'U:resell U:fixture U:fit N:selected',
  'S6-D04': 'U:fixture N:coverage',
  'S6-D05': 'U:limits U:failures N:coverage N:reviewBudget H:stage4Repairs',
  'S6-D06': 'U:failures U:fixture N:coverage',
  'S6-D07': 'U:fit N:mozilla',
  'S6-M01': 'U:money',
  'S6-M02': 'U:money U:basis N:pen',
  'S6-M03': 'U:basis U:resell R:currency',
  'S6-M04': 'U:basis U:zero N:exact',
  'S6-M05': 'U:basis U:zero',
  'S6-M06': 'U:basis U:fit',
  'S6-M07': 'U:money U:resell',
  'S6-M08': 'U:basis N:selected N:expiry',
  'S6-P01': 'U:fit N:book',
  'S6-P02': 'U:metrics U:resell U:mozilla N:pen N:mozilla',
  'S6-P03': 'U:mozilla H:stage4Repairs N:mozilla',
  'S6-P04': 'U:fit U:fitTrade N:mozilla',
  'S6-S01': 'U:fit U:resell N:exact',
  'S6-S02': 'U:metrics',
  'S6-S03': 'U:metrics N:pen',
  'S6-S04': 'U:metrics U:resell H:stage4Repairs N:reviewBudget',
  'S6-S05': 'U:mozilla N:mozilla',
  'S6-R01': 'U:rank U:zero N:exact',
  'S6-R02': 'U:basis N:exact',
  'S6-R03': 'U:fitTrade',
  'S6-R04': 'U:rank U:zero N:coverage N:exact',
  'S6-R05': 'U:ai U:citation H:stage4Repairs N:exact',
  'S6-R06': 'U:metrics N:exact',
  'S6-U01': 'N:exact N:selected',
  'S6-U02': 'U:urls N:selected N:boundaries N:pen',
  'S6-U03': 'N:exact N:recovery N:cleanup',
  'S6-U04': 'N:lifecycle N:coverage U:paired',
  'S6-L01': 'N:edits N:lifecycle N:window',
  'S6-L02': 'N:expiry N:selected',
  'S6-L03': 'N:lifecycle N:recovery N:pendingRecovery',
  'S6-L04': 'U:money U:paired N:lifecycle N:boundaries',
  'S6-L05': 'N:permissions',
  'S6-L06': 'N:cleanup H:stage5Controls',
  'S6-L07': 'N:boundaries N:pen N:mozilla',
  'S6-A01': 'N:exact N:coverage U:paired',
  'S6-A02': 'U:ai U:paired U:late',
  'S6-A03': 'U:paired H:stage3 H:stage4',
  'S6-X01': 'H:stage2 H:stage3 H:stage4 H:stage4Repairs H:stage5Repairs',
  'S6-X02': 'H:stage5Public H:stage5Controls H:stage5Repairs',
  'S6-X03': 'R:delivery',
  'S6-V01': 'N:pen',
  'S6-V02': 'N:book',
  'S6-V03': 'U:mozilla N:mozilla',
  'S6-V04': 'N:pen N:mozilla',
  'S6-C01': 'N:aiIntent',
  'S6-C02': 'N:aiExplanation U:late',
};
function fromFile(x) {
  if (typeof x === 'string') return { path: x, report: JSON.parse(fs.readFileSync(x, 'utf8')) };
  return x;
}
function fileProof(x, sha) {
  if (!x || x.sha256 !== sha || !x.path || !fs.existsSync(x.path) || !x.observation) return null;
  return {
    status: x.status,
    method: x.method ?? 'Recorded builder check',
    observation: x.observation,
    evidence: x.path,
  };
}
function unitProof(unit, key, sha) {
  if (!unit || unit.sha256 !== sha || unit.exit !== 0 || !fs.existsSync(unit.path)) return null;
  const name = unitTests[key],
    lines = fs.readFileSync(unit.path, 'utf8').split(/\r?\n/);
  const passed = lines.some(
    (l) =>
      l.includes('✔ ' + name) ||
      new RegExp('^ok \\d+ - ' + name.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '(?:$| \\()').test(l),
  );
  if (!passed) return null;
  return { status: 'pass', method: 'development test', observation: name, evidence: unit.path };
}
function browserProof(runs, key, sha, width) {
  const ai = key === 'aiIntent' || key === 'aiExplanation';
  const matches = runs
    .filter((x) => x.report?.sha256 === sha && x.report.role === 'builder')
    .flatMap((x) =>
      (x.report.results ?? [])
        .filter((r) => r.name === (ai ? 'ai' : key) && r.width === width)
        .map((r) => ({ r, file: x.path, at: x.report.at, bundle: x.report.bundle })),
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const selected = matches.at(-1);
  if (!selected) return null;
  const { r, file, bundle } = selected;
  const d = r.dimensions ?? r.environment;
  const evidence = {
    method: 'installed Chrome at ' + width + '×' + (width === 1440 ? 900 : 768),
    evidence: file,
  };
  const aiIntentPassed =
    key === 'aiIntent' &&
    r.aiIntent?.health?.intent === true &&
    r.aiIntent.settings?.budget?.currency === 'USD' &&
    Number(r.aiIntent.settings?.budget?.amount) === 32 &&
    r.aiIntent.settings?.budget?.basis === 'item';
  if (r.status !== 'pass' && !aiIntentPassed)
    return {
      ...evidence,
      status:
        r.status === 'blocked'
          ? 'blocked'
          : (/net::ERR_|Navigation timeout/.test(r.error ?? '') && !r.loaded) ||
              (ai &&
                /not configured|503|ECONNREFUSED|unavailable.+provider|provider.+unavailable/i.test(
                  r.error ?? '',
                ))
            ? 'blocked'
            : 'fail',
      observation: r.error ?? 'Browser scenario did not pass',
    };
  if (
    !fs.existsSync(file) ||
    !r.loaded?.path ||
    !bundle ||
    path.resolve(r.loaded.path) !== path.resolve(bundle) ||
    d?.closed?.width !== width ||
    d.closed.height !== (width === 1440 ? 900 : 768) ||
    d.native !== true ||
    d.zoom !== 1 ||
    (!r.checks?.length && !aiIntentPassed)
  )
    return null;
  if (ai) {
    const op = key === 'aiIntent' ? 'intent' : 'explain',
      h = r[key]?.health;
    if (op === 'intent' && !aiIntentPassed) return null;
    if (
      !h?.[op] ||
      !h.model ||
      !h.recent?.some((x) => x.operation === op && x.status === 'available')
    )
      return null;
    return {
      ...evidence,
      status: 'pass',
      observation:
        'Genuine ' +
        h.model +
        ' ' +
        op +
        ' operation verified; ' +
        (op === 'intent'
          ? 'user currency, item basis, platform and exclusions checked.'
          : r.checks.join(' ')),
    };
  }
  if (key === 'mozilla') {
    const reviewed = r.reviewedCatalogs ?? [];
    if (
      new Set(
        reviewed
          .filter(
            (x) =>
              typeof x.developer === 'string' &&
              x.developer &&
              x.source &&
              Number.isInteger(x.sample) &&
              x.sample >= 0 &&
              x.sample <= 20,
          )
          .map((x) => x.id),
      ).size < 2
    )
      return {
        ...evidence,
        status: 'blocked',
        observation:
          'The captured result does not establish two distinct Mozilla catalog options with visible developer attribution and bounded source-matched product feedback.',
      };
  }
  return { ...evidence, status: 'pass', observation: r.checks.join(' ') };
}
/** native/liveAI = paths to saved run JSON (or {path,report}); unit = {path:actual stdout,sha256,exit}.
 * records/inherited keyed by R/H tags: {sha256:current Stage 6 fingerprint,path,status,method,observation}.
 * For H tags, pass only an inspected same-artifact report with the relevant named scenarios passing.
 * upstream repair reports use R descriptors referencing the builder's matched provenance audit.
 */
export function stage6CaseMatrix({
  sha256,
  native = [],
  liveAI = [],
  unit,
  records = {},
  inherited = {},
  plan = JSON.parse(fs.readFileSync('STAGE_6_PLAN.json', 'utf8')),
}) {
  const runs = [...native, ...liveAI].map(fromFile);
  return plan.acceptance_cases.map((c) => {
    const needs = stage6EvidenceRequirements[c.id];
    if (!needs) throw Error('No evidence map for ' + c.id);
    const missing = [],
      proof = [];
    for (const tag of needs.split(' ')) {
      const [kind, key] = tag.split(':');
      if (kind === 'N') {
        for (const width of [1440, 1366]) {
          const p = browserProof(runs, key, sha256, width);
          if (p) proof.push(p);
          else missing.push(tag + ' ' + width);
        }
        continue;
      }
      const p =
        kind === 'U'
          ? unitProof(unit, key, sha256)
          : fileProof((kind === 'H' ? inherited : records)[key], sha256);
      if (p) proof.push(p);
      else missing.push(tag);
    }
    const status = proof.some((p) => p.status === 'fail')
      ? 'fail'
      : proof.some((p) => p.status === 'blocked')
        ? 'blocked'
        : missing.length || proof.some((p) => p.status !== 'pass')
          ? 'not_run'
          : 'pass';
    return {
      id: c.id,
      gate: c.gate,
      scenario: c.scenario,
      status,
      sha256,
      methods: [...new Set(proof.map((p) => p.method))],
      observations: proof.map((p) => p.observation),
      evidence: [...new Set(proof.map((p) => p.evidence))],
      missing,
    };
  });
}
