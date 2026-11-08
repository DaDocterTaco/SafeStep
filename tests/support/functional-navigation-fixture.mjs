import { once } from 'node:events';
import { makeApi } from '../../apps/api/dist/app.js';
import { GeminiService, newPairToken } from '../../apps/api/dist/gemini.js';

// Test-only proposals. Select only controls supplied by the installed extension.
export async function startFixture(spec, r, apiHost, threatService) {
  const token = newPairToken();
  const asResult = (x) => ({ text: JSON.stringify(x), tokens: 0 });
  const intentFor = (input) => {
    const g = input.goal,
      span = (text) => ({ text, start: g.indexOf(text), end: g.indexOf(text) + text.length });
    let subjects = [span(g)],
      constraints = [];
    if (spec.title) {
      const topic = 'the atmosphere of ' + (spec.name.startsWith('mars') ? 'Mars' : 'Earth');
      subjects = [span(topic)];
      constraints = [span('Wikipedia article')];
    }
    if (spec.method) {
      subjects = [span('Array.' + spec.method), span('Examples')];
      constraints = [span('JavaScript'), span('MDN')];
    }
    return {
      action: spec.method || spec.heading ? 'find_section' : 'find_document',
      subjects,
      constraints,
      excluded: [],
      question: '',
      choices: [],
    };
  };
  const propose = async (input) => {
    if (input.kind === 'intent') return asResult(intentFor(input));
    const { controls, headings, path, complete, limited } = input.snapshot;
    const choice = (r) => ({
      kind: 'next_candidate',
      ref: r.ref,
      action: r.action,
      citations: [r.ref],
    });
    const norm = (t) => t?.toLowerCase().replace(/[^a-z0-9]/g, '');
    const first = (...matches) => matches.find(Boolean);
    let c;
    if (spec.title) {
      const eq = (v) => norm(v) === norm(spec.title);
      c = first(
        complete && headings.find((x) => eq(x.label)),
        controls.find((x) => eq(x.label)),
        controls.find((x) => x.role === 'search'),
        controls.find((x) => /open wikipedia search/i.test(x.label)),
      );
    } else if (spec.method) {
      const inDoc = path.includes('/Array/' + spec.method);
      c = first(
        inDoc && headings.find((x) => norm(x.label) === 'examples'),
        controls.find((x) => x.path?.endsWith('/Array/' + spec.method)),
        controls.find(
          (x) => norm(x.label) === 'examples' && x.path?.includes('/Array/' + spec.method + '#'),
        ),
      );
    } else if (spec.heading) {
      c = first(
        headings.find((x) => norm(x.label).endsWith(norm(spec.heading))),
        controls.find((x) => norm(x.label).endsWith(norm(spec.heading))),
        controls.find((x) => x.path?.includes(spec.endHash ?? spec.endPath)),
      );
    } else if (spec.profile) {
      c = controls.find((x) =>
        spec.profile === 'vlc_windows_x64'
          ? x.path?.includes('download-windows')
          : x.path?.includes('download.html'),
      );
    }
    r.fixtureObservations ??= [];
    r.fixtureObservations.push({
      path,
      complete,
      role: c?.role ?? null,
      chosen: c?.label ?? null,
      limited,
      controlCount: controls.length,
      headingCount: headings.length,
      ...(spec.name.startsWith('transfer')
        ? { publicLinks: controls.map((x) => ({ label: x.label, path: x.path })) }
        : {}),
    });
    if (complete && c && c.role === 'heading')
      return asResult({ kind: 'completion_candidate', citations: [c.ref] });
    if (c) return asResult(choice(c));
    return asResult({ kind: 'cannot_continue', reason: 'missing_target' });
  };
  const route = async () =>
    asResult({
      kind: 'routed',
      feature: spec.profile
        ? 'download_guidance'
        : spec.auto
          ? 'automatic_navigation'
          : 'visual_guidance',
      slots: spec.profile ? { profile: spec.profile } : { subjectRef: null },
      reason: 'Navigation fixture decision.',
    });
  const service = new GeminiService(
    { GEMINI_API_KEY: 'local-fixture-only', GEMINI_MODEL: 'gemini-fixture-only' },
    token,
    async () => asResult({}),
    8000,
    undefined,
    propose,
    undefined,
    route,
  );
  const server = makeApi(undefined, service,undefined,threatService);
  server.listen(4317, apiHost);
  await once(server, 'listening');
  return { server, token };
}
